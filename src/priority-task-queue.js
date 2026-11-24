'use strict';

/**
 * Keyed priority task queue: two lanes ('user' before 'background'), dedupe by key,
 * in-place promote, per-failure exponential-backoff retry, and 429 handling that keeps
 * the job queued without consuming an attempt.
 *
 * 429 SHAPE (contract assumption, PARTIALLY verified):
 *   grep_codebase 'status === 429' found:
 *     src/node-breaker.js:62       if (result.status === 429) return true;
 *     src/github-readonly.js:167   if (res.status === 429) return true;
 *   Both read a numeric .status off a result or response object. No hit shows a thrown
 *   error carrying .status, so err.status === 429 on a rejected run() is the contract
 *   assumption, not an observed pattern.
 *   grep_codebase 'resetsAt' hits are only in budget-monitor.js, where resetsAt is parsed
 *   from message text. No error object in src/ carries a resetsAt field today, so
 *   err.resetsAt (ISO string or epoch ms, optional) is UNVERIFIED. When absent, the pause
 *   falls back to now() + baseBackoffMs.
 */

const fs = require('fs');
const path = require('path');
const { writeJsonAtomicSync } = require('./atomic-write');

function emptyState() {
  return { lanes: { user: [], background: [] }, entries: {}, pausedUntil: null };
}

