'use strict';

// Operator on/off switch for one worker lane (Workers tab toggle; docs/agents/lanes.md "Switching a worker off").
//
// State is a marker file per worker in a GLOBAL state directory, so it survives pipeline restarts and a change of active project. A switched-off worker
// keeps running: scripts/local-worker.sh checks the marker at the top of every tick, writes a heartbeat with status disabled, and claims or resumes
// nothing. A task already in flight finishes first (the check is once per tick). Only worker lanes (worker-<letters or digits>) have a switch; the id is
// validated so it can never name a path outside the directory.
//
//   AGENT_MANAGER_DISABLED_WORKERS_DIR   override of the directory (tests); default $HOME/.local/state/agent-manager/disabled-workers
//
// CLI (the bash worker and the dashboard shell out to it so the rule lives once):
//   node src/worker-switch.js is-disabled <id>   exit 0 when switched off, 1 otherwise (also for an invalid id); prints nothing
//   node src/worker-switch.js disable <id> | enable <id>
//   node src/worker-switch.js list               JSON array of switched-off ids
//   node src/worker-switch.js dir                the marker directory
//   node src/worker-switch.js pause <node|global> [--reason <text>] [--source <text>] [--ttl-min <n>]
//   node src/worker-switch.js resume <node|global>
//   node src/worker-switch.js pause-status       JSON {node, global, workers}
//
// Machine pauses (multi-node plan, 2026-11-11): two more marker files in the same directory, `_pause-node` (this machine claims nothing) and
// `_pause-global` (the whole system is paused; other machines receive it through their heartbeat reply). The leading underscore means they can never be a
// worker id, so listDisabled() and every existing caller are unaffected. Each holds {scope, reason, source, setAt, expiresAt}. isDisabled(id) is true when
// the worker's own marker exists OR either pause is active, so scripts/local-worker.sh needs no change. A pause with an expiresAt in the past, a missing
// file and an unreadable or malformed file all count as NOT paused: the flag expires by itself and a broken switch must never stall the pipeline.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeJsonAtomicSync } = require('./atomic-write.js');

const WORKER_ID_RE = /^worker-[a-z0-9]+$/;
const PAUSE_SCOPES = ['node', 'global'];

function switchDir(env = process.env) {
  const override = String(env.AGENT_MANAGER_DISABLED_WORKERS_DIR || '').trim();
  if (override) return override;
  return path.join(env.HOME || os.homedir(), '.local', 'state', 'agent-manager', 'disabled-workers');
}

function isValidWorkerId(id) {
  return typeof id === 'string' && WORKER_ID_RE.test(id);
}

function toMs(now) {
  const n = Number(now); // a Date converts to its milliseconds
  return Number.isFinite(n) ? n : Date.now();
}

function isPauseScope(scope) {
  return PAUSE_SCOPES.includes(scope);
}

function pausePath(scope, env) {
  return path.join(switchDir(env), `_pause-${scope}`);
}

// The active pause marker for a scope, or null (no file, expired, unreadable, malformed or an unknown scope).
function readPause(scope, env = process.env, now = Date.now()) {
  if (!isPauseScope(scope)) return null;
  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(pausePath(scope, env), 'utf8'));
  } catch (e) {
    return null;
  }
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return null;
  if (marker.expiresAt != null) {
    const expires = Date.parse(marker.expiresAt);
    if (!Number.isFinite(expires) || expires <= toMs(now)) return null;
  }
  return marker;
}

