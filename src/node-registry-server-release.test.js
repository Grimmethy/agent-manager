'use strict';

// Tests for the release path of src/node-registry-server.js: POST /release clears leasedTo on the task record (best effort) so a returned task
// can be claimed again. Real lease ledger and real record files in temp dirs; the server is started on a loopback port.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createServer } = require('./node-registry-server.js');
const { registerNode } = require('./node-registry.js');
const { lendLease, leaseFor } = require('./lease-ledger.js');
const { pickClaimableTasks } = require('./next-claimable-task.js');

const T0 = Date.UTC(2026, 10, 15, 12, 0, 0);

function makePipeline() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-pipe-'));
  fs.mkdirSync(path.join(root, 'queue', 'pending'), { recursive: true });
  fs.mkdirSync(path.join(root, 'queue', 'adhoc'), { recursive: true });
  return root;
}

function recordFile(pipe, taskId) {
  return path.join(pipe, 'queue', 'pending', `${taskId}.json`);
}

function writeRecord(pipe, taskId, record) {
  fs.writeFileSync(recordFile(pipe, taskId), JSON.stringify(record, null, 2));
}

async function start(env, pipelineDirs) {
  const { token } = registerNode({ id: 'grimm', address: '127.0.0.1', cores: 4 }, env);
  const server = createServer({ env, now: () => T0, pipelineDirs, claimNext: () => null, recordEvent: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const post = (urlPath, body) => new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(data);
  });
  return { post, close: () => new Promise((r) => server.close(r)) };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-nodes-'));
  const env = { HOME: '/nonexistent-home', AGENT_MANAGER_NODES_DIR: dir, AGENT_MANAGER_DISABLED_WORKERS_DIR: path.join(dir, 'switch') };
  return { env };
}

test('a release by the leasing node clears leasedTo and leaves the other fields as they were', async () => {
  const { env } = setup();
  const pipe = makePipeline();
  const original = { id: 't1', title: 'Fix it', status: 'pending', priority: 3, leasedTo: 'grimm' };
  writeRecord(pipe, 't1', original);
  lendLease('t1', 'grimm', { now: T0, env });
  const s = await start(env, [pipe]);
  try {
    assert.deepEqual(await s.post('/release', { id: 'grimm', taskId: 't1' }), { status: 200, body: { ok: true } });
    const after = JSON.parse(fs.readFileSync(recordFile(pipe, 't1'), 'utf8'));
    assert.equal('leasedTo' in after, false);
    const { leasedTo, ...rest } = original;
    assert.deepEqual(after, rest);
    assert.equal(leaseFor('t1', env).state, 'returned');
  } finally { await s.close(); }
});

test('a record leased to ANOTHER node is left byte-identical by a release', async () => {
  const { env } = setup();
  const pipe = makePipeline();
  writeRecord(pipe, 't2', { id: 't2', title: 'Other', leasedTo: 'other' });
  const before = fs.readFileSync(recordFile(pipe, 't2'), 'utf8');
  lendLease('t2', 'grimm', { now: T0, env });
  const s = await start(env, [pipe]);
  try {
    assert.equal((await s.post('/release', { id: 'grimm', taskId: 't2' })).status, 200);
    assert.equal(fs.readFileSync(recordFile(pipe, 't2'), 'utf8'), before);
  } finally { await s.close(); }
});

test('the record is cleared when it sits in the second pipeline dir', async () => {
  const { env } = setup();
  const first = makePipeline();
  const second = makePipeline();
  writeRecord(second, 't3', { id: 't3', title: 'Second', leasedTo: 'grimm' });
  lendLease('t3', 'grimm', { now: T0, env });
  const s = await start(env, [first, second]);
  try {
    assert.equal((await s.post('/release', { id: 'grimm', taskId: 't3' })).status, 200);
    const after = JSON.parse(fs.readFileSync(recordFile(second, 't3'), 'utf8'));
    assert.equal('leasedTo' in after, false);
  } finally { await s.close(); }
});

test('a missing record still answers ok and the ledger row is returned', async () => {
  const { env } = setup();
  const pipe = makePipeline();
  lendLease('t4', 'grimm', { now: T0, env });
  const s = await start(env, [pipe]);
  try {
    assert.deepEqual(await s.post('/release', { id: 'grimm', taskId: 't4' }), { status: 200, body: { ok: true } });
    assert.equal(leaseFor('t4', env).state, 'returned');
  } finally { await s.close(); }
});

test('an unwritable record still answers ok and the ledger row is returned', async () => {
  const { env } = setup();
  const pipe = makePipeline();
  const queueDir = path.join(pipe, 'queue', 'pending');
  writeRecord(pipe, 't5', { id: 't5', title: 'Locked', leasedTo: 'grimm' });
  lendLease('t5', 'grimm', { now: T0, env });
  const s = await start(env, [pipe]);
  fs.chmodSync(queueDir, 0o555);
  try {
    assert.deepEqual(await s.post('/release', { id: 'grimm', taskId: 't5' }), { status: 200, body: { ok: true } });
    assert.equal(leaseFor('t5', env).state, 'returned');
    assert.equal(JSON.parse(fs.readFileSync(recordFile(pipe, 't5'), 'utf8')).leasedTo, 'grimm', 'the stamp stays when the write fails');
  } finally {
    fs.chmodSync(queueDir, 0o755);
    await s.close();
  }
});

test('after a release the record is claimable again by another node', async () => {
  const { env } = setup();
  const pipe = makePipeline();
  writeRecord(pipe, 't6', { id: 't6', title: 'Back in pool', leasedTo: 'grimm' });
  const pending = path.join(pipe, 'queue', 'pending');
  lendLease('t6', 'grimm', { now: T0, env });
  assert.equal(pickClaimableTasks(pending, 'wok', { nodeId: 'wok' }).includes('t6.json'), false, 'leased: not claimable by wok');
  const s = await start(env, [pipe]);
  try {
    assert.equal((await s.post('/release', { id: 'grimm', taskId: 't6' })).status, 200);
  } finally { await s.close(); }
  assert.ok(pickClaimableTasks(pending, 'wok', { nodeId: 'wok' }).includes('t6.json'), 'released: listed again');
});
