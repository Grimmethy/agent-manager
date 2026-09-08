'use strict';

// The single owner of local-model (GPU) access. Every lane that calls the resident model
// -- worker draft, reviewer vote, chat/Discuss turn -- goes through here instead of each
// re-deriving "may I run now?" from six advisory files on its own unsynchronised tick
// (see the "Worker Queue Under One GPU" analysis). The arbiter is built ON TOP of
// single-flight-lock.js's kernel flock (still the real mutual exclusion); what it adds:
//
//   1. PRIORITY CLASSES. interactive > review > draft > audit. A waiter proceeds only
//      when no ticket of a HIGHER class exists and it holds the earliest ticket of its
//      OWN class. Lower classes never block a higher one -- they yield.
//   2. CROSS-PROCESS CANCELLATION. cancelBelow(cls) marks every lower-class ticket
//      `cancelRequested` and SIGKILLs any that is actively holding; the holder's daemon
//      requeues its task. This replaces _preempt_pipeline_for_chat's heartbeat/pidfile/
//      mtime archaeology with one call.
//   3. ONE VIEW. status() reads every ticket -> who holds, who waits, per class. The
//      dashboard reads this instead of stitching .model-locks + heartbeats + pidfiles.
//
// Tickets are files under <instancesDir>/.gpu-tickets<.key>/ -- same filesystem-durable
// discipline as queue/ and instances/. A ticket is <seq-ms>.<pid>.<rand>.json holding
// { pid, cls, taskId, phase, startedAt, holding, cancelRequested }, re-touched by its
// owner every REFRESH_MS; one not refreshed within TICKET_STALE_MS (or whose pid is gone)
// is swept by any reader.
//
// Retires: single-flight-lock.js's .discuss-waiting marker protocol + AGENT_MANAGER_
// PRIORITY_HOLDER, the FIFO-ticket duplication in agent-manager-common.sh /
// single_flight_lock.py, and the body of _preempt_pipeline_for_chat.
//
// lockKey vs model (2026-09-08, Grimmethy: "fix worker-1" -- root-caused live: worker-1's
// qwen2.5:3b calls hit OLLAMA_TIMEOUT dozens of times in a row while worker-reasoning's
// qwen3.8:27b-q4_K_M generated concurrently on the SAME physical GPU, 96% util). Every
// ticket/lock function below defaults its serialization key to `model` -- deliberate,
// 2026-08-25 (see single-flight-lock.js's own header): two DIFFERENT models were made to
// stop serializing against each other at all, on the assumption that once both fit in
// resident VRAM (OLLAMA_MAX_LOADED_MODELS=2) they don't meaningfully contend. Confirmed
// FALSE under real sustained load: concurrent generation on one physical GPU is COMPUTE-
// bound, not just VRAM-bound, and a light model can be starved into hard timeouts by a
// heavy one regardless of which two models they are. `lockKey`, when a caller passes it,
// overrides `model` as the actual serialization key while `model` is still stored/shown
// as ticket metadata -- local-draft.js's two draft-class call sites now pass the resolved
// Ollama ENDPOINT (OLLAMA_URL) as lockKey, so any two local models sharing that one
// endpoint correctly serialize against each other again, while a call to a genuinely
// separate endpoint (e.g. the P40 VM's AGENT_MANAGER_P40_OLLAMA_URL) still runs fully
// independently, unaffected. Every caller that omits lockKey keeps today's per-model
// behavior unchanged (interactive chat, holdPlace, the CLI's cancel-below/status).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sfl = require('./single-flight-lock.js');

