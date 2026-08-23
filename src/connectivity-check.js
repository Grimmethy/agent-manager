'use strict';

// Cheap, synchronous "is there real internet connectivity" check -- deliberately
// synchronous (uses execFileSync, not a Promise) so it drops straight into
// task-sources.js's fully-synchronous next*Task() chain: getNextTask() calls each
// source.next() synchronously, and threading a Promise through every call site in that
// chain for the sake of one check would be a much bigger, riskier change than this is
// worth. Confirmed live 2026-08-15: project_search tasks kept getting drafted and dumped
// into queue/blocked/ in bulk while the internet connection was down -- nothing upstream
// ever checked connectivity BEFORE spending a plan+implement pass on a task guaranteed to
// fail the moment project-search-fetch.js's real GitHub/HuggingFace calls came up empty.
//
// Cached briefly (see CACHE_MS) so multiple checks within the same worker tick (or across
// different next*Task() functions) don't each pay a fresh network round-trip -- a real
// probe only actually runs once every CACHE_MS at most.
const { execFileSync } = require('child_process');

const CHECK_URL = 'https://api.github.com';
const TIMEOUT_SECONDS = 3;
const CACHE_MS = 30000;

let cache = { atMs: 0, online: true };

function probeOnce() {
  try {
    const out = execFileSync(
      'curl',
      ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', String(TIMEOUT_SECONDS), CHECK_URL],
      { encoding: 'utf8', timeout: (TIMEOUT_SECONDS + 2) * 1000 },
    );
    const status = parseInt(out.trim(), 10);
    // Any real HTTP response -- even a 4xx/5xx from GitHub itself -- proves the network
    // path is actually up. curl's own sentinel for "never got a response at all" (DNS
    // failure, connection refused, timeout) is "000", which fails this check as intended.
    return Number.isFinite(status) && status > 0;
  } catch {
    // curl missing, timed out, or connection refused -- treat as offline. Never let a
    // connectivity probe itself crash the caller (same non-fatal-skip convention as
    // every other best-effort check in this codebase).
    return false;
  }
}

// forceRefresh bypasses the cache -- used by tests and by anything that just changed
// network state and needs a real answer immediately rather than a stale cached one.
// probe is injectable (defaults to the real curl-based probeOnce) purely for this
// module's own tests -- same shape as local-draft.js's injectable ornithCall/
// projectSearchFetch deps -- so isOnline()'s caching/refresh logic can be verified
// deterministically without spending a real network round-trip (or a real 3s timeout)
// on every test run.
function isOnline({ forceRefresh = false, probe = probeOnce } = {}) {
  const now = Date.now();
  if (!forceRefresh && now - cache.atMs < CACHE_MS) return cache.online;
  const online = probe();
  cache = { atMs: now, online };
  return online;
}

module.exports = { isOnline, probeOnce, CACHE_MS };
