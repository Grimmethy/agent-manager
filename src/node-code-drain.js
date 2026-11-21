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
const childProcess = require('child_process');
const { PENDING_FILE, AUDIT_FILE } = require('./node-code-restart.js');

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
  // A record whose restart was already attempted (finishDrain) is no longer a drain: it must not re-set the pause.
  if (!record || record.restartAttempted === true) return 'none';

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

const DEFAULT_RESTART_UNITS = ['am-node-pull.service'];
const RESTART_MODES = ['on', 'dry-run'];

function defaultRun(cmd, args, opts) {
  return childProcess.execFileSync(cmd, args, { encoding: 'utf8', timeout: 30000, ...opts });
}

// Units from AGENT_MANAGER_CODE_RESTART_UNITS (comma separated). Unset means the default unit; an empty value means none.
function restartUnits(env) {
  if (env.AGENT_MANAGER_CODE_RESTART_UNITS == null) return DEFAULT_RESTART_UNITS.slice();
  return String(env.AGENT_MANAGER_CODE_RESTART_UNITS).split(',').map((u) => u.trim()).filter(Boolean);
}

// Appends one JSON line to instances/code-restart.log. Best effort: an audit failure never changes the outcome.
function auditLine(pipelineDir, line) {
  try {
    fs.appendFileSync(path.join(pipelineDir, 'instances', AUDIT_FILE), `${JSON.stringify(line)}\n`);
  } catch (e) { /* best effort */ }
}

// Runs the restart for a record that drainStep reported ready. Units run first (systemctl --user restart), then launch.sh.
// Returns 'off' (AGENT_MANAGER_CODE_PULL is not on or dry-run), 'none' (no record, or already attempted), 'dry-run',
// 'restarted' or 'failed'. The record is marked restartAttempted before any command, so a later heartbeat never repeats it.
// On failure the record stays, the pause is still cleared (the node is not left paused) and ONE notice is sent.
function finishDrain({ pipelineDir, env = process.env, run = defaultRun, notify = defaultNotify, now = Date.now, pauses = workerSwitch } = {}) {
  if (!pipelineDir) return 'none';
  const mode = String(env.AGENT_MANAGER_CODE_PULL == null ? 'off' : env.AGENT_MANAGER_CODE_PULL).trim();
  if (!RESTART_MODES.includes(mode)) return 'off';
  const file = path.join(pipelineDir, 'instances', PENDING_FILE);
  const record = readRecord(file);
  if (!record || record.restartAttempted === true) return 'none';

  const nowMs = toMs(now);
  const at = new Date(nowMs).toISOString();
  const sha8 = record.newSha.slice(0, 8);

  const steps = [];
  if (record.units === true) {
    for (const unit of restartUnits(env)) {
      steps.push({ name: `restart ${unit}`, cmd: 'systemctl', args: ['--user', 'restart', unit] });
    }
  }
  if (record.pipeline === true) {
    const root = env.AGENT_MANAGER_REPO_ROOT;
    if (root) steps.push({ name: 'launch.sh', cmd: path.join(root, 'scripts', 'launch.sh'), args: [], cwd: root });
    else steps.push({ name: 'launch.sh', cmd: null, args: [], error: 'AGENT_MANAGER_REPO_ROOT is not set' });
  }

  if (mode === 'dry-run') {
    for (const step of steps) {
      auditLine(pipelineDir, { at, newSha: record.newSha, step: step.name, result: 'dry-run', command: step.cmd ? [step.cmd, ...step.args].join(' ') : null, error: step.error || null });
    }
    return 'dry-run';
  }

  writeRecord(file, { ...record, restartAttempted: true, restartAt: at });
  let failed = 0;
  for (const step of steps) {
    let ok = true;
    let error = step.error || null;
    if (!step.error) {
      try {
        run(step.cmd, step.args, { cwd: step.cwd });
      } catch (e) {
        ok = false;
        error = e.message;
      }
    } else {
      ok = false;
    }
    if (!ok) failed += 1;
    auditLine(pipelineDir, { at, newSha: record.newSha, step: step.name, ok, error });
  }

  const current = pauses.readPause('node', env, nowMs);
  if (current && current.source === OWN_SOURCE) pauses.clearPause('node', env);

  if (failed > 0) {
    const result = notify({
      level: 'urgent',
      key: `code-restart-failed:${sha8}`,
      title: 'Node code restart failed',
      text: `${failed} of ${steps.length} restart step(s) for ${sha8} failed; see instances/code-restart.log. The code-sync pause was cleared so the node is not left paused.`,
    }, { env, now: () => nowMs });
    if (result && typeof result.then === 'function') result.then(null, () => {});
    return 'failed';
  }
  try {
    fs.unlinkSync(file);
  } catch (e) { /* already gone */ }
  return 'restarted';
}

module.exports = { drainStep, finishDrain, readLaneStatuses, draftingHasTask, DRAIN_PAUSE_TTL_MIN, DEFAULT_MAX_MIN };
