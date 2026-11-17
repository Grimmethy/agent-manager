'use strict';

// Node code drain gate (FF-9/9b). A passive step the heartbeat calls while instances/code-restart-pending.json exists.
// It holds this node through its own pause marker (source code-sync, a short ttl refreshed on every call), then reports
// ready once every lane heartbeat is idle or disabled and no drafting folder holds a task. It never kills a lane, never
// restarts anything, and never touches a pause owned by someone else. There is no timer: the heartbeat is the trigger and
// the wait is bounded by AGENT_MANAGER_CODE_DRAIN_MAX_MIN (default 30) measured from the record's since.

const fs = require('fs');
const path = require('path');
const workerSwitch = require('./worker-switch.js');
const notifyModule = require('./notify.js');
const { PENDING_FILE } = require('./node-code-restart.js');

const defaultNotify = notifyModule.notify || notifyModule;

const DRAIN_PAUSE_TTL_MIN = 5;
const DEFAULT_MAX_MIN = 30;
const OWN_SOURCE = 'code-sync';
const SHA_PATTERN = /^[0-9a-f]{40}$/;

function toMs(now) {
  const value = typeof now === 'function' ? now() : now;
  const n = Number(value == null ? Date.now() : value);
  return Number.isFinite(n) ? n : Date.now();
}

function limitMinutes(env) {
  const raw = env.AGENT_MANAGER_CODE_DRAIN_MAX_MIN;
  const n = raw == null || String(raw).trim() === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_MIN;
}

// The pending record, or null when it is absent or malformed. A record without a valid newSha and since is not acted on.
function readRecord(file) {
  let record;
  try {
    record = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  if (typeof record.newSha !== 'string' || !SHA_PATTERN.test(record.newSha)) return null;
  if (typeof record.since !== 'string' || !Number.isFinite(Date.parse(record.since))) return null;
  return record;
}

// Writes the whole record back atomically (temp file, then rename) so no existing field is lost.
function writeRecord(file, record) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

// Default lane reader: the status of every heartbeat JSON under instances/. Files without a status field are not heartbeats
// and are skipped. An unreadable heartbeat reports null, which counts as not idle (conservative).
function readLaneStatuses(pipelineDir) {
  const dir = path.join(pipelineDir, 'instances');
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    return [];
  }
  const statuses = [];
  for (const name of names) {
    if (!name.endsWith('.json') || name === PENDING_FILE) continue;
    let heartbeat;
    try {
      heartbeat = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch (e) {
      statuses.push(null);
      continue;
    }
    if (heartbeat && typeof heartbeat === 'object' && typeof heartbeat.status === 'string') statuses.push(heartbeat.status);
  }
  return statuses;
}

// Default drafts reader (ASSUMPTION, verify against the drafting code): true when any folder under <pipelineDir>/drafting holds a
// non-hidden entry. A folder that cannot be read counts as busy (conservative).
function draftingHasTask(pipelineDir) {
  const root = path.join(pipelineDir, 'drafting');
  let folders;
  try {
    folders = fs.readdirSync(root, { withFileTypes: true });
  } catch (e) {
    return false;
  }
  return folders.some((entry) => {
    if (!entry.isDirectory()) return false;
    try {
      return fs.readdirSync(path.join(root, entry.name)).some((name) => !name.startsWith('.'));
    } catch (e) {
      return true;
    }
  });
}

// One drain step. Returns none (no pending record), blocked (a foreign node pause holds the node; nothing written to the pause),
// stuck (past the limit; nothing cleared, no lane touched), ready (every lane idle or disabled, no draft), or waiting.
// Notices are fire-and-forget; the once-only guarantee comes from the record flags alerted and stuckAlerted.
function drainStep({ pipelineDir, env = process.env, now = Date.now, pauses = workerSwitch, lanes, drafts, notify = defaultNotify } = {}) {
  if (!pipelineDir) return 'none';
  const file = path.join(pipelineDir, 'instances', PENDING_FILE);
  const record = readRecord(file);
  if (!record) return 'none';

  const nowMs = toMs(now);
  const sha8 = record.newSha.slice(0, 8);
  const send = (key, title, text) => {
    const result = notify({ level: 'urgent', key, title, text }, { env, now: () => nowMs });
    if (result && typeof result.then === 'function') result.then(null, () => {});
  };

  // The limit is checked first, so a node that never drains stops being held by the code-sync pause.
  const sinceMs = Date.parse(record.since);
  if (nowMs - sinceMs > limitMinutes(env) * 60 * 1000) {
    if (!record.stuckAlerted) {
      send(`code-restart-stuck:${sha8}`, 'Node code restart stuck', `The restart for ${sha8} has not drained within the limit. No lane was stopped; the code-sync pause lapses on its own.`);
      writeRecord(file, { ...record, stuckAlerted: true });
    }
    return 'stuck';
  }

  const current = pauses.readPause('node', env, nowMs);
  if (current && current.source !== OWN_SOURCE) {
    if (!record.alerted) {
      send(`code-restart-blocked:${sha8}`, 'Node code restart blocked', `A ${current.source || 'foreign'} pause holds this node. The restart for ${sha8} waits for it to clear. Nothing was changed.`);
      writeRecord(file, { ...record, alerted: true });
    }
    return 'blocked';
  }

  pauses.setPause('node', { source: OWN_SOURCE, reason: `code-restart pending for ${sha8}`, ttlMin: DRAIN_PAUSE_TTL_MIN }, env, nowMs);

  const statuses = lanes ? lanes() : readLaneStatuses(pipelineDir);
  const draftBusy = drafts ? drafts() : draftingHasTask(pipelineDir);
  const allIdle = statuses.every((status) => status === 'idle' || status === 'disabled');
  return allIdle && !draftBusy ? 'ready' : 'waiting';
}

module.exports = { drainStep, readLaneStatuses, draftingHasTask, DRAIN_PAUSE_TTL_MIN, DEFAULT_MAX_MIN };