// Writes the pause marker for a scope (replacing any existing one) and returns it. ttlMin makes expiresAt = now + ttlMin minutes; without it the pause
// never expires. An unknown scope or a ttlMin that is not a positive number throws.
function setPause(scope, { reason, source, ttlMin } = {}, env = process.env, now = Date.now()) {
  if (!isPauseScope(scope)) throw new Error(`invalid pause scope ${JSON.stringify(scope)}`);
  if (ttlMin !== undefined && ttlMin !== null && !(Number.isFinite(Number(ttlMin)) && Number(ttlMin) > 0)) throw new Error(`invalid ttlMin ${JSON.stringify(ttlMin)}`);
  const at = toMs(now);
  const marker = {
    scope,
    reason: reason == null ? '' : String(reason),
    source: source == null || String(source) === '' ? 'operator' : String(source),
    setAt: new Date(at).toISOString(),
    expiresAt: ttlMin === undefined || ttlMin === null ? null : new Date(at + Number(ttlMin) * 60 * 1000).toISOString(),
  };
  fs.mkdirSync(switchDir(env), { recursive: true });
  writeJsonAtomicSync(pausePath(scope, env), marker);
  return marker;
}

// Removes the pause marker for a scope. Returns true when one was removed, false when there was none. An unknown scope throws.
function clearPause(scope, env = process.env) {
  if (!isPauseScope(scope)) throw new Error(`invalid pause scope ${JSON.stringify(scope)}`);
  try {
    fs.unlinkSync(pausePath(scope, env));
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}

function isDisabled(id, env = process.env, now = Date.now()) {
  if (!isValidWorkerId(id)) return false;
  if (fs.existsSync(path.join(switchDir(env), id))) return true;
  return readPause('node', env, now) !== null || readPause('global', env, now) !== null;
}

// disabled true writes the marker, false removes it (a no-op when there is none). Returns the new disabled state. An invalid id throws.
function setDisabled(id, disabled, env = process.env) {
  if (!isValidWorkerId(id)) throw new Error(`invalid worker id ${JSON.stringify(id)}`);
  const dir = switchDir(env);
  const marker = path.join(dir, id);
  if (disabled) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(marker, `${JSON.stringify({ disabledAt: new Date().toISOString() })}\n`);
    return true;
  }
  try {
    fs.unlinkSync(marker);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  return false;
}

function listDisabled(env = process.env) {
  try {
    return fs.readdirSync(switchDir(env)).filter(isValidWorkerId).sort();
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

function pauseStatus(env = process.env, now = Date.now()) {
  return { node: readPause('node', env, now), global: readPause('global', env, now), workers: listDisabled(env) };
}

module.exports = { switchDir, isValidWorkerId, isDisabled, setDisabled, listDisabled, PAUSE_SCOPES, readPause, setPause, clearPause, pauseStatus };

function flagValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const [cmd, id] = args;
  try {
    if (cmd === 'is-disabled') process.exit(isDisabled(id) ? 0 : 1);
    else if (cmd === 'disable') setDisabled(id, true);
    else if (cmd === 'enable') setDisabled(id, false);
    else if (cmd === 'list') console.log(JSON.stringify(listDisabled()));
    else if (cmd === 'dir') console.log(switchDir());
    else if (cmd === 'pause' || cmd === 'resume') {
      if (!isPauseScope(id)) { console.error(`usage: worker-switch.js ${cmd} <${PAUSE_SCOPES.join('|')}>${cmd === 'pause' ? ' [--reason <text>] [--source <text>] [--ttl-min <n>]' : ''}`); process.exit(2); }
      if (cmd === 'resume') clearPause(id);
      else {
        const ttl = flagValue(args, '--ttl-min');
        if (ttl !== undefined && !(Number.isFinite(Number(ttl)) && Number(ttl) > 0)) { console.error('--ttl-min must be a positive number'); process.exit(2); }
        setPause(id, { reason: flagValue(args, '--reason'), source: flagValue(args, '--source'), ttlMin: ttl === undefined ? undefined : Number(ttl) });
      }
    }
    else if (cmd === 'pause-status') console.log(JSON.stringify(pauseStatus()));
    else { console.error('usage: worker-switch.js is-disabled|disable|enable <worker-id> | pause|resume <node|global> | pause-status | list | dir'); process.exit(2); }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
