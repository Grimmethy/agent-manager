'use strict';

// Live checkout pipeline drain (FF-3/3c): after a fast-forward of wok's live checkout that touched code the pipeline loads, restart the pipeline once every
// worker lane is idle, using the existing machine pause (src/worker-switch.js, scope node, docs/agents/lanes.md 'Pausing a machine') instead of a new drain mechanism.
//
// requestPipelineRestart writes instances/live-sync-pending.json (newSha, since, the changed paths); drainStep is the check run by the caller's event (the fast-forward, then the
// watchdog tick WHILE that record exists; with no record it returns 'none' at once, so the idle cost is nothing). One step:
//   none      no record.
//   stuck     past AGENT_MANAGER_LIVE_SYNC_DRAIN_MAX_MIN (default 30) since the record: nothing is cleared or touched, one urgent alert, the record stays.
//   blocked   a _pause-node marker with another source holds the machine: it is never overwritten or cleared; one summary notice; retried when the marker clears.
//   waiting   our own marker (source wok, reason naming the new sha, a 5 minute expiry refreshed on every step) is set and a lane is still working or a draft is in progress.
//   failed    every lane is idle but the restart command failed: one urgent alert, the record stays for the next step.
//   restarted every lane is idle or disabled and no draft is in progress: the restart ran (scripts/stop.sh --keep-dashboard --keep-plugins, then scripts/launch.sh, detached so the
//             stop cannot kill the process that runs them), the marker is cleared only if its source is still wok, the record is deleted and one summary notice is sent.
// launch.sh alone skips anything already running, so it cannot restart the pipeline; the stop comes first. Reviewers, the apply loop and the watchdog keep running during the drain.
// Everything with side effects is injectable (pauses, lanes, drafts, run, notify, fs, now). No timer. CLI: node src/live-checkout-drain.js <repo-dir> [--pipeline-dir DIR]

const nodeFs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const workerSwitch = require('./worker-switch.js');
const { notify: defaultNotify } = require('./notify.js');
const { readLaneStatuses, draftingHasTask } = require('./node-code-drain.js');

const PENDING_FILE = 'live-sync-pending.json';
const OWN_SOURCE = 'wok';
const PAUSE_TTL_MIN = 5;
const DEFAULT_MAX_MIN = 30;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const MAX_PATHS = 20;

const pendingPath = (pipelineDir) => path.join(pipelineDir, 'instances', PENDING_FILE);

function toMs(now) {
  const value = typeof now === 'function' ? now() : now;
  const n = Number(value == null ? Date.now() : value);
  return Number.isFinite(n) ? n : Date.now();
}

function limitMinutes(env) {
  const raw = env && env.AGENT_MANAGER_LIVE_SYNC_DRAIN_MAX_MIN;
  const n = raw == null || String(raw).trim() === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_MIN;
}

function readRecord(pipelineDir, fs) {
  try {
    const record = JSON.parse(fs.readFileSync(pendingPath(pipelineDir), 'utf8'));
    if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
    if (typeof record.newSha !== 'string' || !SHA_PATTERN.test(record.newSha)) return null;
    if (typeof record.since !== 'string' || !Number.isFinite(Date.parse(record.since))) return null;
    return record;
  } catch (e) {
    return null;
  }
}

