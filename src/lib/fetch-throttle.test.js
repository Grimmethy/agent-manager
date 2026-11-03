'use strict';

// src/lib/fetch-throttle.js: one full `git fetch origin` per repository per interval, shared by the watchdog scripts (ADR-0024).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fetchIfDue, stampPath } = require('./fetch-throttle.js');

const world = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fthr-'));
  const repoA = path.join(dir, 'repoA'), repoB = path.join(dir, 'repoB');
  fs.mkdirSync(repoA); fs.mkdirSync(repoB);
  let calls = 0;
  const run = () => { calls += 1; };
  return { dir, repoA, repoB, stampDir: path.join(dir, 'stamps'), run, calls: () => calls };
};
const T = 1_800_000_000_000;

test('the first call fetches; a second call inside the interval is skipped; after the interval it fetches again', () => {
  const w = world();
  const a = fetchIfDue(w.repoA, { run: w.run, now: T, stampDir: w.stampDir, env: {} });
  assert.deepEqual([a.fetched, a.skipped], [true, false]);
  const b = fetchIfDue(w.repoA, { run: w.run, now: T + 10_000, stampDir: w.stampDir, env: {} });
  assert.deepEqual([b.fetched, b.skipped], [false, true]);
  assert.ok(b.ageS >= 9.9 && b.ageS <= 10.1, `ageS ${b.ageS}`);
  const c = fetchIfDue(w.repoA, { run: w.run, now: T + 46_000, stampDir: w.stampDir, env: {} });
  assert.deepEqual([c.fetched, c.skipped], [true, false]);
  assert.equal(w.calls(), 2);
});

test('the next 60 s watchdog tick always fetches again with the 45 s default (a reader is never more than one tick behind)', () => {
  const w = world();
  fetchIfDue(w.repoA, { run: w.run, now: T, stampDir: w.stampDir, env: {} });
  assert.equal(fetchIfDue(w.repoA, { run: w.run, now: T + 59_000, stampDir: w.stampDir, env: {} }).fetched, true);
});

test('repositories are independent', () => {
  const w = world();
  fetchIfDue(w.repoA, { run: w.run, now: T, stampDir: w.stampDir, env: {} });
  assert.equal(fetchIfDue(w.repoB, { run: w.run, now: T + 1000, stampDir: w.stampDir, env: {} }).fetched, true);
  assert.equal(w.calls(), 2);
});

test('a failed fetch rethrows and writes no stamp, so the next caller retries at once', () => {
  const w = world();
  assert.throws(() => fetchIfDue(w.repoA, { run: () => { throw new Error('offline'); }, now: T, stampDir: w.stampDir, env: {} }), /offline/);
  assert.equal(fs.existsSync(stampPath(w.repoA, w.stampDir, fs)), false, 'no stamp file after a failed fetch');
  assert.equal(fetchIfDue(w.repoA, { run: w.run, now: T + 1000, stampDir: w.stampDir, env: {} }).fetched, true);
  assert.equal(fs.existsSync(stampPath(w.repoA, w.stampDir, fs)), true, 'a successful fetch does leave one');
});

test('force always fetches, and still refreshes the stamp', () => {
  const w = world();
  fetchIfDue(w.repoA, { run: w.run, now: T, stampDir: w.stampDir, env: {} });
  assert.equal(fetchIfDue(w.repoA, { run: w.run, now: T + 1000, force: true, stampDir: w.stampDir, env: {} }).fetched, true);
  assert.equal(fetchIfDue(w.repoA, { run: w.run, now: T + 2000, stampDir: w.stampDir, env: {} }).skipped, true);
});

test('an unwritable stamp directory means the fetch runs every time (the old behaviour)', () => {
  const w = world();
  const blocker = path.join(w.dir, 'afile'); fs.writeFileSync(blocker, 'x');
  const stampDir = path.join(blocker, 'stamps');     // a path under a regular file cannot be created
  fetchIfDue(w.repoA, { run: w.run, now: T, stampDir, env: {} });
  fetchIfDue(w.repoA, { run: w.run, now: T + 1000, stampDir, env: {} });
  assert.equal(w.calls(), 2);
});

test('AGENT_MANAGER_FETCH_THROTTLE=off and a custom interval from the environment', () => {
  const w = world();
  const off = { AGENT_MANAGER_FETCH_THROTTLE: 'off' };
  fetchIfDue(w.repoA, { run: w.run, now: T, stampDir: w.stampDir, env: off });
  fetchIfDue(w.repoA, { run: w.run, now: T + 1000, stampDir: w.stampDir, env: off });
  assert.equal(w.calls(), 2);
  const w2 = world();
  const env = { AGENT_MANAGER_FETCH_MIN_INTERVAL_S: '300' };
  fetchIfDue(w2.repoA, { run: w2.run, now: T, stampDir: w2.stampDir, env });
  assert.equal(fetchIfDue(w2.repoA, { run: w2.run, now: T + 200_000, stampDir: w2.stampDir, env }).skipped, true);
  assert.equal(fetchIfDue(w2.repoA, { run: w2.run, now: T + 301_000, stampDir: w2.stampDir, env }).fetched, true);
});

test('a run function is required', () => {
  assert.throws(() => fetchIfDue('/x', {}), /run function/);
});

// --- the two converted scripts share ONE fetch per tick; an injected fetch still always runs ---
const { refreshMain } = require('../derived-premise-sweep.js');
const { fullFetch, reconcile } = require('../task-log-reconcile.js');

test('derived-premise-sweep and task-log-reconcile share one fetch for the same repository', () => {
  const w = world();
  process.env.AGENT_MANAGER_FETCH_STAMP_DIR = w.stampDir;
  try {
    refreshMain(w.repoA, 'main', '/unused', T, w.run);                 // the sweep fetches first
    const r = fullFetch(w.repoA, { run: w.run, now: T + 5000 });        // reconcile, seconds later in the same tick
    assert.equal(r.skipped, true);
    assert.equal(w.calls(), 1);
    assert.equal(fullFetch(w.repoA, { run: w.run, now: T + 60_000 }).fetched, true, 'the next tick fetches again');
    assert.equal(w.calls(), 2);
  } finally { delete process.env.AGENT_MANAGER_FETCH_STAMP_DIR; }
});

test('reconcile with an injected fetchFn calls it every time (the throttle does not touch the injected path)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fthr-rec-'));
  fs.mkdirSync(path.join(dir, 'queue', 'done'), { recursive: true });
  let calls = 0;
  for (let i = 0; i < 3; i++) reconcile({ pipelineDir: dir, repoRoot: '/fake/repo', argv: [], fetchFn: () => { calls += 1; } });
  assert.equal(calls, 3);
});
