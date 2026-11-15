'use strict';

// Lease ledger (multi-node plan, piece 4a): wok keeps one file, leases.json in the nodes directory, saying which task is lent to which node and until when.
// A lease is 'lent', then 'returned' (the node posted its review package) or 'expired' (nobody did before expiresAt: the task goes back to the pool).
// Nothing here lends anything by itself: it is a store plus a CLI the owner runs. See docs/agents/leases.md.

const fs = require('fs');
const path = require('path');
const { nodesDir } = require('./node-registry.js');
const { writeJsonAtomicSync } = require('./atomic-write.js');

// One hour: a node's claim lasts an hour, then wok asks the node whether the task is merged, still in progress or unknown (settleExpired).
const DEFAULT_TTL_MS = 60 * 60 * 1000;
// The events a node posts about a task it pulled (POST /event); anything else is refused.
const EVENTS = ['drafted', 'reviewed', 'applied', 'merged', 'blocked', 'failed'];

function leasesFile(env = process.env) {
  return path.join(nodesDir(env), 'leases.json');
}

function defaultTtlMs(env = process.env) {
  const n = Number(env.AGENT_MANAGER_LEASE_TTL_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_MS;
}

function load(env) {
  try {
    const data = JSON.parse(fs.readFileSync(leasesFile(env), 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch (e) {
    return {};
  }
}

function save(leases, env) {
  fs.mkdirSync(nodesDir(env), { recursive: true });
  writeJsonAtomicSync(leasesFile(env), leases);
}

function isLive(lease, nowMs) {
  return Boolean(lease) && lease.state === 'lent' && Date.parse(lease.expiresAt) > nowMs;
}

// Lends taskId to nodeId. Refuses (returns null) while the task has a live lease; an expired or returned lease may be replaced.
function lendLease(taskId, nodeId, { ttlMs, now = Date.now(), env = process.env } = {}) {
  const leases = load(env);
  if (isLive(leases[taskId], now)) return null;
  const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : defaultTtlMs(env);
  const lease = { taskId, nodeId, leasedAt: new Date(now).toISOString(), expiresAt: new Date(now + ttl).toISOString(), state: 'lent' };
  leases[taskId] = lease;
  save(leases, env);
  return lease;
}

// Marks a 'lent' lease 'returned'. Returns the lease, or null when there is none or it is not lent any more.
function returnLease(taskId, { now = Date.now(), env = process.env } = {}) {
  const leases = load(env);
  const lease = leases[taskId];
  if (!lease || lease.state !== 'lent') return null;
  lease.state = 'returned';
  lease.returnedAt = new Date(now).toISOString();
  save(leases, env);
  return lease;
}

// Deletes a lease that is still 'lent' (a lend that failed before the node took the task) and returns it; null when there is none or it is not lent.
function cancelLease(taskId, { env = process.env } = {}) {
  const leases = load(env);
  const lease = leases[taskId];
  if (!lease || lease.state !== 'lent') return null;
  delete leases[taskId];
  save(leases, env);
  return lease;
}

// Marks every 'lent' lease whose expiresAt has been reached as 'expired' and returns them (the caller puts those tasks back in the pool).
function expireLeases({ now = Date.now(), env = process.env } = {}) {
  const leases = load(env);
  const expired = [];
  for (const lease of Object.values(leases)) {
    if (lease && lease.state === 'lent' && !(Date.parse(lease.expiresAt) > now)) {
      lease.state = 'expired';
      expired.push(lease);
    }
  }
  if (expired.length) save(leases, env);
  return expired;
}

// Records one node event on the task's lease row (lastEvent, lastEventAt). 'merged' closes the lease (state 'merged').
// Returns the row, or null when the task has no lease row. An event outside EVENTS throws.
function recordEvent(taskId, event, { now = Date.now(), env = process.env } = {}) {
  if (!EVENTS.includes(event)) throw new Error(`event must be one of ${EVENTS.join(', ')}`);
  const leases = load(env);
  const lease = leases[taskId];
  if (!lease) return null;
  lease.lastEvent = event;
  lease.lastEventAt = new Date(now).toISOString();
  if (event === 'merged') {
    lease.state = 'merged';
    lease.mergedAt = lease.lastEventAt;
  }
  save(leases, env);
  return lease;
}

// Settles every 'lent' lease that is past expiresAt by asking the node: askNode(nodeId, taskId) answers 'merged', 'in-progress' or
// 'unknown' (a throw or any other answer counts as unknown). merged closes the lease, in-progress renews it for another ttl, unknown
// puts the task back in the pool (the lease row becomes 'expired' and the record's leasedTo is cleared by lend-task's reclaimExpired,
// once per directory in pipelineDirs). Returns { merged, renewed, released } with the rows.
async function settleExpired({ askNode, pipelineDirs = [], now = Date.now(), env = process.env } = {}) {
  const due = listLeases(env).filter((l) => l && l.state === 'lent' && !(Date.parse(l.expiresAt) > now));
  const answers = new Map();
  for (const lease of due) {
    let answer = 'unknown';
    try { answer = await askNode(lease.nodeId, lease.taskId); } catch (e) { answer = 'unknown'; }
    answers.set(lease.taskId, answer === 'merged' || answer === 'in-progress' ? answer : 'unknown');
  }
  const result = { merged: [], renewed: [], released: [] };
  const leases = load(env);
  for (const lease of due) {
    const row = leases[lease.taskId];
    if (!row || row.state !== 'lent' || row.expiresAt !== lease.expiresAt) continue; // changed while we asked: leave it
    const answer = answers.get(lease.taskId);
    if (answer === 'merged') {
      row.state = 'merged';
      row.mergedAt = new Date(now).toISOString();
      result.merged.push(row);
    } else if (answer === 'in-progress') {
      row.expiresAt = new Date(now + defaultTtlMs(env)).toISOString();
      row.renewedAt = new Date(now).toISOString();
      result.renewed.push(row);
    }
  }
  if (result.merged.length || result.renewed.length) save(leases, env);
  if (due.some((l) => answers.get(l.taskId) === 'unknown')) {
    const { reclaimExpired } = require('./lend-task.js'); // lazy: lend-task requires this file
    const released = [];
    for (const dir of pipelineDirs.length ? pipelineDirs : [null]) {
      const rows = dir ? reclaimExpired({ pipelineDir: dir, now, env }) : expireLeases({ now, env });
      for (const r of rows) if (!released.some((x) => x.taskId === r.taskId)) released.push(r);
      if (!dir) break;
    }
    result.released = released;
  }
  return result;
}

function leaseFor(taskId, env = process.env) {
  return load(env)[taskId] || null;
}

function listLeases(env = process.env) {
  return Object.values(load(env));
}

function main(argv, env = process.env, out = (s) => process.stdout.write(`${s}\n`)) {
  const [cmd, a, b] = argv;
  if (cmd === 'list') { out(JSON.stringify(listLeases(env), null, 2)); return 0; }
  if (cmd === 'lend' && a && b) {
    const lease = lendLease(a, b, { env });
    if (!lease) { out(`task ${a} already has a live lease`); return 3; }
    out(JSON.stringify(lease)); return 0;
  }
  if (cmd === 'return' && a) {
    const lease = returnLease(a, { env });
    if (!lease) { out(`task ${a} has no lent lease`); return 3; }
    out(JSON.stringify(lease)); return 0;
  }
  if (cmd === 'expire') { out(JSON.stringify(expireLeases({ env }))); return 0; }
  process.stderr.write('usage: node src/lease-ledger.js list | lend <taskId> <nodeId> | return <taskId> | expire\n');
  return 2;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { leasesFile, defaultTtlMs, lendLease, returnLease, cancelLease, expireLeases, recordEvent, settleExpired, leaseFor, listLeases, main, DEFAULT_TTL_MS, EVENTS };
