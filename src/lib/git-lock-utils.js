'use strict';

// git-lock-utils.js -- find and clear STALE git ref locks in an apply clone, synchronously.
//
// Why: a git process that dies mid-fetch can leave a 0-byte `.git/refs/remotes/origin/<branch>.lock`. Git then refuses every later fetch with "cannot lock ref ... File exists"
// and nothing removes the file, so every apply blocks until a person deletes it (seen 2026-09-29: eleven failures in an hour).
//
// How a lock is judged stale -- NOT by a pid. A ref lock holds the new object id (or nothing yet), never the holder's pid, so reading a pid out of it cannot tell a dead holder from
// a live one, and an empty lock is exactly what a live fetch has just created. A lock is removed only when BOTH hold:
//   1. it is at least MIN_STALE_AGE_MS old (default 5 minutes; a live fetch is killed at 60 s, or 180 s on its one retry, and a ref lock is held for milliseconds), and
//   2. no `git` process has the repo as its working directory (read from /proc; if /proc cannot be read the lock is treated as possibly live and is left alone).
// Anything unclear leaves the lock in place; the fetch then fails exactly as it did before.

const fs = require('fs');
const path = require('path');

const MIN_STALE_AGE_MS = 5 * 60_000;

// True when some process named `git` has `repoRoot` as its cwd. Returns null when that cannot be determined.
function gitRunningIn(repoRoot, { procRoot = '/proc' } = {}) {
  let pids;
  try { pids = fs.readdirSync(procRoot).filter((n) => /^\d+$/.test(n)); } catch { return null; }
  const want = path.resolve(repoRoot);
  for (const pid of pids) {
    try {
      if (fs.readFileSync(path.join(procRoot, pid, 'comm'), 'utf8').trim() !== 'git') continue;
      if (fs.readlinkSync(path.join(procRoot, pid, 'cwd')) === want) return true;
    } catch { /* the process exited, or is not ours to inspect: not evidence either way */ }
  }
  return false;
}

// Every `*.lock` file under refs/remotes/origin, plus packed-refs.lock (fetch --prune takes it).
function findRefLockFiles(repoRoot) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.lock')) found.push(full);
    }
  };
  walk(path.join(repoRoot, '.git', 'refs', 'remotes', 'origin'));
  const packed = path.join(repoRoot, '.git', 'packed-refs.lock');
  if (fs.existsSync(packed)) found.push(packed);
  return found;
}

/**
 * Remove every stale ref lock in `repoRoot`. Never throws.
 * @returns {{removed: string[], kept: {path: string, reason: string}[]}}
 */
function clearStaleRefLocks(repoRoot, { now = Date.now, minAgeMs = MIN_STALE_AGE_MS, gitRunning = gitRunningIn } = {}) {
  const removed = [];
  const kept = [];
  const locks = findRefLockFiles(repoRoot);
  if (!locks.length) return { removed, kept };
  const running = gitRunning(repoRoot);   // one scan for all the locks
  for (const lockPath of locks) {
    let ageMs;
    try { ageMs = now() - fs.statSync(lockPath).mtimeMs; } catch { continue; }   // already gone
    if (ageMs < minAgeMs) { kept.push({ path: lockPath, reason: `only ${Math.round(ageMs / 1000)} s old` }); continue; }
    if (running !== false) { kept.push({ path: lockPath, reason: running ? 'a git process is running in the repo' : 'could not check for running git processes' }); continue; }
    try { fs.unlinkSync(lockPath); removed.push(lockPath); } catch (e) { kept.push({ path: lockPath, reason: `could not remove: ${e.message}` }); }
  }
  return { removed, kept };
}

module.exports = { MIN_STALE_AGE_MS, gitRunningIn, findRefLockFiles, clearStaleRefLocks };
