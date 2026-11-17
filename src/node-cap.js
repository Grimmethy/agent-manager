'use strict';

// Node concurrency cap (multi-node plan): how many tasks a node may hold lent at once.
// resolveNodeCap(nodeId) returns the node's registered concurrencyCap, or the env default (AGENT_MANAGER_NODE_MAX_OUTSTANDING, default 3) when unset or invalid.
// countOutstandingLent(nodeId, now) counts the node's 'lent' leases that have not expired at `now` (expiresAt > now).

const { loadNodes } = require('./node-registry.js');
const { listLeases } = require('./lease-ledger.js');

const DEFAULT_MAX_OUTSTANDING = 3;

function envDefault(env = process.env) {
  const n = Number(env.AGENT_MANAGER_NODE_MAX_OUTSTANDING);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_OUTSTANDING;
}

// The node's registered concurrencyCap when it is a positive number, else the env default (missing node, null or invalid value).
function resolveNodeCap(nodeId, env = process.env) {
  const record = loadNodes(env)[nodeId];
  const cap = record ? record.concurrencyCap : null;
  return typeof cap === 'number' && Number.isFinite(cap) && cap > 0 ? cap : envDefault(env);
}

// Number of rows for nodeId in state 'lent' whose expiresAt is still after `now` (epoch ms). A row with an unparseable expiresAt counts as outstanding (conservative).
function countOutstandingLent(nodeId, now = Date.now(), env = process.env) {
  return listLeases(env).filter((row) => row && row.nodeId === nodeId && row.state === 'lent' && !(Date.parse(row.expiresAt) <= now)).length;
}

module.exports = { resolveNodeCap, countOutstandingLent };