function writeRecord(pipelineDir, record, fs) {
  const file = pendingPath(pipelineDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(record, null, 2)}\n`);
  fs.renameSync(`${file}.tmp`, file);
}

// Records that the pipeline must restart for newSha. A record already there keeps its since and its alert flags and takes the new sha and the union of the paths.
// Returns the record, or null when the sha is not 40 lowercase hex or the file cannot be written. Never throws.
function requestPipelineRestart({ pipelineDir, newSha, paths = [], now = Date.now, fs = nodeFs } = {}) {
  if (!pipelineDir || typeof newSha !== 'string' || !SHA_PATTERN.test(newSha)) return null;
  const existing = readRecord(pipelineDir, fs);
  const list = [...new Set([...(existing ? existing.paths || [] : []), ...(Array.isArray(paths) ? paths.filter((p) => typeof p === 'string') : [])])].slice(0, MAX_PATHS);
  const record = existing
    ? { ...existing, newSha, paths: list }
    : { newSha, since: new Date(toMs(now)).toISOString(), paths: list, alerted: false, stuckAlerted: false, failedAlerted: false };
  try {
    writeRecord(pipelineDir, record, fs);
    return record;
  } catch (e) {
    return null;
  }
}

// The real restart: one detached bash so the stop cannot take down the process that asked for it. Returns {ok, error?}.
function defaultRun({ repoDir }) {
  try {
    const child = childProcess.spawn('bash', ['-c', 'scripts/stop.sh --keep-dashboard --keep-plugins; scripts/launch.sh'], { cwd: repoDir, detached: true, stdio: 'ignore' });
    child.unref();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

// One drain step (see the header). Never throws; notices are fire-and-forget and the once-only guarantee is the record flags.
function drainStep({ pipelineDir, repoDir, env = process.env, now = Date.now, pauses = workerSwitch, lanes, drafts, run = defaultRun, notify = defaultNotify, fs = nodeFs } = {}) {
  if (!pipelineDir) return 'none';
  const record = readRecord(pipelineDir, fs);
  if (!record) return 'none';
  const nowMs = toMs(now);
  const sha8 = record.newSha.slice(0, 8);
  const because = (record.paths || []).slice(0, 5).join(', ') || 'a code change';
  const send = (level, key, title, text) => {
    try {
      const result = notify({ level, key, title, text }, { env, now: () => nowMs });
      if (result && typeof result.then === 'function') result.then(null, () => {});
    } catch (e) { /* the notice is best effort */ }
  };
  const save = (fields) => { try { writeRecord(pipelineDir, { ...record, ...fields }, fs); } catch (e) { /* the flag may repeat the notice */ } };

  if (nowMs - Date.parse(record.since) > limitMinutes(env) * 60000) {
    if (!record.stuckAlerted) {
      send('urgent', `live-sync-stuck:${sha8}`, 'Pipeline restart stuck', `The pipeline restart for ${sha8} (${because}) has not drained within the limit. Nothing was cleared and no lane was stopped; the pause lapses on its own.`);
      save({ stuckAlerted: true });
    }
    return 'stuck';
  }
  const current = pauses.readPause('node', env, nowMs);
  if (current && current.source !== OWN_SOURCE) {
    if (!record.alerted) {
      send('summary', `live-sync-blocked:${sha8}`, 'Pipeline restart waits for a pause', `A ${current.source || 'foreign'} pause holds this machine. The pipeline restart for ${sha8} waits until it clears. Nothing was changed.`);
      save({ alerted: true });
    }
    return 'blocked';
  }
  pauses.setPause('node', { source: OWN_SOURCE, reason: `live-sync restart pending for ${sha8}`, ttlMin: PAUSE_TTL_MIN }, env, nowMs);
  const statuses = lanes ? lanes() : readLaneStatuses(pipelineDir);
  const draftBusy = drafts ? drafts() : draftingHasTask(pipelineDir);
  if (!(statuses.every((status) => status === 'idle' || status === 'disabled') && !draftBusy)) return 'waiting';

  let result;
  try {
    result = run({ repoDir, pipelineDir, env, newSha: record.newSha });
  } catch (e) {
    result = { ok: false, error: (e && e.message) || String(e) };
  }
  if (!result || result.ok !== true) {
    if (!record.failedAlerted) {
      send('urgent', `live-sync-failed:${sha8}`, 'Pipeline restart failed', `The pipeline restart for ${sha8} could not be started: ${String((result && result.error) || 'unknown error').slice(0, 200)}. The record stays for the next try.`);
      save({ failedAlerted: true });
    }
    return 'failed';
  }
  const after = pauses.readPause('node', env, nowMs);
  if (after && after.source === OWN_SOURCE) pauses.clearPause('node', env);
  try { fs.unlinkSync(pendingPath(pipelineDir)); } catch (e) { /* a leftover record is judged again */ }
  send('summary', `live-sync-restarted:${sha8}`, 'Pipeline restarted', `The pipeline was restarted for ${sha8} (${because}) once every lane was idle.`);
  return 'restarted';
}

// Injectable entry point (FF-3/3c contract). One re-entrant step, no timer: records the pending restart for sha (when given), then runs drainStep with the injected deps.
//   clock           () => ms (or a number); replaces Date.now. Drives the marker expiresAt refresh and the AGENT_MANAGER_LIVE_SYNC_DRAIN_MAX_MIN (default 30) limit.
//   heartbeatReader () => array of lane statuses, or { statuses|lanes: [...], draftBusy?: boolean }. Replaces the lane status read.
//   runner          ({repoDir, pipelineDir, env, newSha}) => {ok, error?}. Replaces the detached stop.sh + launch.sh spawn.
//   logger          { info|log(msg) } optional; receives the step status.
//   sha             40 hex sha of the new HEAD. paths: { pipelineDir, repoDir, changed? } (an array is taken as the changed paths).
// Returns the drainStep status: none | stuck | blocked | waiting | failed | restarted.
function drain({ clock, heartbeatReader, runner, logger, sha, paths, env = process.env, notify, fs } = {}) {
  const dirs = Array.isArray(paths) ? { changed: paths } : (paths || {});
  const pipelineDir = dirs.pipelineDir || dirs.repoDir;
  const repoDir = dirs.repoDir || pipelineDir;
  const extra = {};
  if (notify) extra.notify = notify;
  if (fs) extra.fs = fs;
  if (clock != null) extra.now = clock;
  if (runner) extra.run = runner;
  if (heartbeatReader) {
    const read = () => {
      const value = heartbeatReader();
      return Array.isArray(value) ? { statuses: value, draftBusy: false } : { statuses: (value && (value.statuses || value.lanes)) || [], draftBusy: Boolean(value && value.draftBusy) };
    };
    extra.lanes = () => read().statuses;
    extra.drafts = () => read().draftBusy;
  }
  if (typeof sha === 'string' && pipelineDir) {
    requestPipelineRestart({ pipelineDir, newSha: sha, paths: dirs.changed || [], ...(clock != null ? { now: clock } : {}), ...(fs ? { fs } : {}) });
  }
  const status = drainStep({ pipelineDir, repoDir, env, ...extra });
  try {
    const log = logger && (logger.info || logger.log);
    if (log) log.call(logger, `live-checkout-drain: ${status}`);
  } catch (e) { /* logging is best effort */ }
  return status;
}

module.exports = { requestPipelineRestart, drainStep, drain, pendingPath, PENDING_FILE, OWN_SOURCE, PAUSE_TTL_MIN, DEFAULT_MAX_MIN };

if (require.main === module) {
  const args = process.argv.slice(2);
  const repoDir = args.find((a) => !a.startsWith('--')) || process.cwd();
  const flag = args.indexOf('--pipeline-dir');
  const pipelineDir = flag >= 0 ? args[flag + 1] : repoDir;
  process.stdout.write(`${drainStep({ pipelineDir, repoDir })}\n`);
}
