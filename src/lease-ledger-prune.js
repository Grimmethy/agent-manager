'use strict';

// Lease-ledger pruning, dry run only (multi-node plan, piece 4b): names the finished lease rows old enough to prune, from the rows lease-ledger.js listLeases returns.
// It never writes, deletes or edits anything and has no apply mode. A 'lent' row, or a row with no parsable finish time, is never named. See docs/agents/leases.md.

// Whole days are 24 h each, so olderThanDays is compared against wall-clock milliseconds.
const DAY_MS = 24 * 60 * 60 * 1000;
// The states a finished lease can be in. 'lent' is still live, so it is never prunable.
const PRUNABLE_STATES = ['returned', 'expired', 'merged'];
// The finish time is the first of these that is present and parsable, in this order.
const FINISH_FIELDS = ['mergedAt', 'returnedAt', 'expiresAt'];

// A row is an object (not null, not an array); anything else is counted as kept and never read.
// Rows are the objects listLeases returns, so every field is read defensively: a missing or wrong-typed field just means not prunable.
function isRow(lease) {
  return lease !== null && typeof lease === 'object' && !Array.isArray(lease);
}

// The finish time of a row as epoch ms, or null when no finish field is a parsable date string.
function finishMs(lease) {
  for (const field of FINISH_FIELDS) {
    const value = lease[field];
    if (typeof value !== 'string') continue;
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

// Returns { prunable, kept }. prunable is the taskIds, in input order, of finished rows whose finish time is strictly more than
// olderThanDays whole days (24 h each) before now. kept counts every other row. Rows that are null or not objects are kept, never thrown on.
// Throws on bad arguments. Never modifies leases.
function selectPrunable(leases, { olderThanDays, now } = {}) {
  if (!Array.isArray(leases)) throw new TypeError('leases must be an array');
  if (typeof olderThanDays !== 'number' || !Number.isFinite(olderThanDays) || olderThanDays <= 0) {
    throw new RangeError('olderThanDays must be a positive number');
  }
  if (typeof now !== 'number' || !Number.isFinite(now)) throw new TypeError('now must be a finite number');

  // A row is prunable only when its age is strictly greater than this, so a row exactly olderThanDays old is kept.
  const thresholdMs = olderThanDays * DAY_MS;
  const prunable = [];
  let kept = 0;
  for (const lease of leases) {
    if (!isRow(lease) || !PRUNABLE_STATES.includes(lease.state)) {
      kept += 1;
      continue;
    }
    const finished = finishMs(lease);
    if (finished !== null && now - finished > thresholdMs) {
      prunable.push(lease.taskId);
    } else {
      kept += 1;
    }
  }
  return { prunable, kept };
}

// Only selectPrunable is exported: this module is a dry-run selector, not a pruner.
module.exports = { selectPrunable };
