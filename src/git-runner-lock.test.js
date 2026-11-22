'use strict';

// A fetch clears stale ref locks before each attempt and is retried on a ref-lock error, synchronously, within three attempts in total. Fake exec and fake sleep: no real fetch,
// no real waiting. The repo is a real throwaway one so the lock files are real; lock age and "is git running" are injected.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createRealGitRunner } = require('./git-runner.js');
const { MIN_STALE_AGE_MS } = require('./lib/git-lock-utils.js');

function realRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitlock-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@x'); g('config', 'user.name', 'T');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n'); g('add', '.'); g('commit', '-q', '-m', 'init');
  fs.mkdirSync(path.join(dir, '.git', 'refs', 'remotes', 'origin'), { recursive: true });
  return dir;
}
const lockPathIn = (repo) => path.join(repo, '.git', 'refs', 'remotes', 'origin', 'main.lock');
const makeLock = (repo, ageMs) => { const p = lockPathIn(repo); fs.writeFileSync(p, ''); const t = (Date.now() - ageMs) / 1000; fs.utimesSync(p, t, t); return p; };
const timeoutError = () => Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' });
const lockError = () => Object.assign(new Error("fatal: cannot lock ref 'refs/remotes/origin/main': Unable to create '/x/.git/refs/remotes/origin/main.lock': File exists."), { status: 128 });
const otherError = () => Object.assign(new Error('fatal: could not read from remote'), { status: 128 });
const OLD = MIN_STALE_AGE_MS + 60_000;

// outcomes: 'ok' | 'timeout' | 'lock' | 'fail'. Each call records whether the lock file existed AT THAT MOMENT.
function setup(outcomes, { lockAge, gitRunning = () => false } = {}) {
  const repo = realRepo();
  if (lockAge !== undefined) makeLock(repo, lockAge);
  const calls = [];
  const exec = (cmd, args, opts) => {
    calls.push({ args, timeout: opts.timeout, lockPresent: fs.existsSync(lockPathIn(repo)) });
    const o = outcomes[calls.length - 1] || 'ok';
    if (o === 'timeout') throw timeoutError();
    if (o === 'lock') throw lockError();
    if (o === 'fail') throw otherError();
    return '';
  };
  const slept = [];
  const runner = createRealGitRunner(repo, { exec, sleepMs: (ms) => slept.push(ms), lockOpts: { gitRunning } });
  calls.length = 0; // detectDefaultBranch ran real git above
  return { runner, calls, slept, repo };
}

test('an OLD lock with no git running is removed before the fetch runs', () => {
  const w = setup(['ok'], { lockAge: OLD });
  w.runner.fetchMain();
  assert.equal(w.calls.length, 1);
  assert.equal(w.calls[0].lockPresent, false);
});

test('a YOUNG lock is left alone and the fetch is still attempted once', () => {
  const w = setup(['ok'], { lockAge: 1000 });
  w.runner.fetchMain();
  assert.equal(w.calls.length, 1);
  assert.equal(w.calls[0].lockPresent, true);
});

test('an old lock is left alone while a git process is running in the repo', () => {
  const w = setup(['ok'], { lockAge: OLD, gitRunning: () => true });
  w.runner.fetchMain();
  assert.equal(w.calls[0].lockPresent, true);
});

test('a lock error on the first attempt and success on the second returns after one backoff', () => {
  const w = setup(['lock', 'ok']);
  w.runner.fetchMain();
  assert.equal(w.calls.length, 2);
  assert.deepEqual(w.slept, [1000]);
});

test('three lock errors throw the last one after exactly three attempts, backing off 1 s then 2 s', () => {
  const w = setup(['lock', 'lock', 'lock', 'ok']);
  assert.throws(() => w.runner.fetchMain(), /cannot lock ref/);
  assert.equal(w.calls.length, 3);
  assert.deepEqual(w.slept, [1000, 2000]);
});

test('the stale-lock removal runs before EVERY attempt: a lock that appears after attempt 1 is gone before attempt 2', () => {
  const repo = realRepo();
  const seen = [];
  const exec = () => {
    seen.push(fs.existsSync(lockPathIn(repo)));
    if (seen.length === 1) { makeLock(repo, OLD); throw lockError(); }
    return '';
  };
  const runner = createRealGitRunner(repo, { exec, sleepMs: () => {}, lockOpts: { gitRunning: () => false } });
  seen.length = 0;
  runner.fetchMain();
  assert.deepEqual(seen, [false, false]);
});

