'use strict';

// Daemon dependencies for `node src/node-pull.js --daemon` (FF-3 wiring): the real ensureRepo adapter, a worker-free check (up to AGENT_MANAGER_NODE_MAX_TASKS claimed tasks per node, default 1),
// a pause marker and the optional class filter. buildDaemonDeps(env, overrides) returns { ensureRepo, isWorkerFree, isPaused, classes }.
//   ensureRepo({remoteUrl, baseBranch}): the repo name is the last path segment of remoteUrl without .git; calls src/node-repo-ensure.js
//     ensureRepo({name, remoteUrl, baseBranch}, {env}); a result with ok:false (or no result) throws so pullOnce reports the failure.
//   isWorkerFree(): true only while fewer than AGENT_MANAGER_NODE_MAX_TASKS records in <AGENT_MANAGER_PIPELINE_DIR>/queue/adhoc, queue/pending or queue/drafting/<worker>/ have
//     leasedTo equal to AGENT_MANAGER_NODE_ID (a whole number 1 to 8; unset or invalid means 1, i.e. one claimed task at a time per node). A missing directory is empty; an unreadable directory,
//     an unset node id or an unset pipeline dir count as NOT free (safe). A record that vanishes or is not valid JSON while being read is skipped.
//   isPaused(): true while <AGENT_MANAGER_STATE_DIR or ~/.local/state/agent-manager>/node-pull-paused exists (a marker the owner can touch).
//   classes: AGENT_MANAGER_NODE_CLASSES (comma separated, trimmed, empty entries dropped) when it has an entry, else undefined.
// overrides.ensure replaces the node-repo-ensure function (tests). No timers; Node built-ins only.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PAUSE_MARKER = 'node-pull-paused';

// The repo name for a clone url: the last path segment without a trailing .git. '' when there is none.
function repoNameFromUrl(remoteUrl) {
  const segments = String(remoteUrl || '').split('/').filter(Boolean);
  const last = segments.length ? segments[segments.length - 1] : '';
  return last.replace(/\.git$/, '');
}

function parseClasses(raw) {
  const list = String(raw || '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? list : undefined;
}

function stateDir(env) {
  return env.AGENT_MANAGER_STATE_DIR || path.join(env.HOME || os.homedir(), '.local', 'state', 'agent-manager');
}

// The directories whose records mean "this node still holds a claimed task": adhoc, pending and each worker folder under drafting.
function claimDirs(pipelineDir) {
  const queue = path.join(pipelineDir, 'queue');
  const dirs = [path.join(queue, 'adhoc'), path.join(queue, 'pending')];
  const drafting = path.join(queue, 'drafting');
  let entries = [];
  try {
    entries = fs.readdirSync(drafting, { withFileTypes: true });
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  for (const entry of entries) if (entry.isDirectory()) dirs.push(path.join(drafting, entry.name));
  return dirs;
}

// Sibling queues whose presence of the same file name marks an adhoc/pending record as a dead duplicate (the work already left or stopped).
const DEAD_DUPLICATE_DIRS = ['needs-clarification', 'blocked', 'node-sent', 'node-refused', 'node-outbox'];

// True when queueName (adhoc or pending, relative to <pipelineDir>/queue) holds a record fileName whose exact name also exists in one of DEAD_DUPLICATE_DIRS.
// drafting/<worker> records are never dead. A missing sibling directory counts as empty; other read errors throw.
function isDeadDuplicate(pipelineDir, queueName, fileName) {
  if (queueName !== 'adhoc' && queueName !== 'pending') return false;
  const queue = path.join(pipelineDir, 'queue');
  for (const sibling of DEAD_DUPLICATE_DIRS) {
    let names;
    try {
      names = fs.readdirSync(path.join(queue, sibling));
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      throw e;
    }
    if (names.includes(fileName)) return true;
  }
  return false;
}

// True when the record named fileName in queue queueName (relative to <pipelineDir>/queue) is leased to nodeId and is not a dead duplicate.
// A missing file, invalid JSON, or ENOENT on the sibling directory are treated as "not held".
// Dead-duplicate check only applies to adhoc/pending; drafting records are never dead.
function holdsLeasedTask(pipelineDir, queueName, fileName, nodeId) {
  if (queueName !== 'adhoc' && queueName !== 'pending') {
    // drafting: no dead-duplicate check, just check if leased
    const filePath = path.join(pipelineDir, 'queue', queueName, fileName);
    let record;
    try {
      record = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      return false;
    }
    return !!(record && record.leasedTo === nodeId);
  }
  if (isDeadDuplicate(pipelineDir, queueName, fileName)) return false;
  const filePath = path.join(pipelineDir, 'queue', queueName, fileName);
  let record;
  try {
    record = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return false;
  }
  return !!(record && record.leasedTo === nodeId);
}

function countLeasedIn(dir, nodeId, pipelineDir) {
  const queueName = path.relative(path.join(pipelineDir, 'queue'), dir);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    if (e.code === 'ENOENT') return 0;
    throw e;
  }
  let count = 0;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    if (holdsLeasedTask(pipelineDir, queueName, name, nodeId)) count += 1;
  }
  return count;
}

// How many claimed tasks this node holds: records leased to nodeId summed over claimDirs(pipelineDir). Unreadable directories throw as before.
function countHeldTasks(pipelineDir, nodeId) {
  let total = 0;
  for (const dir of claimDirs(pipelineDir)) total += countLeasedIn(dir, nodeId, pipelineDir);
  return total;
}

// AGENT_MANAGER_NODE_MAX_TASKS: a whole number from 1 to 8 (surrounding spaces allowed); unset, empty or anything else means 1. Never throws.
function maxTasks(env) {
  try {
    const raw = env && typeof env.AGENT_MANAGER_NODE_MAX_TASKS === 'string' ? env.AGENT_MANAGER_NODE_MAX_TASKS.trim() : '';
    if (!/^[0-9]+$/.test(raw)) return 1;
    const n = parseInt(raw, 10);
    return n >= 1 && n <= 8 ? n : 1;
  } catch (e) {
    return 1;
  }
}

function buildDaemonDeps(env = process.env, overrides = {}) {
  const ensure = overrides.ensure || ((spec, opts) => require('./node-repo-ensure.js').ensureRepo(spec, opts));
  return {
    ensureRepo: async (info) => {
      const remoteUrl = info && info.remoteUrl;
      const name = repoNameFromUrl(remoteUrl);
      if (!name) throw new Error('cannot derive a repo name from the remote url');
      const result = ensure({ name, remoteUrl, baseBranch: info && info.baseBranch }, { env });
      if (!result || result.ok !== true) throw new Error((result && result.reason) || 'ensureRepo failed');
      return result;
    },
    isWorkerFree: () => {
      const pipelineDir = String(env.AGENT_MANAGER_PIPELINE_DIR || '').trim();
      const nodeId = String(env.AGENT_MANAGER_NODE_ID || '').trim();
      if (!pipelineDir || !nodeId) return false;
      try {
        return countHeldTasks(pipelineDir, nodeId) < maxTasks(env);
      } catch (e) {
        return false;
      }
    },
    isPaused: () => fs.existsSync(path.join(stateDir(env), PAUSE_MARKER)),
    classes: parseClasses(env.AGENT_MANAGER_NODE_CLASSES),
  };
}

module.exports = { buildDaemonDeps, repoNameFromUrl, parseClasses, PAUSE_MARKER, maxTasks, countHeldTasks, isDeadDuplicate };
