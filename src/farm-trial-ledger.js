'use strict';

// Outcomes from the lease ledger (multi-node plan, trial piece): turns the lease rows lease-ledger.js keeps into the {taskId, node, result} array
// src/farm-trial.js scoreTrial() takes, so the operator does not write the outcomes file by hand.
//
// 'repaired' is NEVER produced here: the ledger cannot tell a clean merge from a merge after a repair, so every merged task is 'merged'.
// Mapping for rows of the requested node only, first match wins:
//   state or lastEvent 'merged'            -> 'merged'
//   lastEvent 'failed' or 'blocked'        -> 'failed' (a failure the node reported is final, even while the lease row still says lent)
//   state 'returned' or 'expired'          -> 'abandoned'
//   anything else (lent, no final event)   -> pending (left out of outcomes)
// A taskId with no row for this node (none at all, or claimed only by another node) -> missing (left out of outcomes).
// delivered: the taskIds (in taskIds order) whose row for this node has state 'returned' or 'expired' and lastEvent 'drafted', 'reviewed' or 'applied':
//   the node got the work out but nothing merged it. Such a task also appears in outcomes as 'abandoned'; delivered is an extra list for the operator.
//   A merged, failed or blocked row, a lent row and a missing task are never delivered.
//
//   outcomesFromLedger({ nodeId, taskIds, leases }) -> { outcomes, pending, missing, delivered }
//   node src/farm-trial-ledger.js --node <id> --tasks <a,b> [--out file.json]
//     prints the result JSON, writes the outcomes array to --out when given; exit 0 all resolved, 3 pending or missing, 2 usage
// Reads only the lease ledger (listLeases); nothing polls, nothing starts a trial. See docs/agents/multi-node-runbook.md.

const fs = require('fs');
const { listLeases } = require('./lease-ledger.js');

const FLAGS = ['--node', '--tasks', '--out'];
const DELIVERED_EVENTS = ['drafted', 'reviewed', 'applied'];

function resultFor(row) {
  if (row.state === 'merged' || row.lastEvent === 'merged') return 'merged';
  if (row.lastEvent === 'failed' || row.lastEvent === 'blocked') return 'failed';
  if (row.state === 'returned' || row.state === 'expired') return 'abandoned';
  return null;
}

function outcomesFromLedger({ nodeId, taskIds, leases } = {}) {
  if (typeof nodeId !== 'string' || !nodeId) throw new Error('nodeId must be a non-empty string');
  if (!Array.isArray(taskIds)) throw new Error('taskIds must be an array');
  if (!Array.isArray(leases)) throw new Error('leases must be an array');
  const mine = new Map();
  for (const row of leases) {
    if (row && row.nodeId === nodeId && typeof row.taskId === 'string') mine.set(row.taskId, row);
  }
  const outcomes = [];
  const pending = [];
  const missing = [];
  for (const taskId of taskIds) {
    const row = mine.get(taskId);
    if (!row) { missing.push(taskId); continue; }
    const result = resultFor(row);
    if (result) outcomes.push({ taskId, node: nodeId, result });
    else pending.push(taskId);
  }
  const delivered = [];
  for (const taskId of taskIds) {
    const row = mine.get(taskId);
    if (row && (row.state === 'returned' || row.state === 'expired') && DELIVERED_EVENTS.includes(row.lastEvent)) delivered.push(taskId);
  }
  return { outcomes, pending, missing, delivered };
}

// Parses --flag value pairs; null when a flag is unknown, repeated or has no value.
function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!FLAGS.includes(flag) || value === undefined || value.startsWith('--') || opts[flag.slice(2)] !== undefined) return null;
    opts[flag.slice(2)] = value;
  }
  return opts;
}

function main(argv, out = (s) => process.stdout.write(`${s}\n`), leases = null) {
  const opts = parseArgs(argv);
  const taskIds = opts && opts.tasks ? opts.tasks.split(',').map((s) => s.trim()).filter(Boolean) : [];
  if (!opts || !opts.node || taskIds.length === 0) {
    process.stderr.write('usage: node src/farm-trial-ledger.js --node <id> --tasks <a,b> [--out file.json]\n');
    return 2;
  }
  const result = outcomesFromLedger({ nodeId: opts.node, taskIds, leases: leases || listLeases(process.env) });
  if (opts.out) {
    try {
      fs.writeFileSync(opts.out, `${JSON.stringify(result.outcomes, null, 2)}\n`);
    } catch (e) {
      process.stderr.write(`farm-trial-ledger: cannot write ${opts.out}: ${e.message}\n`);
      return 2;
    }
  }
  out(JSON.stringify(result));
  return result.pending.length || result.missing.length ? 3 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { outcomesFromLedger, main };