// Compat shim (2026-09-02): the bash reviewer (agent-manager-common.sh) still checks
// single-flight-lock.js's .discuss-waiting/ markers to yield for a user-interactive
// waiter. Until the reviewer moves onto the arbiter, an `interactive`-class ticket also
// drops one of those markers so that check keeps working with no bash change. Remove this
// shim (and the bash check) in the stage that migrates the reviewer.
//
// The marker MUST be re-touched well inside single-flight-lock.js's DISCUSS_MARKER_FRESH_MS
// (15s) window, or the bash lane sees it go stale between touches and grabs the lock anyway
// -- caught live 2026-09-02: a REFRESH_MS (20s) re-touch left a 5s stale gap every cycle and
// the looping reviewer escaped through it, starving the chat turn. Own a dedicated 5s
// refresher here (matching single_flight_lock.py's priority_marker thread) rather than
// riding the caller's slower ticket-touch interval.
const COMPAT_REFRESH_MS = 5_000;
function interactiveCompatMarker(instancesDir, cls) {
  if (cls !== 'interactive') return { refresh() {}, remove() {} };
  let m = null;
  try { m = sfl.dropPriorityMarker(instancesDir); } catch (err) { console.warn('interactiveCompatMarker: dropPriorityMarker failed:', err); m = null; }
  const iv = m ? setInterval(() => {
    try { sfl.refreshPriorityMarker(m); } catch (err) { console.warn('interactiveCompatMarker: refreshPriorityMarker (interval) failed:', err); }
  }, COMPAT_REFRESH_MS) : null;
  if (iv && typeof iv.unref === 'function') iv.unref();
  return {
    refresh() { try { if (m) sfl.refreshPriorityMarker(m); } catch (err) { console.warn('interactiveCompatMarker: refreshPriorityMarker (refresh) failed:', err); } },
    remove() {
      if (iv) clearInterval(iv);
      try { if (m) sfl.removePriorityMarker(m); } catch { /* gone */ }
    },
  };
}

const CLASS_RANK = Object.freeze({ interactive: 0, review: 1, draft: 2, audit: 3 });
const DEFAULT_CLASS = 'draft';

const TICKETS_DIRNAME = '.gpu-tickets';
const POLL_MS = 400;                 // how often a waiter re-checks the ticket field
const TICKET_STALE_MS = 90_000;      // a ticket not re-touched in this long is abandoned
const REFRESH_MS = 20_000;           // holder/waiter re-touches its own ticket this often
const CANCEL_KILL_GRACE_MS = 1500;   // after marking cancelRequested, wait this long for a
                                     // cooperative exit before SIGKILL

function overallTimeoutMs() {
  const s = Number(process.env.SINGLE_FLIGHT_LOCK_TIMEOUT_SECS);
  return (Number.isFinite(s) && s > 0 ? s : 600) * 1000;
}

function classRank(cls) {
  return Object.prototype.hasOwnProperty.call(CLASS_RANK, cls) ? CLASS_RANK[cls] : CLASS_RANK[DEFAULT_CLASS];
}

// Same key-suffix scheme single-flight-lock.js uses, so the ticket dir and the lockfile
// for a given key stay side by side and consistently named. `key` is the resolved
// serialization key (lockKey when a caller passes one, else the bare model name -- see
// this file's own header for why those can now differ).
function keySuffix(key) {
  if (!key) return '';
  return '.' + String(key).replace(/[^A-Za-z0-9._-]+/g, '_');
}

function ticketsDir(instancesDir, key) {
  return path.join(instancesDir, TICKETS_DIRNAME + keySuffix(key));
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function safeUnlink(fp) {
  try { fs.unlinkSync(fp); } catch { /* raced / already gone */ }
}

function parseSeq(name) {
  const m = /^(\d+)\./.exec(name);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

function readTicket(fp) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; }
}

