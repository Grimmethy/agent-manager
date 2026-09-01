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
// task's PLAN pass through the local model (genuinely needs this lock) then unconditionally
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
//
// ---------------------------------------------------------------------------------------
// 2026-08-31: two fairness/correctness fixes, after task
// adhoc-brain-dump-agent-manager-blocked-task-done-task-bra-1788142124203 made 19 draft
// attempts over ~11.5h and blocked every time on a 600s lock timeout. Root cause was
// TWO bugs (see brain dump "GPU single-flight lock: replace the unfair flock(2) mutex
// with a FIFO ticket lock"):
//
//   (1) SELF-DEADLOCK / non-reentrancy. draftAdhocBranch() wraps a tier in
//       maybeLocked(...) -> withLock(dir, fn, MODEL) which holds an fd on the lockfile
//       for the WHOLE tier. Inside fn, local-tool-client.js's runPlanWithTools() takes
//       withLock(dir, ..., MODEL) again PER TURN -- same process, same key, but a
//       DIFFERENT open file description -> flock(2) blocks the inner call against the
//       outer one for the full timeout, every turn. Empirically confirmed. Fixed here
//       with per-process reentrancy: a lock already held by THIS process for a given key
//       is re-granted immediately (depth-counted), released only when the outermost
//       holder releases.
//
//   (2) UNFAIRNESS. flock(2) gives no ordering guarantee -- waiters wake arbitrarily --
//       so under sustained contention a third consumer starves. In the incident,
//       worker-reasoning's tier lost the acquire race to worker-1 + the reviewer for
//       600s straight, every attempt. Fixed here with a FIFO ticket queue: a waiter
//       drops a lexically-time-ordered marker in instances/.pipeline-single-flight-queue
//       [.<model>]/ and only attempts the real flock once it holds the OLDEST live
//       ticket (dead-pid / stale tickets are swept). The final flock(2) is still the
//       real mutual-exclusion primitive; the queue just decides who attempts it next.
//
// NOT yet migrated: scripts/agent-manager-common.sh (review-runner) and
// python/dashboard/single_flight_lock.py (dashboard chat/Discuss) do NOT participate in
// the ticket queue -- they still contend on the final flock directly, so they can
// occasionally cut ahead of the JS worker FIFO. Acceptable for now: both hold the lock
// briefly (one review vote / one chat turn) and release. Full cross-language ticket
// participation is a fast-follow (same brain dump). All three twins still share the same
// final lockfile, so mutual exclusion and the Discuss-priority backoff are unaffected.
// Python's acquire() DID get bounded-wait parity here (it was still unbounded).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const LOCK_CHILD_FD = 3; // arbitrary -- just needs to not collide with the child's own 0/1/2

// Per-model locking (2026-08-25, Grimmethy: "boost throughput" -- see nullboiler's
// ConcurrencyConfig.per_role for the reference shape this borrows). Originally ONE
// lockfile for every local-model call regardless of which model it targeted, which meant
// a long call on the reasoning model (e.g. a big arch_review) blocked a completely
// unrelated cheap-model call (e.g. brain_dump_sort's qwen2.5:3b) for its entire duration
// even after OLLAMA_MAX_LOADED_MODELS=2 let both models stay resident in VRAM at once --
// confirmed live: this was the literal "worker-1 and reasoning are taking turns" report.
// `key` (typically the resolved model name, e.g. labelFor(task) for a local call) scopes
// the lockfile to that specific model, so two calls against DIFFERENT models no longer
// serialize against each other, while two calls against the SAME model still correctly
// do (same key -> same lockfile -> same flock). Omitting `key` preserves the exact
// original global lockfile name -- every caller not yet migrated to pass a key keeps
// today's behavior unchanged.
//
// UPDATE, 2026-08-25, same day: this comment used to say bash's own
// acquire_single_flight_lock/release_single_flight_lock (agent-manager-common.sh, used by
// review-runner.sh) was "intentionally NOT migrated" and that the gap for the common
// (no cheap-model-profile) case was "a known, accepted, low-frequency risk" because
// "Ollama's own llama-server still serializes same-model requests at its own -np 1 slot
// regardless." Confirmed live, same day, that assumption was wrong: reviewer (still on
// the old global lockfile) and worker-1 (already on this module's per-model one) hitting
// the SAME default model produced a real, repeating "timed out waiting for llama-server
// to start: context canceled" cycle in Ollama's own log -- concurrent LOAD attempts
// collide and get cancelled, not just generation slots, so this was the common case
// racing on every single review, not a rare edge case. agent-manager-common.sh's
// acquire_single_flight_lock now also accepts an optional key (same lockFileName scheme
// as here, kept in sync by hand) and review-runner.sh passes it $resolved_label -- the
// gap this comment used to describe as accepted is closed, not just documented.
function keySuffix(key) {
  if (!key) return '';
  // Model names can contain ':' (e.g. "qwen3.8:27b-q4_K_M") -- not filesystem-hostile on
  // Linux, but sanitized anyway so this never depends on a particular OS's path rules.
  return `.${String(key).replace(/[^A-Za-z0-9._-]+/g, '_')}`;
}

