'use strict';

// Node pull (multi-node plan): asks the claim endpoint for work when this node has a free worker. A task that comes back is
// written into this machine's queue/adhoc/ (writeAdhoc from src/node-intake-server.js) stamped leasedTo: <node id>.
// pullOnce never throws. Daemon entry: node src/node-pull.js --daemon. All timers come from deps; there is no periodic timer.
//
// Settings: AGENT_MANAGER_CLAIM_URL (POST target), AGENT_MANAGER_NODE_TOKEN_FILE (token file, read and trimmed),
// AGENT_MANAGER_NODE_ID (sent as id), AGENT_MANAGER_PIPELINE_DIR (where adhoc records are written).
// The response repo.remoteUrl is the clone URL; no local path is taken from the response.

const fs = require('fs');
const path = require('path');

const DEBOUNCE_MS = 2000;
const BACKOFF_FIRST_MS = 30000;
const BACKOFF_CAP_MS = 600000;

function defaultLog(message) {
  process.stderr.write(String(message) + '\n');
}

function errorMessage(e) {
  return e && e.message ? e.message : String(e);
}

function resolveDeps(deps = {}) {
  return {
    fetch: deps.fetch || ((...args) => fetch(...args)),
    ensureRepo: deps.ensureRepo || (async () => { throw new Error('ensureRepo dependency is not wired'); }),
    writeAdhoc: deps.writeAdhoc || ((dir, record) => require('./node-intake-server.js').writeAdhoc(dir, record)),
    log: deps.log || defaultLog,
    now: deps.now || (() => Date.now()),
    setTimeout: deps.setTimeout || setTimeout,
    clearTimeout: deps.clearTimeout || clearTimeout,
    watch: deps.watch || fs.watch,
    classes: deps.classes,
    isPaused: deps.isPaused || (() => false),
    isWorkerFree: deps.isWorkerFree || (() => true),
  };
}

function makeState() {
  return { backoffMs: 0, nextAllowedAt: 0 };
}

// Records an error: 30 s on the first one, doubling on each consecutive one, capped at 10 minutes.
function failure(d, state, error) {
  state.backoffMs = state.backoffMs ? Math.min(BACKOFF_CAP_MS, state.backoffMs * 2) : BACKOFF_FIRST_MS;
  state.nextAllowedAt = d.now() + state.backoffMs;
  d.log(`node-pull: ${error}; next attempt in ${state.backoffMs} ms`);
  return { error, nextAllowedAt: state.nextAllowedAt };
}

function readToken(file) {
  const token = fs.readFileSync(file, 'utf8').trim();
  if (!token) throw new Error('token file is empty');
  return token;
}

async function pullOnce({ env = process.env, deps = {}, state = makeState() } = {}) {
  const d = resolveDeps(deps);
  try {
    const claimUrl = String(env.AGENT_MANAGER_CLAIM_URL || '').trim();
    if (!claimUrl) return failure(d, state, 'AGENT_MANAGER_CLAIM_URL is not set');
    const pipelineDir = String(env.AGENT_MANAGER_PIPELINE_DIR || '').trim();
    if (!pipelineDir) return failure(d, state, 'AGENT_MANAGER_PIPELINE_DIR is not set');
    const id = String(env.AGENT_MANAGER_NODE_ID || '').trim();
    if (!id) return failure(d, state, 'AGENT_MANAGER_NODE_ID is not set');

    let token;
    try {
      token = readToken(String(env.AGENT_MANAGER_NODE_TOKEN_FILE || '').trim());
    } catch (e) {
      return failure(d, state, 'cannot read node token file');
    }

    // An absent classes key means "no class filter" on the claim side; an empty array would filter out every task, so it is never sent.
    const classes = Array.isArray(d.classes) ? d.classes : [];
    const requestBody = classes.length > 0 ? { id, classes } : { id };
    const res = await d.fetch(claimUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(requestBody),
    });
    if (!res || !res.ok) {
      return failure(d, state, `claim request failed with HTTP ${res ? res.status : 'no response'}`);
    }
    const body = await res.json();
    if (!body || body.ok !== true) return failure(d, state, 'claim response was not ok');
    state.backoffMs = 0;

    if (body.task) {
      const remoteUrl = String((body.repo && body.repo.remoteUrl) || '').trim();
      if (!remoteUrl) return failure(d, state, 'claim response has no repo.remoteUrl');
      await d.ensureRepo({ remoteUrl });
      const record = { ...body.task, leasedTo: id };
      if (!d.writeAdhoc(pipelineDir, record)) {
        return failure(d, state, `task ${body.task.id} is already queued`);
      }
      d.log(`node-pull: took task ${body.task.id}`);
      return { task: body.task, lease: body.lease, repo: { remoteUrl } };
    }

    const sec = Number(body.retryAfterSec);
    state.nextAllowedAt = d.now() + (Number.isFinite(sec) && sec >= 0 ? sec * 1000 : BACKOFF_FIRST_MS);
    return { task: null, retryAfterSec: body.retryAfterSec };
  } catch (e) {
    return failure(d, state, errorMessage(e));
  }
}

