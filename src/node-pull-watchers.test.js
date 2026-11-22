'use strict';

// Pins the drafting-folder watchers, the per-worker watchers, watcher error logging and the safety timer of src/node-pull.js startDaemon.
// Everything is injected (deps.watch, deps.listDirs, deps.setTimeout, deps.fetch): no real timers, no real fs.watch, no network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startDaemon, SAFETY_RECHECK_MS } = require('./node-pull.js');

const DEBOUNCE_MS = 2000;

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'node-pull-watchers-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tokenFile = path.join(root, 'node-token');
  fs.writeFileSync(tokenFile, 'tok\n');
  const pipelineDir = path.join(root, 'pipeline');
  const env = { HOME: root, AGENT_MANAGER_NODE_ID: 'grimm', AGENT_MANAGER_PIPELINE_DIR: pipelineDir, AGENT_MANAGER_NODE_TOKEN_FILE: tokenFile, AGENT_MANAGER_CLAIM_URL: 'http://claim.invalid/claim' };
  return { env, pipelineDir };
}

function fakeTimers() {
  const timers = [];
  return {
    setTimeout: (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimeout: (timer) => { if (timer) timer.cleared = true; },
    live: () => timers.filter((x) => !x.cleared && !x.fired),
    fireDebounce() {
      const found = this.live().filter((x) => x.ms === DEBOUNCE_MS);
      assert.equal(found.length, 1, 'exactly one debounce timer is armed');
      found[0].fired = true;
      found[0].fn();
    },
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function settle() { for (let i = 0; i < 20; i += 1) await tick(); }

// Every watch call is recorded; each handle counts its close() calls and keeps the listeners registered through on().
function recorder(opts = {}) {
  const watched = [];
  const watch = (dir, cb) => {
    if (opts.throwFor && opts.throwFor(dir)) throw new Error('EMFILE');
    const handle = { dir, cb, closes: 0, listeners: {}, close() { this.closes += 1; }, on(ev, fn) { this.listeners[ev] = fn; } };
    watched.push(handle);
    return handle;
  };
  return { watched, watch, on: (dir) => watched.filter((h) => h.dir === dir) };
}

// Starts a daemon with a counting fake fetch that always answers "idle, retry now".
async function start(t, { dirs = [], throwFor } = {}) {
  const { env, pipelineDir } = setup(t);
  const timers = fakeTimers();
  const rec = recorder({ throwFor });
  const lines = [];
  const state = { dirs, claims: 0 };
  const fetch = async () => { state.claims += 1; return { ok: true, json: async () => ({ ok: true, task: null, retryAfterSec: 0 }) }; };
  const daemon = startDaemon({
    env,
    deps: {
      now: () => 1_000_000, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, watch: rec.watch,
      listDirs: () => state.dirs, log: (m) => lines.push(m), fetch,
    },
  });
  t.after(() => daemon.stop());
  await settle();
  const q = (...parts) => path.join(pipelineDir, 'queue', ...parts);
  return { daemon, timers, rec, lines, state, q };
}

test('the drafting watcher callback picks up a new worker folder once and never registers it twice (mutants 1, 8)', async (t) => {
  const s = await start(t, { dirs: [] });
  assert.equal(s.rec.on(s.q('drafting', 'w1')).length, 0, 'no worker folder yet');
  s.state.dirs = ['w1'];
  s.rec.on(s.q('drafting'))[0].cb();
  assert.equal(s.rec.on(s.q('drafting', 'w1')).length, 1, 'w1 is now watched');
  s.rec.on(s.q('drafting'))[0].cb();
  assert.equal(s.rec.on(s.q('drafting', 'w1')).length, 1, 'still one watcher on w1');
});

test('the drafting watcher callback arms the debounce and one claim follows when the worker is free (mutant 2)', async (t) => {
  const s = await start(t);
  assert.equal(s.state.claims, 1, 'one pull at start');
  s.rec.on(s.q('drafting'))[0].cb();
  s.timers.fireDebounce();
  await settle();
  assert.equal(s.state.claims, 2, 'exactly one more claim');
});

test('workers present at startup are watched before any event fires (mutant 3)', async (t) => {
  const s = await start(t, { dirs: ['w1', 'w2'] });
  assert.equal(s.rec.on(s.q('drafting', 'w1')).length, 1);
  assert.equal(s.rec.on(s.q('drafting', 'w2')).length, 1);
});

test('stop() closes every queue watcher and every per-worker watcher exactly once (mutant 4)', async (t) => {
  const s = await start(t, { dirs: ['w1', 'w2'] });
  assert.equal(s.rec.watched.length, 8, 'six queue dirs and two worker folders');
  s.daemon.stop();
  for (const h of s.rec.watched) assert.equal(h.closes, 1, h.dir);
});

test('the safety timer waits exactly 10 minutes (mutant 5)', async (t) => {
  const s = await start(t);
  assert.equal(SAFETY_RECHECK_MS, 600000);
  const live = s.timers.live();
  assert.equal(live.length, 1);
  assert.equal(live[0].ms, 600000);
});

test('a vanished worker folder is closed and forgotten, so it can be watched again later (mutants 6, 7)', async (t) => {
  const s = await start(t, { dirs: ['w1', 'w2'] });
  const w1 = s.q('drafting', 'w1');
  const w2 = s.q('drafting', 'w2');
  s.state.dirs = ['w2'];
  s.rec.on(s.q('drafting'))[0].cb();
  assert.equal(s.rec.on(w1)[0].closes, 1, 'w1 closed once');
  assert.equal(s.rec.on(w2)[0].closes, 0, 'w2 left open');
  s.state.dirs = ['w1', 'w2'];
  s.rec.on(s.q('drafting'))[0].cb();
  assert.equal(s.rec.on(w1).length, 2, 'a new watcher is registered for w1');
  assert.equal(s.rec.on(w2).length, 1, 'w2 is not registered again');
});

test('a change inside a worker folder triggers one claim (mutant 9)', async (t) => {
  const s = await start(t, { dirs: ['w1'] });
  assert.equal(s.state.claims, 1);
  s.rec.on(s.q('drafting', 'w1'))[0].cb();
  s.timers.fireDebounce();
  await settle();
  assert.equal(s.state.claims, 2);
});

test('every watcher gets an error listener that logs the error (mutant 10)', async (t) => {
  const s = await start(t, { dirs: ['w1'] });
  for (const h of s.rec.watched) assert.equal(typeof h.listeners.error, 'function', h.dir);
  s.rec.on(s.q('drafting', 'w1'))[0].listeners.error(new Error('boom'));
  assert.ok(s.lines.some((l) => l.includes('watch error') && l.includes('boom') && l.includes('queue/drafting/w1')), s.lines.join('|'));
});

test('a directory that cannot be watched is logged and the daemon still starts (mutant 11)', async (t) => {
  const s = await start(t, { throwFor: (dir) => dir.endsWith(path.join('queue', 'review')) });
  assert.ok(s.lines.some((l) => l.includes('cannot watch') && l.includes('queue/review')), s.lines.join('|'));
  assert.equal(s.rec.watched.length, 5, 'the other five dirs are watched');
  assert.equal(s.state.claims, 1, 'the daemon still pulled at start');
});
