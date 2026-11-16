// Oldest live lease per node (multi-node plan, piece 4a): for one node, the lease in src/lease-ledger.js that was lent earliest and is still live.
// It reports the task, how many whole minutes ago that lease was lent (ageMin) and how many minutes it has left (leftMin, rounded up).
// A lease is live when its state is 'lent' and expiresAt is still in the future: the same rule as isLive in src/lease-ledger.js.
// isLive is not exported, so the rule is restated here rather than imported.
// Pure: it takes the rows listLeases returns and a clock value. It reads nothing, writes nothing and skips bad rows; only bad arguments throw.
// Returns null when the node has no live lease, so the caller can tell 'nothing lent' from 'lent with zero minutes left'.

'use strict';

const MS_PER_MIN = 60 * 1000;

// Returns { taskId, ageMin, leftMin } for the live lease of nodeId with the earliest parsable leasedAt.
// A tie on leasedAt keeps the first row in input order. Leases of other nodes are ignored.
// leases is the array listLeases returns; now is a clock value in epoch milliseconds.
function oldestLiveLease(leases, nodeId, now) {
  // Argument checks run first, in this order, so a bad call fails the same way every time.
  if (!Array.isArray(leases)) throw new TypeError('leases must be an array');
  if (typeof nodeId !== 'string' || nodeId.length === 0) throw new TypeError('nodeId must be a non-empty string');
  if (typeof now !== 'number' || !Number.isFinite(now)) throw new TypeError('now must be a finite number');

  let best = null;
  for (const row of leases) {
    // null and non-object rows are skipped, never thrown on.
    if (row === null || typeof row !== 'object') continue;
    if (row.nodeId !== nodeId || row.state !== 'lent') continue;

    // NaN (an unparsable expiresAt) fails this comparison, so such a row is not live.
    // A 'lent' row already past expiresAt is not live either.
    const expiresMs = Date.parse(row.expiresAt);
    if (!(expiresMs > now)) continue;

    // A live lease whose leasedAt cannot be parsed is skipped rather than guessed at.
    const leasedMs = Date.parse(row.leasedAt);
    if (Number.isNaN(leasedMs)) continue;

    // Strict < keeps the earlier row on a tie.
    if (best === null || leasedMs < best.leasedMs) best = { taskId: row.taskId, leasedMs, expiresMs };
  }
  if (best === null) return null;

  return {
    taskId: best.taskId,
    // Age is whole minutes, floored. A leasedAt in the future gives age 0, never a negative age.
    ageMin: Math.max(0, Math.floor((now - best.leasedMs) / MS_PER_MIN)),
    // Minutes left are rounded up, so 61 seconds left reads as 2 minutes.
    leftMin: Math.ceil((best.expiresMs - now) / MS_PER_MIN),
  };
}

// Shape of a result, for a caller that prints the lease in a status line:
//   { taskId: 'a', ageMin: 30, leftMin: 30 }
// ageMin counts whole minutes from leasedAt to now (floored, never below 0).
// leftMin counts whole minutes from now to expiresAt (rounded up).
// Rows are read, never changed: the same array can be passed again on the next poll.
// Every row is checked on its own, so one bad row costs only that row, not the whole call.
// Callers that need every live lease, not just the oldest, should filter listLeases themselves.
// The clock is an argument, so tests pin time and nothing here calls Date.now().
// A null return means no live lease for the node; it is never an error.

module.exports = { oldestLiveLease };
