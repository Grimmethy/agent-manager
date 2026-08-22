'use strict';

// File-based "is a local-model call actually in flight right now" lock, closing the race
// should_yield_for_model_swap (agent-manager-common.sh) can't see on its own: that guard
// only counts queue/pending/ backlog for the resident tier, never queue/drafting/ (in-
// progress) work. If worker-1 claims the last low-tier pending task (moving it into
// drafting/) and is mid-generation on ornith:35b, pending-count for 'low' reads 0 -- a
// worker-reasoning tick landing at that exact moment sees "nothing left to finish" and
// proceeds straight to an Ollama call for a DIFFERENT model, with no VRAM headroom for
// both (confirmed live 2026-08-18: ~20.5GB used / 24GB total, ~3.5GB free with one model
// resident). Ollama then has to evict the in-progress model mid-request to fit the new
// one -- not just a reload-time cost, a real risk of corrupting/failing worker-1's live
// call.
//
// One file per in-flight call (not a single boolean in .active-local-model.json) so
// concurrent calls to the SAME model never race each other's lock lifecycle -- worker-1
// and reviewer both call ORNITH_MODEL directly and legitimately overlap; a single
// set/clear flag would have process A's `finally` clear the lock while process B's
// identical-model call is still running, reopening exactly the window this exists to
// close. should_yield_for_model_swap only cares whether ANY held lock names a model
// different from its own target -- same-model locks are invisible to it by construction.
//
// Locks self-heal from a crash (no matching finally ever runs -- e.g. a REQUEST_TIMEOUT_MS
// hang that kills the whole worker process, not just this call) via a staleness ceiling
// tied to ollama-http.js's own documented 5-minute FORMALIZED CEILING: nothing in this
// pipeline should legitimately hold a lock past that, so a lock older than STALE_MS is
// treated as abandoned and skipped by readActiveLocks(), never requiring a separate GC
// pass or process-liveness check.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STALE_MS = 5 * 60 * 1000; // matches ollama-http.js's FORMALIZED CEILING (no real call/hang should outlive this)

function locksDir(instancesDir) {
  return path.join(instancesDir, '.model-locks');
}

// Acquires a lock for `model`, returning the lock's file path (pass to release()). Never
// throws -- a locks-dir mkdir/write failure degrades to "no lock held" (the guard then
// falls back to its existing pending-count check) rather than blocking the real Ollama
// call this wraps, same "a check failing here must never block real work" rule gpu-guard.js
// documents for itself.
function acquire(instancesDir, model, instanceId) {
  const dir = locksDir(instancesDir);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const lockPath = path.join(dir, `${Date.now()}-${crypto.randomUUID()}.json`);
    fs.writeFileSync(lockPath, JSON.stringify({ model, instanceId: instanceId || null, pid: process.pid, startedAt: new Date().toISOString() }));
    return lockPath;
  } catch (err) {
    console.warn('[inflight-lock] acquire failed', { model, instanceId, code: err.code, message: err.message });
    return null;
  }
}

// Releases a lock acquired above. Safe to call with null (acquire() failure) or on an
// already-removed file (e.g. manually cleared while debugging).
function release(lockPath) {
  if (!lockPath) return;
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // already gone -- nothing to do.
  }
}

// Returns the list of { model, instanceId, pid, startedAt } for every currently-held,
// non-stale lock. Consumed by agent-manager-common.sh's should_yield_for_model_swap via a
// `node -e` one-liner, same "compute it once in JS, consume it from bash" split
// pendingTierCounts() (task-sources.js) already uses.
function readActiveLocks(instancesDir) {
  const dir = locksDir(instancesDir);
  let names;
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    console.error('[inflight-lock] readdir(' + dir + ') failed:', err);
    throw err;
  }
  const now = Date.now();
  const active = [];
  for (const name of names) {
    const fullPath = path.join(dir, name);
    try {
      const stat = fs.statSync(fullPath);
      if (now - stat.mtimeMs > STALE_MS) continue; // abandoned -- a crashed call that never released
      const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      if (data && data.model) active.push(data);
    } catch {
      // unreadable/mid-write/vanished between readdir and read -- skip, not fatal.
    }
  }
  return active;
}

module.exports = { acquire, release, readActiveLocks, locksDir, STALE_MS };
