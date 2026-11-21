'use strict';

// Returns a paused node's held tasks to wok's pool (HUB0627).
//
//   returnHeldOnPause(nodeId, deps) -> array of returned task entries, premium-first
//
// Everything is injected through deps so the module has no I/O of its own:
//   deps.listLeases(env)            -> lease rows (src/lease-ledger.js listLeases)
//   deps.returnLease(taskId, opts)  -> the returned lease row, or null (src/lease-ledger.js returnLease; synchronous)
//   deps.readRecord(taskId)         -> wok's task record, or null
//   deps.writeRecord(taskId, rec)   -> persists the wok task record
//   deps.now, deps.env              -> optional; passed through to the ledger
//
// One synchronous pass: no timers, no polling, no model calls. Each lent lease for nodeId that has no
// result is returned; wok's record loses `leasedTo` only when it still names nodeId. The paused node is
// added to an in-memory exclusion set (isNodeExcluded).

const excludedNodes = new Set();

function returnHeldOnPause(nodeId, deps = {}) {
  if (!nodeId) throw new Error('returnHeldOnPause: nodeId is required');
  const { listLeases, returnLease, readRecord, writeRecord, now = Date.now(), env = process.env } = deps;
  if (typeof listLeases !== 'function' || typeof returnLease !== 'function') {
    throw new Error('returnHeldOnPause: deps.listLeases and deps.returnLease are required');
  }

  const held = listLeases(env).filter(
    (l) => l && l.nodeId === nodeId && l.state === 'lent' && (l.result === undefined || l.result === null)
  );

  const entries = [];
  for (const lease of held) {
    const row = returnLease(lease.taskId, { now, env });
    if (!row) continue;
    const record = typeof readRecord === 'function' ? readRecord(row.taskId) : null;
    if (record && record.leasedTo === nodeId) {
      delete record.leasedTo;
      if (typeof writeRecord === 'function') writeRecord(row.taskId, record);
    }
    entries.push({ taskId: row.taskId, premiumPriority: Boolean(record && record.premiumPriority), lease: row, record: record || null });
  }

  entries.sort((a, b) => Number(b.premiumPriority) - Number(a.premiumPriority));
  excludedNodes.add(nodeId);
  return entries;
}

function isNodeExcluded(nodeId) {
  return excludedNodes.has(nodeId);
}

module.exports = { returnHeldOnPause, isNodeExcluded, excludedNodes };
