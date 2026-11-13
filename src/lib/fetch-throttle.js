'use strict';

// fetch-throttle.js -- share ONE full `git fetch origin` per repository between the watchdog scripts that each used to run their own on every pass
// (ADR-0024: fewer git launches on the shared disk). Measured 2026-11-03: the watchdog launched `git fetch origin` plus its remote-https child ~17 times a minute.
//
//   fetchIfDue(repoRoot, { run, minIntervalS, force, now, stampDir, fsImpl, env }) -> { fetched, skipped, ageS }
//
// `run` performs the real fetch. It is skipped when the last SUCCESSFUL fetch of the same repository (by realpath) is younger than the interval
// (AGENT_MANAGER_FETCH_MIN_INTERVAL_S, default 45: two scripts in the same 60 s watchdog tick share one fetch, the next tick fetches again, so a reader is never
// more than one tick behind, exactly as before). The time of the last success is the mtime of a stamp file under /dev/shm/agent-manager-fetch-stamps/
// (AGENT_MANAGER_FETCH_STAMP_DIR overrides). A FAILED fetch writes no stamp and rethrows, so the caller's own catch behaves as before. `force: true` always fetches
// (for a caller an event has just told that a remote ref moved). An unwritable stamp directory means the fetch simply runs every time (the old behaviour).
// AGENT_MANAGER_FETCH_THROTTLE=off disables the whole thing.
//
// A stamp always means a FULL fetch (`git fetch origin`). Do not use this for a single-branch fetch: a main-only fetch must not make a caller that needs the
// agent/* branches skip its own (task-log-reconcile.js once classified live branches as abandoned from a stale view, and `abandoned` never self-heals).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_STAMP_DIR = '/dev/shm/agent-manager-fetch-stamps';

function intervalS(minIntervalS, env) {
  const n = Number(minIntervalS !== undefined && minIntervalS !== null ? minIntervalS : env.AGENT_MANAGER_FETCH_MIN_INTERVAL_S);
  return Number.isFinite(n) && n >= 0 ? n : 45;
}

function stampPath(repoRoot, stampDir, fsImpl) {
  let real = repoRoot;
  try { real = fsImpl.realpathSync(repoRoot); } catch { /* not on disk: use the path as given */ }
  return path.join(stampDir, crypto.createHash('sha1').update(real).digest('hex').slice(0, 16));
}

function fetchIfDue(repoRoot, { run, minIntervalS, force = false, now = Date.now(), stampDir, fsImpl = fs, env = process.env } = {}) {
  if (typeof run !== 'function') throw new TypeError('fetchIfDue needs a run function');
  if (String(env.AGENT_MANAGER_FETCH_THROTTLE || '').toLowerCase() === 'off') { run(); return { fetched: true, skipped: false, ageS: null }; }
  const dir = stampDir || env.AGENT_MANAGER_FETCH_STAMP_DIR || DEFAULT_STAMP_DIR;
  const stamp = stampPath(repoRoot, dir, fsImpl);
  const limitS = intervalS(minIntervalS, env);
  let ageS = null;
  if (!force) {
    try { ageS = (now - fsImpl.statSync(stamp).mtimeMs) / 1000; } catch { ageS = null; }
    if (ageS !== null && ageS >= 0 && ageS < limitS) return { fetched: false, skipped: true, ageS };
  }
  run();                                                   // throws on failure: no stamp is written
  try {
    fsImpl.mkdirSync(dir, { recursive: true });
    fsImpl.writeFileSync(stamp, String(now));
    const t = new Date(now);
    fsImpl.utimesSync(stamp, t, t);
  } catch { /* cannot stamp: the next caller simply fetches again */ }
  return { fetched: true, skipped: false, ageS };
}

module.exports = { fetchIfDue, stampPath, DEFAULT_STAMP_DIR };
