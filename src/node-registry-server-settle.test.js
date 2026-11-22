'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createServer } = require('./node-registry-server.js');
const { registerNode, loadNodes } = require('./node-registry.js');
const { lendLease, leaseFor } = require('./lease-ledger.js');

const T0 = Date.UTC(2026, 10, 11, 12, 0, 0);
const HOUR = 3600 * 1000;

async function start(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-settle-'));
  const nodesDir = path.join(dir, 'nodes');
  const pipelineDir = path.join(dir, 'pipeline');
  fs.mkdirSync(path.join(pipelineDir, 'queue', 'adhoc'), { recursive: true });
  const env = {
    HOME: '/nonexistent-home',
    AGENT_MANAGER_NODES_DIR: nodesDir,
    AGENT_MANAGER_DISABLED_WORKERS_DIR: path.join(dir, 'switch'),
    AGENT_MANAGER_NODE_ID: 'wok',
  };
  const { token } = registerNode({ id: 'grimm', address: '127.0.0.1', cores: 4 }, env);
  const sweeps = [];
  const server = createServer({
    env,
    now: () => T0,
    sweep: opts.sweep || (async () => { sweeps.push(1); }),
    pipelineDirs: [pipelineDir],
    ...(opts.server || {}),
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const post = (body, headers = {}, urlPath = '/heartbeat', method = 'POST') => new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(method === 'GET' ? undefined : data);
  });
  return { env, pipelineDir, nodesDir, token, sweeps, post, auth: { Authorization: `Bearer ${token}` }, close: () => new Promise((r) => server.close(r)) };
}

function writeTask(pipelineDir, id) {
  fs.writeFileSync(path.join(pipelineDir, 'queue', 'adhoc', `${id}.json`), JSON.stringify({ id }));
}

test('an overdue lent lease answered merged closes the lease and the claim does not re-claim it', async () => {
  const asked = [];
  const s = await start({ server: {
    settleAskNode: async (node, taskId) => { asked.push([node, taskId]); return 'merged'; },
  } });
  try {
    lendLease('T1', 'grimm', { now: T0 - 2 * HOUR, env: s.env });
    writeTask(s.pipelineDir, 'T2');
    const r = await s.post({ id: 'grimm' }, s.auth, '/claim');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(asked.length, 1);
    assert.deepEqual(asked[0], ['grimm', 'T1']);
    const lease = leaseFor('T1', s.env);
    assert.equal(lease.state, 'merged', 'the lease is closed by settlement');
    assert.equal(lease.mergedAt, new Date(T0).toISOString());
  } finally { await s.close(); }
});

test('an overdue lent lease answered in-progress renews the lease so it is not claimable', async () => {
  const s = await start({ server: { settleAskNode: async () => 'in-progress' } });
  try {
    lendLease('T1', 'grimm', { now: T0 - 2 * HOUR, env: s.env });
    writeTask(s.pipelineDir, 'T1');
    const r = await s.post({ id: 'grimm' }, s.auth, '/claim');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.task, null, 'the renewed lease is not claimable');
    const lease = leaseFor('T1', s.env);
    assert.equal(lease.state, 'lent');
    assert.equal(lease.expiresAt, new Date(T0 + HOUR).toISOString());
    assert.equal(lease.renewedAt, new Date(T0).toISOString());
  } finally { await s.close(); }
});

test('an overdue lent lease answered unknown returns the task to the pool and the same claim takes it', async () => {
  const s = await start({ server: { settleAskNode: async () => 'unknown' } });
  try {
    lendLease('T1', 'grimm', { now: T0 - 2 * HOUR, env: s.env });
    writeTask(s.pipelineDir, 'T1');
    const r = await s.post({ id: 'grimm' }, s.auth, '/claim');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.task.id, 'T1', 'the released task is taken by the same claim');
    const lease = leaseFor('T1', s.env);
    assert.equal(lease.state, 'lent');
  } finally { await s.close(); }
});

test('a throwing askNode does not fail the claim', async () => {
  const s = await start({ server: { settleAskNode: async () => { throw new Error('node unreachable'); } } });
  try {
    lendLease('T1', 'grimm', { now: T0 - 2 * HOUR, env: s.env });
    writeTask(s.pipelineDir, 'T1');
    const r = await s.post({ id: 'grimm' }, s.auth, '/claim');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true, 'the claim succeeds even though askNode threw');
  } finally { await s.close(); }
});

test('a live lease is never asked, checked with a counting fake', async () => {
  let calls = 0;
  const s = await start({ server: { settleAskNode: async () => { calls += 1; return 'merged'; } } });
  try {
    lendLease('T1', 'grimm', { now: T0 - 30 * 60 * 1000, env: s.env });
    const r = await s.post({ id: 'grimm' }, s.auth, '/claim');
    assert.equal(r.status, 200);
    assert.equal(calls, 0, 'a live lease is never asked');
  } finally { await s.close(); }
});

test('an overdue lease answered blocked leaves a node-blocked trace on the wok record and the same claim does not hand it back', async () => {
  const s = await start({ server: { settleAskNode: async () => ({ answer: 'blocked', reason: 'plan limit' }) } });
  try {
    lendLease('T5', 'grimm', { now: T0 - 2 * HOUR, env: s.env });
    const file = path.join(s.pipelineDir, 'queue', 'adhoc', 'T5.json');
    fs.writeFileSync(file, JSON.stringify({ id: 'T5', leasedTo: 'grimm', history: [{ stage: 'node-blocked grimm' }, { stage: 'node-blocked grimm' }] }));
    const r = await s.post({ id: 'grimm' }, s.auth, '/claim');
    assert.equal(r.status, 200);
    assert.equal(r.body.task, null, 'blocked twice on this node: not offered to it again');
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(rec.leasedTo, undefined);
    assert.equal(rec.history.at(-1).stage, 'node-blocked grimm');
    assert.equal(leaseFor('T5', s.env).lastEvent, 'blocked');
  } finally { await s.close(); }
});

test('every claim heals a record whose ledger row is no longer lent but still carries leasedTo', async () => {
  const s = await start({ server: { settleAskNode: async () => 'in-progress' } });
  try {
    const { expireLeases } = require('./lease-ledger.js');
    lendLease('T6', 'grimm', { now: T0 - 2 * HOUR, ttlMs: 1000, env: s.env });
    expireLeases({ now: T0, env: s.env });
    const file = path.join(s.pipelineDir, 'queue', 'adhoc', 'T6.json');
    fs.writeFileSync(file, JSON.stringify({ id: 'T6', leasedTo: 'grimm' }));
    const r = await s.post({ id: 'grimm', classes: ['no-such-class'] }, s.auth, '/claim');
    assert.equal(r.body.task, null, 'the class filter keeps this claim from taking T6, so only the healing can have touched the record');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).leasedTo, undefined);
  } finally { await s.close(); }
});