function lockFileName(key) {
  return `.pipeline-single-flight${keySuffix(key)}.lock`;
}

function lockFilePath(instancesDir, key) {
  return path.join(instancesDir, lockFileName(key));
}

// FIFO ticket queue directory (per model key, same suffix scheme as the lockfile).
function queueDirPath(instancesDir, key) {
  return path.join(instancesDir, `.pipeline-single-flight-queue${keySuffix(key)}`);
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
    if (e.code === 'ENOENT') {
      return false; // directory doesn't exist yet -- nobody has ever waited.
    }
    console.error(`[single-flight-lock] someoneIsWaiting: unexpected error reading ${priorityWaitDirPath(instancesDir)}: code=${e.code} message=${e.message}`);
    throw e;
  }
}

// 2026-08-27, root-caused live: this used to be a genuinely unbounded blocking acquire
// ("no timeout, no -n, matching the bash version exactly" -- see agent-manager-common.sh's
// own matching fix for the full incident). Confirmed via `lslocks`: the kernel reported
// this exact lockfile held by a PID that no longer existed -- some prior holder died in a
// way that left the flock() unreleased, and every real caller across all three daemons
// (bash and Node both, since they share one kernel-level lock -- see this file's own
// header) sat blocked for 20+ minutes with zero recovery path, stalling the whole
// pipeline. `-w` bounds the wait via the same underlying `flock` binary the bash version
// uses (interoperable timeout semantics, not just interoperable locking); a real, non-
// stale holder finishing well within this window is unaffected. On timeout, `flock`
// exits non-zero, execFileSync throws, and this function's own catch below closes the fd
// and rethrows -- callers already going through withLock() get that exception the normal
// way, which is exactly what its "MUST be released -- an uncaught throw ... would leak
// the fd" header already documents as the expected failure contract.
// Read at call time, not module-load time (a test needs to override it per-call via
// process.env without needing a fresh require of this module each time).
function lockTimeoutSecs() {
  return Number(process.env.SINGLE_FLIGHT_LOCK_TIMEOUT_SECS) || 600;
}

// ---- per-process reentrancy ----------------------------------------------------------
// A lock this process already holds for a given key is re-granted immediately, without
// touching flock/the queue, and released only when the OUTERMOST holder releases (see
// header bug (1)). Keyed by the resolved lock FILE PATH so two different models are
// tracked independently. This is per-process state only: a different process asking for
// the same key still goes through the real ticket queue + flock, so cross-process mutual
// exclusion is unchanged.
const held = new Map(); // lockFilePath -> { fd, depth }

function reentrantToken(lockPath) {
  return { __sflReentrant: true, lockPath };
}

// Sub-second sync sleep (this whole module blocks the calling process by design).
function sleepMs(ms) {
  try {
    execFileSync('sleep', [(ms / 1000).toFixed(3)]);
  } catch (e) {
    // `sleep` missing / interrupted -- fall back to a busy wait so the loop still paces.
    const until = Date.now() + ms;
    while (Date.now() < until) { /* spin */ }
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // exists but owned by someone else -- treat as alive
  }
}

// Remove tickets whose owning pid is gone, or that are older than the stale window (a
// leftover from a hard-killed process that never cleaned up). Best-effort: ENOENT races
// with another sweeper are ignored.
function sweepStaleTickets(qdir, staleMs, now) {
  let names;
  try {
    names = fs.readdirSync(qdir);
  } catch (e) {
    return;
  }
  for (const name of names) {
    const m = /^\d{20}\.(\d+)\./.exec(name);
    if (!m) continue; // not one of ours
    const full = path.join(qdir, name);
    let stale = !pidAlive(Number(m[1]));
    if (!stale) {
      try {
        stale = now - fs.statSync(full).mtimeMs > staleMs;
      } catch (e) {
        stale = true; // vanished under us -- nothing to keep
      }
    }
    if (stale) {
      try { fs.unlinkSync(full); } catch (e) { /* already gone */ }
    }
  }
}

function makeTimeoutError(key, timeoutSecs, detail) {
  // execFileSync's own error message is just "Command failed: flock -w 600 3" -- it
  // doesn't say WHY, and critically doesn't contain the word "timed out" that
  // local-worker.sh's/review-runner.sh's shared INFRA_FAILURE_PATTERN matches on to
  // decide "requeue and retry" vs "permanently block as a real content failure." A lock
  // timeout must read as infra-shaped, not as this task's own fault.
  return new Error(`single-flight lock acquisition timed out after ${timeoutSecs}s waiting for lock '${key || '(default)'}': ${detail}`);
}

