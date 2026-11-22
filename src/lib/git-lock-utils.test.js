'use strict';

// Stale ref-lock detection: age AND no git process in the repo. Real files in a throwaway dir; /proc is faked with a directory so no real process is inspected.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findRefLockFiles, clearStaleRefLocks, gitRunningIn, MIN_STALE_AGE_MS } = require('./git-lock-utils.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'glu-'));
function repoWithLocks(names = ['main.lock']) {
  const repo = tmp();
  const dir = path.join(repo, '.git', 'refs', 'remotes', 'origin');
  fs.mkdirSync(dir, { recursive: true });
  const paths = names.map((n) => { const p = path.join(dir, n); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, ''); return p; });
  return { repo, paths };
}
const ageIt = (p, ms) => { const t = (Date.now() - ms) / 1000; fs.utimesSync(p, t, t); };
// A fake /proc: each entry is { pid, comm, cwd }.
function fakeProc(entries) {
  const root = tmp();
  for (const e of entries) {
    const d = path.join(root, String(e.pid)); fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, 'comm'), `${e.comm}\n`); fs.symlinkSync(e.cwd, path.join(d, 'cwd'));
  }
  fs.mkdirSync(path.join(root, 'self')); // non-numeric entries are ignored
  return root;
}

test('findRefLockFiles finds nested .lock files under refs/remotes/origin and packed-refs.lock, and nothing else', () => {
  const { repo, paths } = repoWithLocks(['main.lock', 'agent/x.lock', 'main']);
  fs.writeFileSync(path.join(repo, '.git', 'packed-refs.lock'), '');
  fs.writeFileSync(path.join(repo, '.git', 'index.lock'), '');
  const found = findRefLockFiles(repo).sort();
  assert.deepEqual(found, [paths[0], paths[1], path.join(repo, '.git', 'packed-refs.lock')].sort());
  assert.deepEqual(findRefLockFiles(tmp()), [], 'a repo with no .git is not an error');
});

test('an old lock with no git process in the repo is removed', () => {
  const { repo, paths } = repoWithLocks();
  ageIt(paths[0], MIN_STALE_AGE_MS + 60_000);
  const r = clearStaleRefLocks(repo, { gitRunning: () => false });
  assert.deepEqual(r.removed, paths);
  assert.equal(fs.existsSync(paths[0]), false);
});

test('a YOUNG lock is kept even with no git process (an empty lock is what a live fetch has just made)', () => {
  const { repo, paths } = repoWithLocks();
  const r = clearStaleRefLocks(repo, { gitRunning: () => false });
  assert.deepEqual(r.removed, []);
  assert.match(r.kept[0].reason, /s old/);
  assert.equal(fs.existsSync(paths[0]), true);
});

test('an old lock is kept while a git process runs in the repo, and when that cannot be determined', () => {
  const { repo, paths } = repoWithLocks();
  ageIt(paths[0], MIN_STALE_AGE_MS + 60_000);
  assert.match(clearStaleRefLocks(repo, { gitRunning: () => true }).kept[0].reason, /git process is running/);
  assert.match(clearStaleRefLocks(repo, { gitRunning: () => null }).kept[0].reason, /could not check/);
  assert.equal(fs.existsSync(paths[0]), true);
});

test('the age limit is the boundary: just under is kept, at the limit is removed', () => {
  const { repo, paths } = repoWithLocks();
  const mtime = fs.statSync(paths[0]).mtimeMs;
  assert.equal(clearStaleRefLocks(repo, { now: () => mtime + MIN_STALE_AGE_MS - 1, gitRunning: () => false }).removed.length, 0);
  assert.equal(clearStaleRefLocks(repo, { now: () => mtime + MIN_STALE_AGE_MS, gitRunning: () => false }).removed.length, 1);
});

test('with no locks the process scan is not even run', () => {
  let scanned = 0;
  clearStaleRefLocks(tmp(), { gitRunning: () => { scanned++; return false; } });
  assert.equal(scanned, 0);
});

test('gitRunningIn: true only for a process named git whose cwd is this repo', () => {
  const repo = tmp(); const other = tmp();
  assert.equal(gitRunningIn(repo, { procRoot: fakeProc([{ pid: 11, comm: 'git', cwd: repo }]) }), true);
  assert.equal(gitRunningIn(repo, { procRoot: fakeProc([{ pid: 11, comm: 'git', cwd: other }]) }), false, 'git in another repo does not count');
  assert.equal(gitRunningIn(repo, { procRoot: fakeProc([{ pid: 11, comm: 'node', cwd: repo }]) }), false, 'a non-git process in the repo does not count');
  assert.equal(gitRunningIn(repo, { procRoot: fakeProc([]) }), false);
  assert.equal(gitRunningIn(repo, { procRoot: path.join(tmp(), 'missing') }), null, 'unreadable /proc is "unknown", not "no git"');
});
