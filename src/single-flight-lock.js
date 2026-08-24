'use strict';

// Node-native equivalent of agent-manager-common.sh's acquire_single_flight_lock()/
// release_single_flight_lock() -- same real flock(2) mutex, same lockfile
// (instances/.pipeline-single-flight.lock), fully interoperable with the bash version
// worker-1/reviewer still use (confirmed live 2026-08-22: a Node-held lock correctly
// blocks a separate bash `exec 200>file; flock 200` process, and releases it the instant
// Node closes its own fd -- flock(2) locks are owned by the OPEN FILE DESCRIPTION, not
// the process, so this works precisely because both sides open the SAME file).
//
// Built to fix a real, observed problem (2026-08-22, Grimmethy: "build [a real plan/
// implement lock split] now"): local-draft.js's draftTask() runs an adhoc/research
// task's PLAN pass through local Ornith (genuinely needs this lock) then unconditionally
// bypasses to a real Claude call for IMPLEMENT (never touches the local GPU at all) --
// but the OLD bash-level lock in local-worker.sh had to choose ONE lock decision for the
// whole `node local-draft.js` call, so it either protected the plan pass and then kept
// holding the lock through the long Claude call too (needless cross-lane contention,
// confirmed live: real "Ollama request timed out after ~130s" plan-stage failures caused
// by exactly this), or skipped the lock entirely and left the plan pass unprotected
// (the earlier, WORSE bug this session already found and reverted). This module lets
// draftTask() hold the lock ONLY around the specific local-model call that actually
// needs it, released immediately afterward -- local-worker.sh no longer does any
// lock-wrapping of its own for the draft stage at all (see its own updated comment).
//
// A held lock here MUST be released -- an uncaught throw between acquire() and release()
// would leak the fd and deadlock every other lane forever. Callers should always use
// withLock() below rather than acquire()/release() directly unless they have a very
// specific reason not to (release() is still exported for that rare case).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const LOCK_CHILD_FD = 3; // arbitrary -- just needs to not collide with the child's own 0/1/2

function lockFilePath(instancesDir) {
  return path.join(instancesDir, '.pipeline-single-flight.lock');
}

// 2026-08-24 (Grimmethy: "move the user interaction to the highest priority possible...
// if a user interaction shows up, it's next") -- same .discuss-waiting/ advisory
// directory agent-manager-common.sh's acquire_single_flight_lock() now checks (Python's
// single_flight_lock.py drops one marker file per waiting Discuss session in here),
// mirrored here so worker-1/worker-reasoning's OWN acquire (via draftTask()'s
// withLockFn, this module, not the bash function) also backs off instead of immediately
// reclaiming the lock for its next queued task the moment the current holder releases.
// Can't interrupt an in-flight call (and shouldn't -- that would waste real work), so
// this only affects who wins the race to acquire NEXT. A directory of per-waiter files,
// not one shared flag, so a second concurrent Discuss session's priority isn't silently
// cleared the instant the first one gets the lock.
const DISCUSS_PRIORITY_DIR_NAME = '.discuss-waiting';
const DISCUSS_PRIORITY_MAX_WAIT_MS = 8000;

function priorityWaitDirPath(instancesDir) {
  return path.join(instancesDir, DISCUSS_PRIORITY_DIR_NAME);
}

function someoneIsWaiting(instancesDir) {
  try {
    return fs.readdirSync(priorityWaitDirPath(instancesDir)).length > 0;
  } catch (e) {
    return false; // directory doesn't exist yet -- nobody has ever waited.
  }
}

// Blocking, exclusive acquire -- no timeout, no -n, matching the bash version exactly
// (a caller that wants a bounded wait should wrap this in its own timeout, this function
// itself will wait as long as it takes, same as flock's own default). Returns a real fd;
// pass it to release().
function acquire(instancesDir) {
  const deadline = Date.now() + DISCUSS_PRIORITY_MAX_WAIT_MS;
  while (someoneIsWaiting(instancesDir) && Date.now() < deadline) {
    execFileSync('sleep', ['1']);
  }
  const fd = fs.openSync(lockFilePath(instancesDir), 'w');
  try {
    execFileSync('flock', [String(LOCK_CHILD_FD)], { stdio: ['ignore', 'ignore', 'ignore', fd] });
  } catch (err) {
    fs.closeSync(fd);
    throw err;
  }
  return fd;
}

// Releases a lock acquired above. Safe to call more than once or with an already-closed
// fd (best-effort, matching release_single_flight_lock()'s own `|| true`).
function release(fd) {
  if (fd == null) return;
  try {
    fs.closeSync(fd);
  } catch {
    // already closed -- nothing to do.
  }
}

// Preferred entry point: acquire, run fn, always release -- even if fn throws. Awaits fn
// (sync or async) and re-throws whatever it throws, after releasing.
async function withLock(instancesDir, fn) {
  const fd = acquire(instancesDir);
  try {
    return await fn();
  } finally {
    release(fd);
  }
}

// 2026-08-24 (Grimmethy: "add the lock work" for a live Discuss/worker-1 contention bug)
// -- python/dashboard/single_flight_lock.py is the dashboard-side twin of this file,
// letting Discuss's LOCAL provider join the exact same GPU/model-slot mutex worker-1 and
// reviewer already use. Deliberately did NOT add an equivalent lock for Claude calls
// (worker-reasoning / Discuss's Claude provider): unlike Ollama's single resident model,
// the Claude Code subscription has no real single-execution-slot constraint -- separate
// `claude -p` calls already run genuinely concurrently (the same way two independent
// Claude Code sessions do), bounded only by Anthropic's own account-level rate limits, not
// a local hardware bottleneck. Forcing them through a mutex here would have been a real
// regression, not a fix: a multi-minute adhoc draft (real Bash/Edit/Write investigation)
// would block a live chat, or vice versa, for a resource conflict that doesn't actually
// exist.
module.exports = { acquire, release, withLock, lockFilePath };
