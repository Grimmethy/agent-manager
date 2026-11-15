'use strict';

// Lend client (multi-node plan, piece 5a): lends one task from wok to a node and takes it back when the lease expires.
//
//   node src/lend-task.js lend <taskId> <nodeId> --url <node intake /lend url> --token-file <file>
//   node src/lend-task.js reclaim
//
// lend: finds the task record in <AGENT_MANAGER_PIPELINE_DIR>/queue/pending (else queue/adhoc), refuses one that already has `leasedTo`, takes a lease
// (src/lease-ledger.js), POSTs {task, lease} to the node intake (src/node-intake-server.js POST /lend) with the lender token read from the file, and on a
// 2xx answer stamps `leasedTo: <nodeId>` into wok's own record, so no worker on wok claims it any more (src/node-affinity.js). On any failure the lease is
// cancelled and the record is left exactly as it was. reclaim: expires the leases whose time has come and removes `leasedTo` from wok's record when it still
// names the node of the expired lease, so the task goes back to wok's pool. Exit codes: 0 ok, 3 refused or failed, 2 usage. Nothing runs this by itself.

const fs = require('fs');
const path = require('path');
const { lendLease, cancelLease, expireLeases } = require('./lease-ledger.js');
const { httpPost } = require('./review-package.js');
const { writeJsonAtomicSync } = require('./atomic-write.js');

const POST_TIMEOUT_MS = 15000;
const QUEUES = ['pending', 'adhoc'];

// The queue file of a task on this machine, or null.
function findRecordFile(pipelineDir, taskId) {
  for (const q of QUEUES) {
    const file = path.join(pipelineDir, 'queue', q, `${taskId}.json`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function readToken(tokenFile) {
  try { return fs.readFileSync(tokenFile, 'utf8').trim(); } catch (e) { return ''; }
}

async function lendTask({ taskId, nodeId, pipelineDir, url, tokenFile, post = httpPost, now = Date.now(), env = process.env } = {}) {
  if (!taskId || !nodeId || !pipelineDir || !url) return { ok: false, reason: 'taskId, nodeId, pipelineDir and url are required' };
  const file = findRecordFile(pipelineDir, taskId);
  if (!file) return { ok: false, reason: `task ${taskId} is not in queue/pending or queue/adhoc` };
  const record = readJson(file);
  if (!record || typeof record !== 'object') return { ok: false, reason: 'the task record is not readable' };
  if (record.leasedTo) return { ok: false, reason: `task ${taskId} is already leased to ${record.leasedTo}` };
  const token = readToken(tokenFile);
  if (!token) return { ok: false, reason: 'the lender token file is missing or empty' };
  const lease = lendLease(taskId, nodeId, { now, env });
  if (!lease) return { ok: false, reason: `task ${taskId} already has a live lease` };
  let status = 0;
  try {
    const res = await post(url, { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, JSON.stringify({ task: record, lease: { taskId, nodeId, expiresAt: lease.expiresAt } }), POST_TIMEOUT_MS);
    status = Number(res && res.status) || 0;
  } catch (e) {
    status = 0;
  }
  if (status < 200 || status >= 300) {
    cancelLease(taskId, { env });
    return { ok: false, reason: status ? `the node answered ${status}` : 'the node could not be reached' };
  }
  const current = fs.existsSync(file) ? readJson(file) : null;
  if (!current) return { ok: false, reason: 'the record left the queue while lending; the node has it and the lease stays lent' };
  writeJsonAtomicSync(file, { ...current, leasedTo: nodeId });
  return { ok: true, reason: '', lease };
}

// Expires due leases and takes the tasks back. Returns the expired leases.
function reclaimExpired({ pipelineDir, now = Date.now(), env = process.env } = {}) {
  const expired = expireLeases({ now, env });
  for (const lease of expired) {
    const file = findRecordFile(pipelineDir, lease.taskId);
    const record = file ? readJson(file) : null;
    if (record && record.leasedTo === lease.nodeId) {
      delete record.leasedTo;
      writeJsonAtomicSync(file, record);
    }
  }
  return expired;
}

function flag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(argv, env = process.env, deps = {}, out = (s) => process.stdout.write(`${s}\n`)) {
  const [cmd, taskId, nodeId] = argv;
  const pipelineDir = String(env.AGENT_MANAGER_PIPELINE_DIR || '').trim();
  if (!pipelineDir) { process.stderr.write('AGENT_MANAGER_PIPELINE_DIR must be set\n'); return 2; }
  if (cmd === 'reclaim') {
    out(JSON.stringify(reclaimExpired({ pipelineDir, env })));
    return 0;
  }
  const url = flag(argv, '--url');
  const tokenFile = flag(argv, '--token-file');
  if (cmd !== 'lend' || !taskId || !nodeId || !url || !tokenFile) {
    process.stderr.write('usage: node src/lend-task.js lend <taskId> <nodeId> --url <url> --token-file <file> | reclaim\n');
    return 2;
  }
  const r = await lendTask({ taskId, nodeId, pipelineDir, url, tokenFile, env, ...deps });
  out(JSON.stringify({ ok: r.ok, reason: r.reason }));
  return r.ok ? 0 : 3;
}

if (require.main === module) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });

module.exports = { lendTask, reclaimExpired, findRecordFile, main, POST_TIMEOUT_MS };
