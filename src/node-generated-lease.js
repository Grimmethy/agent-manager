'use strict';

// Node-generated lease (FF-1): a task a NODE generates is leased to that node when its source is core-scope.
// Without a lease, a node can never claim its own generated task (claimableOnNode only lets the ledger owner
// 'wok' claim an unleased task), so core bot tasks flood pending/ and starve the adhoc queue.
// Called once per generated task, on the generator's own write path. No timers, no polling.

const { getRegisteredSource } = require('./task-source-registry.js');
const { workerNode, LEDGER_OWNER } = require('./node-affinity.js');

// Returns 'lease' when task.leasedTo was set to this node, otherwise 'leave' (task untouched). Never throws.
function applyGeneratedLease(task, env = process.env) {
  try {
    if (!task || typeof task !== 'object') return 'leave';
    const node = workerNode(env && env.AGENT_MANAGER_NODE_ID);
    if (node === LEDGER_OWNER) return 'leave';
    if (task.leasedTo) return 'leave';
    const entry = getRegisteredSource(task.source);
    if (!entry || entry.scope !== 'core') return 'leave';
    task.leasedTo = node;
    return 'lease';
  } catch {
    return 'leave';
  }
}

module.exports = { applyGeneratedLease };
