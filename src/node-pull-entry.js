'use strict';

// Daemon dependencies for `node src/node-pull.js --daemon` (FF-3 wiring): the real ensureRepo adapter, a one-task-at-a-time worker-free check,
// a pause marker and the optional class filter. buildDaemonDeps(env, overrides) returns { ensureRepo, isWorkerFree, isPaused, classes }.
//   ensureRepo({remoteUrl, baseBranch}): the repo name is the last path segment of remoteUrl without .git; calls src/node-repo-ensure.js
//     ensureRepo({name, remoteUrl, baseBranch}, {env}); a result with ok:false (or no result) throws so pullOnce reports the failure.
//   isWorkerFree(): true only while no record in <AGENT_MANAGER_PIPELINE_DIR>/queue/adhoc, queue/pending or queue/drafting/<worker>/ has
//     leasedTo equal to AGENT_MANAGER_NODE_ID, i.e. one claimed task at a time per node. A missing directory is empty; an unreadable directory,
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

function holdsLeasedTask(dir, nodeId) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let record;
    try {
      record = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch (e) {
      continue; // moved away between the listing and the read, or not valid JSON: not a record we can attribute to this node
    }
    if (record && record.leasedTo === nodeId) return true;
  }
  return false;
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
        return !claimDirs(pipelineDir).some((dir) => holdsLeasedTask(dir, nodeId));
      } catch (e) {
        return false;
      }
    },
    isPaused: () => fs.existsSync(path.join(stateDir(env), PAUSE_MARKER)),
    classes: parseClasses(env.AGENT_MANAGER_NODE_CLASSES),
  };
}

module.exports = { buildDaemonDeps, repoNameFromUrl, parseClasses, PAUSE_MARKER };
