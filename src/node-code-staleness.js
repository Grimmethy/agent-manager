'use strict';

// compareCodeFreshness(node, primary, { maxLagMs }) -- decide whether a node
// worker's checked-out code is stale relative to the primary's checkout.
//
// Pure module. No I/O, never reads the wall clock, no timer scheduling.
//
// Inputs: node and primary are { headSha, headCommitDate }, where
// headCommitDate is an ISO date string (the HEAD commit's committer date).
//
// Returns { stale, reason, lagMs }:
//   - 'unknown'       -- either side is missing a sha, or has a missing or
//                        unparseable date. Fails open: stale:false, lagMs:null.
//   - 'same-sha'      -- both sides are on the same commit. stale:false.
//                        lagMs is primaryDate - nodeDate when both dates parse
//                        (normally 0), otherwise null.
//   - 'behind'        -- primaryDate - nodeDate > maxLagMs. stale:true.
//   - 'within-window' -- otherwise, including a node NEWER than the primary
//                        (negative lagMs). stale:false.
//
// lagMs = primaryDate - nodeDate (milliseconds).
// maxLagMs defaults to 24h; a non-finite value falls back to the default.

const DEFAULT_MAX_LAG_MS = 24 * 3600 * 1000;

function hasSha(x) {
  return x != null && typeof x === 'object' &&
    typeof x.headSha === 'string' && x.headSha.length > 0;
}

function parseDate(x) {
  if (x == null || typeof x !== 'object') return null;
  const d = x.headCommitDate;
  if (typeof d !== 'string' || d.length === 0) return null;
  const t = Date.parse(d);
  return Number.isFinite(t) ? t : null;
}

function compareCodeFreshness(node, primary, { maxLagMs = DEFAULT_MAX_LAG_MS } = {}) {
  const limit = (typeof maxLagMs === 'number' && Number.isFinite(maxLagMs))
    ? maxLagMs : DEFAULT_MAX_LAG_MS;

  // Missing-sha check comes first so two missing shas never read as same-sha.
  if (!hasSha(node) || !hasSha(primary)) {
    return { stale: false, reason: 'unknown', lagMs: null };
  }

  const nodeDate = parseDate(node);
  const primaryDate = parseDate(primary);
  const bothDates = nodeDate !== null && primaryDate !== null;

  if (node.headSha === primary.headSha) {
    return { stale: false, reason: 'same-sha', lagMs: bothDates ? primaryDate - nodeDate : null };
  }

  if (!bothDates) {
    return { stale: false, reason: 'unknown', lagMs: null };
  }

  const lagMs = primaryDate - nodeDate;
  if (lagMs > limit) {
    return { stale: true, reason: 'behind', lagMs };
  }
  return { stale: false, reason: 'within-window', lagMs };
}

module.exports = { compareCodeFreshness };
