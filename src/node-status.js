'use strict';

// Node status summary (multi-node plan): one row per registered node, with counts of its leases by state, for the dashboard and the CLI.
// Pure functions over the arrays that src/node-registry.js listNodes and src/lease-ledger.js listLeases return. No files, no clock of their own: the caller passes now.
// A 'lent' lease whose expiresAt has been reached, or cannot be parsed, counts as expired. A lease whose nodeId matches no node is ignored.

const HEADER = 'id status load freeRamGb lent returned expired merged nextExpiryMin';
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

// Prints null and undefined as '-', anything else as a plain string.
function cell(value) {
  return value === null || value === undefined ? '-' : String(value);
}

// Leases granted and returned with no node event in the last hour: state 'returned', returnedAt within HOUR_MS before now, leasedAt set, lastEvent unset.
// Reads stored lease rows only; no clock of its own.
function countLentReturnedWithoutEvent(leases, now) {
  let count = 0;
  for (const lease of leases) {
    if (!lease || lease.state !== 'returned') continue;
    if (!Number.isFinite(Date.parse(lease.leasedAt))) continue;
    const returnedAt = Date.parse(lease.returnedAt);
    if (!Number.isFinite(returnedAt) || returnedAt > now || now - returnedAt > HOUR_MS) continue;
    if (lease.lastEvent) continue;
    count += 1;
  }
  return count;
}

// Returns one row per node, in input order. nextExpiryMin is whole minutes (rounded up) until the soonest live lent lease ends, or null.
// options.skipped (optional): the skipped array claimNext filled; its 'previously-failed' entries are counted. Absent gives null (shown as unavailable).
// The returned array carries a summary property ({ previouslyFailed, lentReturnedWithoutEvent }) that formatSummary prints.
function summarizeNodes(nodes, leases, now, options = {}) {
  if (!Array.isArray(nodes)) throw new TypeError('nodes must be an array');
  if (!Array.isArray(leases)) throw new TypeError('leases must be an array');
  if (!Number.isFinite(now)) throw new TypeError('now must be a finite number');

  const rows = nodes.map((node) => ({
    id: node.id,
    status: node.status,
    load: node.load,
    freeRamGb: node.freeRamGb,
    lentNow: 0,
    returned: 0,
    expired: 0,
    merged: 0,
    nextExpiryMin: null,
  }));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const soonest = new Map();

  for (const lease of leases) {
    const row = lease ? byId.get(lease.nodeId) : undefined;
    if (!row) continue;
    if (lease.state === 'returned') {
      row.returned += 1;
    } else if (lease.state === 'merged') {
      row.merged += 1;
    } else if (lease.state === 'expired') {
      row.expired += 1;
    } else if (lease.state === 'lent') {
      const at = Date.parse(lease.expiresAt);
      if (!Number.isFinite(at) || at <= now) {
        row.expired += 1;
      } else {
        row.lentNow += 1;
        const best = soonest.get(row.id);
        if (best === undefined || at < best) soonest.set(row.id, at);
      }
    }
  }

  for (const row of rows) {
    const at = soonest.get(row.id);
    if (at !== undefined) row.nextExpiryMin = Math.ceil((at - now) / MINUTE_MS);
  }
  const skipped = options && Array.isArray(options.skipped) ? options.skipped : null;
  const previouslyFailed = skipped ? skipped.filter((s) => s && s.reason === 'previously-failed').length : null;
  // Non-enumerable so the rows still compare equal as plain arrays (tests and callers that deep-compare rows).
  Object.defineProperty(rows, 'summary', {
    value: { previouslyFailed, lentReturnedWithoutEvent: countLentReturnedWithoutEvent(leases, now) },
    enumerable: false,
  });
  return rows;
}

// Header line, then one line per row with fields separated by single spaces. An empty array gives the header line only. No trailing newline.
function formatSummary(rows) {
  const lines = [HEADER];
  for (const r of rows) {
    lines.push([r.id, r.status, r.load, r.freeRamGb, r.lentNow, r.returned, r.expired, r.merged, r.nextExpiryMin].map(cell).join(' '));
  }
  // The two summary lines appear only for rows from summarizeNodes (which attaches rows.summary); a plain row array keeps the original output.
  if (rows.summary) {
    const summary = rows.summary;
    const previous = summary.previouslyFailed === null || summary.previouslyFailed === undefined ? 'unavailable' : String(summary.previouslyFailed);
    lines.push(`previously-failed: ${previous}`);
    lines.push(`lent-and-returned-without-event: ${summary.lentReturnedWithoutEvent} in the last hour`);
  }
  return lines.join('\n');
}

module.exports = { summarizeNodes, formatSummary };