function parseResetsAt(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/**
 * @param {object} options
 * @param {(task: any) => Promise<any>} options.run  Executes one task; rejects on failure.
 * @param {number} [options.concurrency=1]
 * @param {string} [options.statePath='state/priority-queue.json']
 * @param {number} [options.maxAttempts=3]     Non-429 failures before the promise rejects.
 * @param {number} [options.baseBackoffMs=1000] Retry delay is baseBackoffMs * 2 ** (attempts - 1).
 * @param {() => number} [options.now=Date.now]
 * @returns {{ enqueue: (key: string, task: any, lane: 'user'|'background') => Promise<any>,
 *            promote: (key: string) => boolean, loadError: Error|null }}
 *
 * Semantics:
 *  - enqueue with an existing key does not add a second entry; it returns the promise of the
 *    existing entry. Lane is ignored for duplicates.
 *  - promote moves a background key into the user lane at the same index it held in background
 *    (clamped to the user lane length), so it keeps its place rather than going to the end.
 *  - The state file holds one pausedUntil, so a 429 pauses the whole queue, not one lane.
 *  - Every mutation persists through writeJsonAtomicSync. Keys left 'running' on load are reset
 *    to 'queued'.
 *  - No polling: timers are one-shot (retry per key, one resume timer).
 */
function createPriorityTaskQueue(options) {
  const {
    run,
    concurrency = 1,
    statePath = 'state/priority-queue.json',
    maxAttempts = 3,
    baseBackoffMs = 1000,
    now = Date.now,
  } = options || {};
  if (typeof run !== 'function') throw new TypeError('createPriorityTaskQueue: run must be a function');

  let state = emptyState();
  let loadError = null;
  let running = 0;
  const waiters = new Map();     // key -> { promise, resolve, reject }, in memory only
  const retryTimers = new Map(); // key -> one-shot backoff timer, in memory only
  let resumeTimer = null;        // the single 429 resume timer, in memory only

  function persist() {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    writeJsonAtomicSync(statePath, state);
  }

  function load() {
    let raw;
    try {
      raw = fs.readFileSync(statePath, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') loadError = err;
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !parsed.lanes || !parsed.entries ||
          !Array.isArray(parsed.lanes.user) || !Array.isArray(parsed.lanes.background)) {
        throw new Error('invalid priority queue state in ' + statePath);
      }
      state = {
        lanes: {
          user: parsed.lanes.user.filter((k) => parsed.entries[k]),
          background: parsed.lanes.background.filter((k) => parsed.entries[k]),
        },
        entries: parsed.entries,
        pausedUntil: typeof parsed.pausedUntil === 'number' ? parsed.pausedUntil : null,
      };
    } catch (err) {
      loadError = err;
      state = emptyState();
      return;
    }
    let reset = false;
    for (const entry of Object.values(state.entries)) {
      if (entry.status === 'running') {
        entry.status = 'queued';
        reset = true;
      }
    }
    if (reset) persist();
  }

  function isPaused() {
    return state.pausedUntil !== null && state.pausedUntil > now();
  }

  function armResume(until) {
    if (resumeTimer) clearTimeout(resumeTimer);
    state.pausedUntil = until;
    resumeTimer = setTimeout(() => {
      resumeTimer = null;
      state.pausedUntil = null;
      persist();
      pump();
    }, Math.max(0, until - now()));
  }

  function waiterFor(key) {
    let w = waiters.get(key);
    if (!w) {
      w = {};
      w.promise = new Promise((resolve, reject) => {
        w.resolve = resolve;
        w.reject = reject;
      });
      waiters.set(key, w);
    }
    return w;
  }

  function removeKey(key) {
    for (const lane of ['user', 'background']) {
      state.lanes[lane] = state.lanes[lane].filter((k) => k !== key);
    }
    delete state.entries[key];
  }

  function nextKey() {
    for (const lane of ['user', 'background']) {
      for (const key of state.lanes[lane]) {
        const entry = state.entries[key];
        if (entry && entry.status === 'queued' && !retryTimers.has(key)) return key;
      }
    }
    return null;
  }

  function pump() {
    if (isPaused()) return;
    while (running < concurrency) {
      const key = nextKey();
      if (key === null) break;
      start(key);
    }
  }

  function start(key) {
    const entry = state.entries[key];
    entry.status = 'running';
    persist();
    running += 1;
    let outcome;
    try {
      outcome = Promise.resolve(run(entry.task));
    } catch (err) {
      outcome = Promise.reject(err);
    }
    outcome.then((result) => finish(key, result), (err) => fail(key, err));
  }

  function finish(key, result) {
    running -= 1;
    const w = waiters.get(key);
    waiters.delete(key);
    removeKey(key);
    persist();
    if (w) w.resolve(result);
    pump();
  }

  function fail(key, err) {
    running -= 1;
    const entry = state.entries[key];
    if (!entry) {
      pump();
      return;
    }
    if (err && err.status === 429) {
      // Rate limited: keep the job queued and do not consume an attempt.
      entry.status = 'queued';
      const resetAt = parseResetsAt(err.resetsAt);
      armResume(resetAt !== null ? resetAt : now() + baseBackoffMs);
      persist();
      pump();
      return;
    }
    entry.attempts += 1;
    if (entry.attempts < maxAttempts) {
      entry.status = 'queued';
      persist();
      const delay = baseBackoffMs * 2 ** (entry.attempts - 1);
      const timer = setTimeout(() => {
        retryTimers.delete(key);
        pump();
      }, delay);
      retryTimers.set(key, timer);
    } else {
      const w = waiters.get(key);
      waiters.delete(key);
      removeKey(key);
      persist();
      if (w) w.reject(err);
    }
    pump();
  }

  function enqueue(key, task, lane) {
    if (typeof key !== 'string' || key === '') {
      throw new TypeError('enqueue: key must be a non-empty string');
    }
    if (lane !== 'user' && lane !== 'background') {
      throw new TypeError('enqueue: lane must be user or background');
    }
    if (state.entries[key]) return waiterFor(key).promise;
    state.entries[key] = { key, task, lane, status: 'queued', attempts: 0 };
    state.lanes[lane].push(key);
    const w = waiterFor(key);
    persist();
    pump();
    return w.promise;
  }

  function promote(key) {
    const entry = state.entries[key];
    if (!entry || entry.lane !== 'background') return false;
    const index = state.lanes.background.indexOf(key);
    if (index === -1) return false;
    state.lanes.background.splice(index, 1);
    state.lanes.user.splice(Math.min(index, state.lanes.user.length), 0, key);
    entry.lane = 'user';
    persist();
    pump();
    return true;
  }

  load();
  if (state.pausedUntil !== null) armResume(state.pausedUntil);
  pump();

  return { enqueue, promote, loadError };
}

module.exports = { createPriorityTaskQueue };