function writeTicketAtomic(fp, data) {
  const tmp = `${fp}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, fp);
}

// Every live ticket for this key (fresh mtime + live pid), oldest seq first. Sweeps the
// abandoned ones it passes -- any reader keeps the dir clean, same as
// single-flight-lock.js's sweepStaleTickets.
function liveTickets(instancesDir, key) {
  const dir = ticketsDir(instancesDir, key);
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const now = Date.now();
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const fp = path.join(dir, name);
    let st;
    try { st = fs.statSync(fp); } catch { continue; }
    const t = readTicket(fp);
    if (!t || !t.pid) { safeUnlink(fp); continue; }
    if (now - st.mtimeMs > TICKET_STALE_MS || !pidAlive(t.pid)) { safeUnlink(fp); continue; }
    out.push({ ...t, _name: name, _fp: fp, _seq: parseSeq(name) });
  }
  out.sort((a, b) => a._seq - b._seq);
  return out;
}

function touch(fp) {
  try { const now = new Date(); fs.utimesSync(fp, now, now); } catch { /* gone */ }
}

function patchTicket(fp, patch) {
  const cur = readTicket(fp);
  if (!cur) return;
  try { writeTicketAtomic(fp, { ...cur, ...patch }); } catch (err) { console.warn(`[gpu-arbiter] ticket write failed (best-effort, continuing) fp=${fp} state=${JSON.stringify({ ...cur, ...patch }).slice(0, 200)} err=${err.message}`); }
}

function nowIso() { return new Date().toISOString(); }

// Synchronous sleep -- this module blocks the calling process by design, same as
// single-flight-lock.js. Atomics.wait on a throwaway shared buffer that is never notified
// just times out after `ms`.
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* spin fallback if SharedArrayBuffer is unavailable */ }
  }
}

// ---- the primary API --------------------------------------------------------------------

// Register a ticket and block (busy-wait with sleeps, like single-flight-lock.js -- this
// whole module blocks the calling process by design) until this ticket may proceed:
// no higher-priority-class ticket exists, and this is the earliest ticket of its own
// class. Then acquire the underlying flock. Returns a handle:
//   { release(), cancelled: () => boolean }
// The caller MUST call handle.release() (use withGpu() to make that automatic). While
// holding, a background interval re-touches the ticket and, if cancelRequested lands,
// invokes onCancel() exactly once -- the caller wires that to abort its model call.
function acquire(instancesDir, { cls = DEFAULT_CLASS, model, lockKey, taskId = null, phase = null, onCancel = null } = {}) {
  // lockKey overrides model as the actual serialization key when a caller passes one
  // (see this file's own header) -- model is still carried on the ticket as metadata.
  const key = lockKey || model;
  const dir = ticketsDir(instancesDir, key);
  fs.mkdirSync(dir, { recursive: true });

  const myRank = classRank(cls);
  const seq = String(Date.now()).padStart(16, '0');
  const name = `${seq}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.json`;
  const fp = path.join(dir, name);
  const mySeqNum = Number(seq);

  writeTicketAtomic(fp, {
    pid: process.pid, cls, taskId, phase, model,
    startedAt: nowIso(), holding: false, cancelRequested: false,
  });

  // If this pid already holds a place ticket (holdPlace) of equal-or-higher priority for
  // this key, FIFO position is already reserved -- an inner per-turn acquire must not
  // re-queue behind peers that arrived AFTER the place (that would deadlock: the place
  // blocks those peers, and those peers would block this turn). Skip the wait loop; the
  // real flock still serialises the actual model call.
  const holdsPlace = liveTickets(instancesDir, key).some(
    (t) => t.pid === process.pid && t.place && classRank(t.cls) <= myRank,
  );

  const deadline = Date.now() + overallTimeoutMs();

  try {
    for (;;) {
      if (holdsPlace) break;
      if (Date.now() >= deadline) {
        safeUnlink(fp);
        throw new Error(`gpu-arbiter: '${cls}' ticket for '${key || '(default)'}' timed out waiting to reach the head of the queue`);
      }
      touch(fp);
      const tickets = liveTickets(instancesDir, key);
      const mine = tickets.find((t) => t._name === name);
      if (!mine) {
        // our ticket was swept (we were too slow to re-touch, or a clock jump) -- re-add.
        writeTicketAtomic(fp, { pid: process.pid, cls, taskId, phase, model, startedAt: nowIso(), holding: false, cancelRequested: false });
        continue;
      }
      if (mine.cancelRequested) {
        safeUnlink(fp);
        const err = new Error('gpu-arbiter: cancelled while waiting');
        err.gpuArbiterCancelled = true;
        throw err;
      }
      const higherExists = tickets.some((t) => t._name !== name && t.pid !== process.pid && classRank(t.cls) < myRank);
      // A ticket owned by THIS pid at our own class (typically a holdPlace() place-holder
      // for a chat tool loop, or a re-added ticket after a sweep) is not a competitor --
      // this process already has its spot.
      const earlierPeer = tickets.some((t) => t._name !== name && t.pid !== process.pid
        && classRank(t.cls) === myRank && t._seq < mySeqNum);
      if (!higherExists && !earlierPeer) break;
      sleepSync(POLL_MS);
    }
  } catch (err) {
    safeUnlink(fp);
    throw err;
  }

  // At the head -- take the real mutex. skipPriorityBackoff: the ARBITER is the priority
  // mechanism now; sfl's own .discuss-waiting backoff would just make us wait on the
  // compat marker the arbiter itself drops for interactive tickets.
  const compat = interactiveCompatMarker(instancesDir, cls);
  let flockHandle;
  try {
    flockHandle = sfl.acquire(instancesDir, key, { skipPriorityBackoff: true });
  } catch (err) {
    compat.remove();
    safeUnlink(fp);
    throw err;
  }
  patchTicket(fp, { holding: true });

  let cancelled = false;
  let released = false;
  const watcher = setInterval(() => {
    if (released) return;
    touch(fp);
    compat.refresh();
    const cur = readTicket(fp);
    if (cur && cur.cancelRequested && !cancelled) {
      cancelled = true;
      if (typeof onCancel === 'function') {
        try { onCancel(); } catch { /* best-effort */ }
      }
    }
  }, REFRESH_MS);
  if (typeof watcher.unref === 'function') watcher.unref();

  return {
    release() {
      if (released) return;
      released = true;
      clearInterval(watcher);
      try { sfl.release(flockHandle); } catch { /* already released */ }
      compat.remove();
      safeUnlink(fp);
    },
    cancelled: () => cancelled,
  };
}

// acquire -> run fn -> always release. Re-throws whatever fn throws (including the
// cancellation error) after releasing.
async function withGpu(instancesDir, opts, fn) {
  const handle = acquire(instancesDir, opts);
  try {
    return await fn(handle);
  } finally {
    handle.release();
  }
}

// A place-holding ticket held across MANY separate acquire() calls -- the chat tool loop
// holds one for its whole run so a worker spawning between the loop's per-turn model
// calls still sees an interactive waiter and yields. The inner per-call acquire() sees
// this same-pid same-class earlier ticket and treats it as a peer it is already ahead of
// (earlierPeer only counts a LOWER seq, and this outer ticket has a lower seq, so...) --
// handled explicitly: an acquire() whose pid already owns an equal-or-higher-priority
// ticket skips the earlier-peer check for that ticket.
function holdPlace(instancesDir, { cls = 'interactive', model, lockKey, taskId = null, phase = 'session' } = {}) {
  const key = lockKey || model;
  const dir = ticketsDir(instancesDir, key);
  fs.mkdirSync(dir, { recursive: true });
  const seq = String(Date.now()).padStart(16, '0');
  const name = `${seq}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.hold.json`;
  const fp = path.join(dir, name);
  writeTicketAtomic(fp, { pid: process.pid, cls, taskId, phase, model, startedAt: nowIso(), holding: false, cancelRequested: false, place: true });
  const compat = interactiveCompatMarker(instancesDir, cls);
  const iv = setInterval(() => { touch(fp); compat.refresh(); }, REFRESH_MS);
  if (typeof iv.unref === 'function') iv.unref();
  let released = false;
  return {
    release() { if (released) return; released = true; clearInterval(iv); compat.remove(); safeUnlink(fp); },
    cancelled: () => { const t = readTicket(fp); return !!(t && t.cancelRequested); },
  };
}

// Mark every ticket whose class is strictly LOWER priority than `cls` as cancelRequested,
// and SIGKILL any that is actively holding after a short grace (the holder's daemon
// requeues its drafting task -- same net effect as the old preempt). Returns
// [{ pid, cls, taskId, action }].
function cancelBelow(instancesDir, model, cls) {
  const myRank = classRank(cls);
  const affected = [];
  for (const t of liveTickets(instancesDir, model)) {
    if (classRank(t.cls) <= myRank) continue;
    patchTicket(t._fp, { cancelRequested: true });
    affected.push({ pid: t.pid, cls: t.cls, taskId: t.taskId, holding: !!t.holding });
  }
  const holders = affected.filter((a) => a.holding && a.pid !== process.pid);
  if (holders.length) {
    const wake = Date.now() + CANCEL_KILL_GRACE_MS;
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, CANCEL_KILL_GRACE_MS); }
    catch { while (Date.now() < wake) { /* spin */ } }
    for (const h of holders) {
      if (!pidAlive(h.pid)) { h.action = 'exited'; continue; }
      try { process.kill(h.pid, 'SIGKILL'); h.action = 'killed'; }
      catch { h.action = 'kill-failed'; }
    }
  }
  for (const a of affected) if (!a.action) a.action = a.holding ? 'kill-skipped' : 'cancel-marked';
  return affected;
}

// { holder: {...}|null, waiting: [{cls, pid, taskId, phase, seq}] } for the dashboard.
function status(instancesDir, model) {
  const tickets = liveTickets(instancesDir, model);
  const holder = tickets.find((t) => t.holding) || null;
  const waiting = tickets
    .filter((t) => !t.holding && !t.place)
    .map((t) => ({ cls: t.cls, pid: t.pid, taskId: t.taskId, phase: t.phase, model: t.model, seq: t._seq }));
  return {
    holder: holder ? { cls: holder.cls, pid: holder.pid, taskId: holder.taskId, phase: holder.phase, model: holder.model, startedAt: holder.startedAt } : null,
    waiting,
  };
}

module.exports = {
  acquire, withGpu, holdPlace, cancelBelow, status,
  liveTickets, ticketsDir,
  CLASS_RANK, classRank,
};
