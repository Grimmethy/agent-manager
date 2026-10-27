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

const fs = require('fs');
const os = require('os');
const path = require('path');

const WORKER_ID_RE = /^worker-[a-z0-9]+$/;

function switchDir(env = process.env) {
  const override = String(env.AGENT_MANAGER_DISABLED_WORKERS_DIR || '').trim();
  if (override) return override;
  return path.join(env.HOME || os.homedir(), '.local', 'state', 'agent-manager', 'disabled-workers');
}

function isValidWorkerId(id) {
  return typeof id === 'string' && WORKER_ID_RE.test(id);
}

function isDisabled(id, env = process.env) {
  return isValidWorkerId(id) && fs.existsSync(path.join(switchDir(env), id));
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

module.exports = { switchDir, isValidWorkerId, isDisabled, setDisabled, listDisabled };

if (require.main === module) {
  const [cmd, id] = process.argv.slice(2);
  try {
    if (cmd === 'is-disabled') process.exit(isDisabled(id) ? 0 : 1);
    else if (cmd === 'disable') setDisabled(id, true);
    else if (cmd === 'enable') setDisabled(id, false);
    else if (cmd === 'list') console.log(JSON.stringify(listDisabled()));
    else if (cmd === 'dir') console.log(switchDir());
    else { console.error('usage: worker-switch.js is-disabled|disable|enable <worker-id> | list | dir'); process.exit(2); }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
