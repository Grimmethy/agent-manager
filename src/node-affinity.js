'use strict';

// Node affinity (multi-node plan, piece 4b): a task lent to a node carries `leasedTo: <node id>`. A worker on another node must never claim it, and a task
// with no `leasedTo` belongs to the ledger owner (wok, the machine with no AGENT_MANAGER_NODE_ID). Used by src/next-claimable-task.js next to the
// operator pin (`pinnedWorker`) skip. See docs/agents/leases.md.

const LEDGER_OWNER = 'wok';

// The node a worker runs on: its AGENT_MANAGER_NODE_ID, or the ledger owner when unset or blank.
function workerNode(nodeId) {
  const id = String(nodeId == null ? '' : nodeId).trim();
  return id || LEDGER_OWNER;
}

// true when a worker on `nodeId` may claim `task`.
function claimableOnNode(task, nodeId) {
  const leasedTo = task && typeof task.leasedTo === 'string' ? task.leasedTo.trim() : '';
  const node = workerNode(nodeId);
  if (!leasedTo) return node === LEDGER_OWNER;
  return leasedTo === node;
}

module.exports = { LEDGER_OWNER, workerNode, claimableOnNode };
