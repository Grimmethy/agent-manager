'use strict';

// Node pull (multi-node plan): asks the claim endpoint for work when this node has a free worker. A task that comes back is
// written into this machine's queue/adhoc/ (writeAdhoc from src/node-intake-server.js) stamped leasedTo: <node id>.
// pullOnce never throws. Daemon entry: node src/node-pull.js --daemon. All timers come from deps. Besides the debounce and retry timers, there is one 10-minute safety re-check timer, armed only after a successful pullOnce and never while a retry timer is pending.
//
// Settings: AGENT_MANAGER_CLAIM_URL (POST target), AGENT_MANAGER_NODE_TOKEN_FILE (token file, read and trimmed),
// AGENT_MANAGER_NODE_ID (sent as id), AGENT_MANAGER_PIPELINE_DIR (where adhoc records are written).
// The response repo.remoteUrl is the clone URL; no local path is taken from the response.

const fs = require('fs');
const path = require('path');
const { checkDrift, readMaxBehind } = require('./node-code-drift.js');

const DEBOUNCE_MS = 2000;
const BACKOFF_FIRST_MS = 30000;
const BACKOFF_CAP_MS = 600000;
const SAFETY_RECHECK_MS = 10 * 60 * 1000;
const WATCHED_QUEUES = ['adhoc', 'pending', 'blocked', 'review', 'node-outbox'];
const DRAFTING_DIR = 'drafting';

function defaultLog(message) {
  process.stderr.write(String(message) + '\n');
}

function errorMessage(e) {
  return e && e.message ? e.message : String(e);
}

// Names of the subdirectories directly inside dir; [] if dir cannot be read.
function defaultListDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (e) {
    return [];
  }
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
    listDirs: deps.listDirs || defaultListDirs,
    classes: deps.classes,
    isPaused: deps.isPaused || (() => false),
    isWorkerFree: deps.isWorkerFree || (() => true),
    codeSha: deps.codeSha || null,
    masterSha: deps.masterSha || null,
    countBehind: deps.countBehind || (() => null),
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

// Best-effort POST /release on the registry that served the claim (the claim URL with /claim swapped for /release). Never throws.
async function releaseLease(d, claimUrl, token, nodeId, taskId) {
  try {
    const url = claimUrl.replace(/\/claim$/, '/release');
    if (url === claimUrl) return false;
    const res = await d.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ id: nodeId, taskId }),
    });
    return Boolean(res && res.ok);
  } catch (e) {
    return false;
  }
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

    // Check code drift before claiming: refuse if the node is behind the registry master by more than AGENT_MANAGER_NODE_MAX_BEHIND.
    const maxBehind = readMaxBehind();
    const driftResult = checkDrift({
      codeSha: d.codeSha,
      masterSha: d.masterSha,
      maxBehind,
      countBehind: d.countBehind,
    });
    if (driftResult.allow === false) {
      d.log(driftResult.message);
      return failure(d, state, driftResult.message);
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
      if (!remoteUrl) {
        // Hand the lease back (best effort) so the task is not held for its full TTL, and name it so the log shows which one.
        await releaseLease(d, claimUrl, token, id, body.task.id);
        return failure(d, state, `claim response has no repo.remoteUrl (task ${body.task.id})`);
      }
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
    d.log(`node-pull: idle; wok asked to retry in ${Number.isFinite(sec) ? sec : 'unknown'} s`);
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
  const queueWatchers = [];
  const draftWatchers = new Map();
  let safetyTimer = null;

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
      if (state.nextAllowedAt > d.now()) {
        // Error or retryAfterSec: retry only. Never a safety timer alongside it.
        safetyTimer = clear(safetyTimer);
        armRetry();
      } else {
        armSafety();
      }
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

  const armSafety = () => {
    safetyTimer = clear(safetyTimer);
    // poll-ok: safety net for dropped fs.watch events; fires at most once per 10 min, re-arms only after a successful pullOnce, stops when paused or on error. Idle cost: one wake per 10 min (unmeasured in this pass).
    safetyTimer = d.setTimeout(() => {
      safetyTimer = null;
      trigger();
    }, SAFETY_RECHECK_MS);
  };

  const onWatch = () => {
    debounceTimer = clear(debounceTimer);
    debounceTimer = d.setTimeout(() => {
      debounceTimer = null;
      trigger();
    }, DEBOUNCE_MS);
  };

  const watchDir = (dir, label, handler) => {
    try {
      const w = d.watch(dir, handler);
      if (w && typeof w.on === 'function') {
        w.on('error', (e) => d.log(`node-pull: watch error on ${label}: ${errorMessage(e)}`));
      }
      return w;
    } catch (e) {
      d.log(`node-pull: cannot watch ${label}: ${errorMessage(e)}`);
      return null;
    }
  };

  // Opens watchers for new worker subdirectories of queue/drafting and closes those whose directory is gone.
  const syncDraftWatchers = () => {
    const draftingDir = path.join(pipelineDir, 'queue', DRAFTING_DIR);
    const names = new Set(d.listDirs(draftingDir));
    for (const [name, handle] of draftWatchers) {
      if (!names.has(name)) {
        if (handle && typeof handle.close === 'function') handle.close();
        draftWatchers.delete(name);
      }
    }
    for (const name of names) {
      if (!draftWatchers.has(name)) {
        const handle = watchDir(path.join(draftingDir, name), `queue/${DRAFTING_DIR}/${name}`, onWatch);
        if (handle) draftWatchers.set(name, handle);
      }
    }
  };

  if (pipelineDir) {
    for (const name of WATCHED_QUEUES) {
      const handle = watchDir(path.join(pipelineDir, 'queue', name), `queue/${name}`, onWatch);
      if (handle) queueWatchers.push(handle);
    }
    // Known gap: if queue/drafting does not exist at startup its watch fails and is not retried; it is picked up only after a restart.
    const draftHandle = watchDir(path.join(pipelineDir, 'queue', DRAFTING_DIR), `queue/${DRAFTING_DIR}`, () => {
      syncDraftWatchers();
      onWatch();
    });
    if (draftHandle) queueWatchers.push(draftHandle);
    syncDraftWatchers();
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
      safetyTimer = clear(safetyTimer);
      for (const w of queueWatchers) {
        if (w && typeof w.close === 'function') w.close();
      }
      queueWatchers.length = 0;
      for (const w of draftWatchers.values()) {
        if (w && typeof w.close === 'function') w.close();
      }
      draftWatchers.clear();
    },
  };
}

module.exports = { pullOnce, makeState, startDaemon, DEBOUNCE_MS, BACKOFF_FIRST_MS, BACKOFF_CAP_MS, SAFETY_RECHECK_MS, WATCHED_QUEUES };

if (require.main === module && process.argv.includes('--daemon')) {
  // The real dependencies (repo on demand, one claimed task at a time, pause marker, class filter) live in src/node-pull-entry.js.
  startDaemon({ env: process.env, deps: require('./node-pull-entry.js').buildDaemonDeps(process.env) });
}