const TICKET_POLL_MS = 500; // how often a not-yet-at-head waiter re-checks the queue (matches the 1s-ish granularity the discuss backoff already uses)
const FLOCK_ATTEMPT_SECS = 30; // per-attempt cap while at the head of the queue; loop until the overall deadline

// Blocking, exclusive acquire, bounded by SINGLE_FLIGHT_LOCK_TIMEOUT_SECS. Returns a
// handle to pass to release(): a real fd (number) for the outermost holder, or an opaque
// reentrant token if this process already holds the same key. Callers must not inspect
// the handle -- just pass it back to release().
function acquire(instancesDir, key) {
  const lp = lockFilePath(instancesDir, key);

  // Reentrant fast path -- this process already holds it (see header bug (1)).
  const existing = held.get(lp);
  if (existing) {
    existing.depth += 1;
    return reentrantToken(lp);
  }

  const timeoutSecs = lockTimeoutSecs();
  const overallDeadline = Date.now() + timeoutSecs * 1000;

  // Discuss priority: a user-interactive waiter (Python drops a marker in
  // .discuss-waiting/) gets a short head start to enter the queue before this lane does.
  const discussDeadline = Date.now() + DISCUSS_PRIORITY_MAX_WAIT_MS;
  while (someoneIsWaiting(instancesDir) && Date.now() < discussDeadline) {
    sleepMs(1000);
  }

  // Enqueue a FIFO ticket. Name = <20-digit ms><.pid><.rand> so a plain lexical sort is
  // chronological (all callers read the same wall clock -- localhost only).
  const qdir = queueDirPath(instancesDir, key);
  fs.mkdirSync(qdir, { recursive: true });
  const ticketName = `${String(Date.now()).padStart(20, '0')}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  const ticketPath = path.join(qdir, ticketName);
  fs.writeFileSync(ticketPath, '');

  const staleMs = timeoutSecs * 1000 * 2;
  try {
    for (;;) {
      if (Date.now() >= overallDeadline) {
        throw makeTimeoutError(key, timeoutSecs, 'never reached the head of the single-flight FIFO queue');
      }
      sweepStaleTickets(qdir, staleMs, Date.now());

      let headName;
      try {
        headName = fs.readdirSync(qdir).filter((n) => /^\d{20}\./.test(n)).sort()[0];
      } catch (e) {
        headName = ticketName; // dir vanished -- treat ourselves as first
      }
      if (headName && headName !== ticketName) {
        sleepMs(TICKET_POLL_MS);
        continue;
      }

      // We're at the head -- attempt the real flock. A non-participating bash/Python
      // caller (or a just-swept race) may still hold it; retry until the overall deadline.
      const remainingSecs = Math.max(1, Math.ceil((overallDeadline - Date.now()) / 1000));
      const attemptSecs = Math.min(FLOCK_ATTEMPT_SECS, remainingSecs);
      const fd = fs.openSync(lp, 'w');
      try {
        execFileSync('flock', ['-w', String(attemptSecs), String(LOCK_CHILD_FD)], { stdio: ['ignore', 'ignore', 'ignore', fd] });
      } catch (err) {
        fs.closeSync(fd);
        if (Date.now() >= overallDeadline) {
          throw makeTimeoutError(key, timeoutSecs, `held by another lane for the full wait (${err.message})`);
        }
        continue; // holder outlasted this attempt window -- re-check the queue and retry
      }
      held.set(lp, { fd, depth: 1 });
      return fd;
    }
  } finally {
    try { fs.unlinkSync(ticketPath); } catch (e) { /* already gone */ }
  }
}

// Releases a lock acquired above. Safe to call more than once, with null/undefined, or
// with an already-closed fd (best-effort, matching release_single_flight_lock()'s own
// `|| true`). For a reentrant token this just decrements the depth; the underlying fd is
// closed only when the outermost holder releases (depth hits 0).
function release(handle) {
  if (handle == null) return;

  if (typeof handle === 'object' && handle.__sflReentrant) {
    const e = held.get(handle.lockPath);
    if (e && e.depth > 0) e.depth -= 1;
    return;
  }

  // A raw fd (number) -- the outermost holder. Decrement its depth; close for real at 0.
  for (const [lp, e] of held) {
    if (e.fd === handle) {
      e.depth -= 1;
      if (e.depth <= 0) {
        try { fs.closeSync(e.fd); } catch (err) { /* already closed */ }
        held.delete(lp);
      }
      return;
    }
  }
  // Not tracked (already released, or an fd from a direct acquire predating this module's
  // reentrancy tracking) -- best-effort close, same as the old behavior.
  try { fs.closeSync(handle); } catch (err) { /* already closed */ }
}

// Preferred entry point: acquire, run fn, always release -- even if fn throws. Awaits fn
// (sync or async) and re-throws whatever it throws, after releasing.
async function withLock(instancesDir, fn, key) {
  const handle = acquire(instancesDir, key);
  try {
    return await fn();
  } finally {
    release(handle);
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
module.exports = { acquire, release, withLock, lockFilePath, queueDirPath };
