'use strict';

// Pure staleness comparison between a node's repo HEAD and the primary's HEAD.
// Rule: missing or empty fields -> 'unknown'; equal shas -> 'current';
// unparseable dates -> 'unknown'; node date more than 24h older than the
// primary date -> 'stale'; otherwise 'current'. The 24-hour threshold is
// defined only in this file.
//
// Pure by design: no I/O, no timers, no wall-clock reads. The result depends only on
// the arguments, so the browser and the server can share the same decision.

const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function staleCodeState({ nodeSha, nodeDate, primarySha, primaryDate } = {}) {
  if (![nodeSha, nodeDate, primarySha, primaryDate].every(isNonEmptyString)) {
    return 'unknown';
  }
  if (nodeSha === primarySha) return 'current';

  const nodeMs = Date.parse(nodeDate);
  const primaryMs = Date.parse(primaryDate);
  if (Number.isNaN(nodeMs) || Number.isNaN(primaryMs)) return 'unknown';

  if (primaryMs - nodeMs > STALE_AFTER_MS) return 'stale';
  return 'current';
}

module.exports = { staleCodeState };
