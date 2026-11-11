'use strict';

// Lease ledger (multi-node plan, piece 4a): wok keeps one file, leases.json in the nodes directory, saying which task is lent to which node and until when.
// A lease is 'lent', then 'returned' (the node posted its review package) or 'expired' (nobody did before expiresAt: the task goes back to the pool).
// Nothing here lends anything by itself: it is a store plus a CLI the owner runs. See docs/agents/leases.md.

const fs = require('fs');
const path = require('path');
const { nodesDir } = require('./node-registry.js');
const { writeJsonAtomicSync } = require('./atomic-write.js');

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

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

module.exports = { leasesFile, defaultTtlMs, lendLease, returnLease, expireLeases, leaseFor, listLeases, main, DEFAULT_TTL_MS };