test('a command that is not a fetch is never retried on a lock error and never touches locks', () => {
  const w = setup(['lock', 'ok'], { lockAge: OLD });
  assert.throws(() => w.runner.checkoutMain(), /cannot lock ref/);
  assert.equal(w.calls.length, 1);
  assert.deepEqual(w.slept, []);
  assert.equal(w.calls[0].lockPresent, true, 'only a fetch pre-clears locks');
});

test('a fetch that fails for another reason is not retried and does not wait', () => {
  const w = setup(['fail', 'ok']);
  assert.throws(() => w.runner.fetchMain(), /could not read from remote/);
  assert.equal(w.calls.length, 1);
  assert.deepEqual(w.slept, []);
});

test('timeout, lock error, timeout: three attempts in total, the last throws the annotated timeout naming the longer limit', () => {
  const w = setup(['timeout', 'lock', 'timeout', 'ok']);
  assert.throws(() => w.runner.fetchMain(), /git fetch origin main timed out after 180000ms \(ETIMEDOUT\)/);
  assert.equal(w.calls.length, 3);
  assert.deepEqual(w.calls.map((c) => c.timeout), [60000, 180000, 180000]);
  assert.deepEqual(w.slept, [2000, 2000], 'the timeout pause, then the lock backoff after attempt 2 (1 s x 2)');
});

test('a second timeout is not retried even when attempts remain (the timeout retry is once)', () => {
  const w = setup(['timeout', 'timeout', 'ok']);
  assert.throws(() => w.runner.fetchMain(), /timed out after 180000ms/);
  assert.equal(w.calls.length, 2);
});

test('a lock error and then a timeout: the timeout still gets its one longer retry', () => {
  const w = setup(['lock', 'timeout', 'ok']);
  w.runner.fetchMain();
  assert.deepEqual(w.calls.map((c) => c.timeout), [60000, 60000, 180000]);
});

// The original failure, end to end with REAL git and the real process scan: a 0-byte, hours-old origin/main.lock makes a plain fetch fail; the runner clears it and fetches.
test('real git: a stale 0-byte origin/main.lock is cleared and the fetch succeeds; a young one is kept and the fetch fails as before', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gitlock-real-'));
  const g = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' });
  const remote = path.join(base, 'remote.git'); const clone = path.join(base, 'clone');
  g(base, 'init', '-q', '--bare', '-b', 'main', remote);
  g(base, 'clone', '-q', remote, clone);
  g(clone, 'config', 'user.email', 't@x'); g(clone, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(clone, 'a.txt'), 'a\n'); g(clone, 'add', '.'); g(clone, 'commit', '-q', '-m', 'one'); g(clone, 'push', '-q', 'origin', 'main');
  // A second commit pushed from elsewhere, so a fetch in `clone` has to UPDATE origin/main (a fetch with nothing to update never takes the ref lock).
  const other = path.join(base, 'other'); g(base, 'clone', '-q', remote, other);
  g(other, 'config', 'user.email', 't@x'); g(other, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(other, 'b.txt'), 'b\n'); g(other, 'add', '.'); g(other, 'commit', '-q', '-m', 'two'); g(other, 'push', '-q', 'origin', 'main');
  const lock = path.join(clone, '.git', 'refs', 'remotes', 'origin', 'main.lock');
  const runner = createRealGitRunner(clone, { sleepMs: () => {} });

  fs.writeFileSync(lock, ''); const old = (Date.now() - OLD) / 1000; fs.utimesSync(lock, old, old);
  assert.throws(() => execFileSync('git', ['fetch', 'origin', 'main'], { cwd: clone, stdio: 'pipe' }), /cannot lock ref/, 'precondition: a plain fetch is blocked by the lock');
  runner.fetchMain();
  assert.equal(fs.existsSync(lock), false, 'the stale lock was removed');

  fs.writeFileSync(path.join(other, 'c.txt'), 'c\n'); g(other, 'add', '.'); g(other, 'commit', '-q', '-m', 'three'); g(other, 'push', '-q', 'origin', 'main');
  fs.writeFileSync(lock, '');   // fresh: mtime now
  assert.throws(() => runner.fetchMain(), /cannot lock ref/, 'a young lock is not touched; after three attempts the git error comes through');
  assert.equal(fs.existsSync(lock), true);
});
