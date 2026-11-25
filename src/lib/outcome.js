'use strict';

// outcome.js -- three-way completion outcome for a worker item.
// saved: the write succeeded. needs_human: a human-only step is needed, so the item is parked with
// partial work and a stated reason. error: an unexpected failure (the existing failure path).
// Pure and synchronous: no timers, no polling, no retries on a clock.

const OUTCOME = Object.freeze({
  SAVED: 'saved',
  NEEDS_HUMAN: 'needs_human',
  ERROR: 'error',
});

// Parks an item for a human. Returns { status, reason, handoff }. handoff carries the item id,
// title, any partial work, and the list of missing pieces. It never includes a URL.
function park(item, opts) {
  const o = opts || {};
  const id = item && item.id != null ? String(item.id) : '';
  if (!id) throw new Error('park(): item.id is required');
  const reason = String(o.reason || '').trim();
  if (!reason) throw new Error('park(): a non-empty reason is required');
  return {
    status: OUTCOME.NEEDS_HUMAN,
    reason,
    handoff: {
      id,
      title: item.title != null ? String(item.title) : '',
      partial: o.partial === undefined ? null : o.partial,
      missing: Array.isArray(o.missing) ? o.missing.map(String) : [],
    },
  };
}

module.exports = { OUTCOME, park };
