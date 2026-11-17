'use strict';

// Per-run circuit breaker for harness-side project searches (see project-search-fetch.js).
//
// createSearchBreaker({ threshold = 3 } = {}) returns
//   { recordResult(source, kind), shouldSkip(source), consecutiveFailures(source) }
//
// recordResult(source, kind):
//   kind undefined/null -> success: resets that source's consecutive count to 0
//   kind 'network'      -> increments the count
//   any other kind      -> ('rate-limit' | 'http' | 'parse') leaves the count unchanged
//
// shouldSkip(source) is a LATCH: once a source's count reaches `threshold` it stays
// skipped for the rest of the run, even if a later success resets consecutiveFailures
// to 0. State is in memory, per instance, with no timers and no I/O.
//
// Throws a TypeError unless threshold is a positive integer.

function createSearchBreaker({ threshold = 3 } = {}) {
  if (!Number.isInteger(threshold) || threshold < 1) {
    throw new TypeError('threshold must be a positive integer');
  }
  const counts = new Map();
  const tripped = new Set();

  function recordResult(source, kind) {
    if (kind === undefined || kind === null) {
      counts.set(source, 0);
      return;
    }
    if (kind === 'network') {
      const next = (counts.get(source) || 0) + 1;
      counts.set(source, next);
      if (next >= threshold) tripped.add(source);
    }
  }

  function shouldSkip(source) {
    return tripped.has(source);
  }

  function consecutiveFailures(source) {
    return counts.get(source) || 0;
  }

  return { recordResult, shouldSkip, consecutiveFailures };
}

module.exports = { createSearchBreaker };