// Daemon: one pull at start, then one pull per (debounced) change in queue/adhoc/ while the worker is free and not paused,
// with pulls serialized and backoff or retryAfterSec gates honored through a single re-armed timer.
function startDaemon({ env = process.env, deps = {} } = {}) {
  const d = resolveDeps(deps);
  const state = makeState();
  const pipelineDir = String(env.AGENT_MANAGER_PIPELINE_DIR || '').trim();
  let debounceTimer = null;
  let retryTimer = null;
  let inFlight = false;
  let pending = false;
  let stopped = false;
  let watcher = null;

  const clear = (t) => {
    if (t) d.clearTimeout(t);
    return null;
  };

  const trigger = () => {
    if (stopped) return;
    if (inFlight) {
      pending = true;
      return;
    }
    if (d.isPaused() || !d.isWorkerFree()) return;
    if (d.now() < state.nextAllowedAt) {
      armRetry();
      return;
    }
    inFlight = true;
    pullOnce({ env, deps: d, state }).then(() => {
      inFlight = false;
      if (stopped) return;
      if (state.nextAllowedAt > d.now()) armRetry();
      if (pending) {
        pending = false;
        trigger();
      }
    });
  };

  const armRetry = () => {
    retryTimer = clear(retryTimer);
    const wait = Math.max(0, state.nextAllowedAt - d.now());
    // poll-ok: server-directed retryAfterSec/backoff; idle cost = one POST per retryAfterSec (not measured in this pass)
    retryTimer = d.setTimeout(() => {
      retryTimer = null;
      trigger();
    }, wait);
  };

  const onWatch = () => {
    debounceTimer = clear(debounceTimer);
    debounceTimer = d.setTimeout(() => {
      debounceTimer = null;
      trigger();
    }, DEBOUNCE_MS);
  };

  if (pipelineDir) {
    try {
      watcher = d.watch(path.join(pipelineDir, 'queue', 'adhoc'), onWatch);
      if (watcher && typeof watcher.on === 'function') {
        watcher.on('error', (e) => d.log(`node-pull: watch error: ${errorMessage(e)}`));
      }
    } catch (e) {
      d.log(`node-pull: cannot watch adhoc queue: ${errorMessage(e)}`);
    }
  } else {
    d.log('node-pull: AGENT_MANAGER_PIPELINE_DIR is not set; watching disabled');
  }

  trigger();

  return {
    trigger,
    onWatch,
    stop() {
      stopped = true;
      debounceTimer = clear(debounceTimer);
      retryTimer = clear(retryTimer);
      if (watcher && typeof watcher.close === 'function') watcher.close();
    },
  };
}

module.exports = { pullOnce, makeState, startDaemon, DEBOUNCE_MS, BACKOFF_FIRST_MS, BACKOFF_CAP_MS };

if (require.main === module && process.argv.includes('--daemon')) {
  startDaemon({ env: process.env, deps: {} });
}
