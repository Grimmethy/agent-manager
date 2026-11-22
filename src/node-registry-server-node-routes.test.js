'use strict';

// Tests for the node routes /claim, /event and /release of src/node-registry-server.js (grimm-as-a-node piece 3b). Every collaborator is injected
// (claimNext, recordEvent, leaseFor, returnLease), so no queue, ledger or clock is touched; only the registry files in a temp dir.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createServer } = require('./node-registry-server.js');
const { registerNode, recordHeartbeat } = require('./node-registry.js');

const T0 = Date.UTC(2026, 10, 15, 12, 0, 0);

async function start(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-routes-'));
  const env = { HOME: '/nonexistent-home', AGENT_MANAGER_NODES_DIR: dir, AGENT_MANAGER_DISABLED_WORKERS_DIR: path.join(dir, 'switch') };
  const { token } = registerNode({ id: 'grimm', address: opts.address === undefined ? '127.0.0.1' : opts.address, cores: 4 }, env);
  if (opts.paused) recordHeartbeat({ id: 'grimm', state: 'up', load: 0, freeRamGb: 8, paused: true }, env, T0);
  const server = createServer({ env, now: () => T0, pipelineDirs: ['/pipes/a'], ...(opts.deps || {}) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const post = (urlPath, body, headers = {}, method = 'POST') => new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(method === 'GET' ? undefined : data);
  });
  return { env, post, auth: { Authorization: `Bearer ${token}` }, close: () => new Promise((r) => server.close(r)) };
}

const TASK = { task: { id: 't1' }, lease: { taskId: 't1', nodeId: 'grimm' }, repo: { root: '/pipes/a', remoteUrl: 'git@example.test:x/y.git' } };

test('/claim hands out the claimed task, lease and repo, and passes the node id as nodeId and claimant with its classes and the pipelines', async () => {
  const calls = [];
  const s = await start({ deps: { claimNext: (args) => { calls.push(args); return TASK; } } });
  try {
    const r = await s.post('/claim', { id: 'grimm', classes: ['adhoc'] }, s.auth);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, ...TASK });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].nodeId, 'grimm');
    assert.equal(calls[0].claimant, 'grimm');
    assert.deepEqual(calls[0].classes, ['adhoc']);
    assert.deepEqual(calls[0].pipelineDirs, ['/pipes/a']);
  } finally { await s.close(); }
});

test('/claim answers idle with a retry delay when there is nothing to claim', async () => {
  const s = await start({ deps: { claimNext: () => null } });
  try {
    const r = await s.post('/claim', { id: 'grimm' }, s.auth);
    assert.deepEqual(r.body, { ok: true, task: null, retryAfterSec: 60 });
  } finally { await s.close(); }
});

test('/claim never calls claimNext for a paused node and answers idle', async () => {
  let called = 0;
  const s = await start({ paused: true, deps: { claimNext: () => { called += 1; return TASK; } } });
  try {
    const r = await s.post('/claim', { id: 'grimm' }, s.auth);
    assert.deepEqual(r.body, { ok: true, task: null, retryAfterSec: 60 });
    assert.equal(called, 0);
  } finally { await s.close(); }
});

test('/event rejects an unknown event or a missing taskId with 400, answers 503 without recordEvent, and records a good event', async () => {
  const noRecorder = await start();
  try {
    assert.equal((await noRecorder.post('/event', { id: 'grimm', taskId: 't1', event: 'merged' }, noRecorder.auth)).status, 503);
    assert.equal((await noRecorder.post('/event', { id: 'grimm', taskId: 't1', event: 'exploded' }, noRecorder.auth)).status, 400);
    assert.equal((await noRecorder.post('/event', { id: 'grimm', event: 'merged' }, noRecorder.auth)).status, 400);
  } finally { await noRecorder.close(); }
  const seen = [];
  const s = await start({ deps: { recordEvent: (e) => { seen.push(e); } } });
  try {
    for (const event of ['drafted', 'reviewed', 'applied', 'merged', 'blocked', 'failed']) {
      const r = await s.post('/event', { id: 'grimm', taskId: 't1', event }, s.auth);
      assert.deepEqual(r, { status: 200, body: { ok: true } });
    }
    assert.deepEqual(seen[0], { id: 'grimm', taskId: 't1', event: 'drafted' });
    assert.equal(seen.length, 6);
    assert.equal((await s.post('/event', { id: 'grimm', taskId: 't1', event: 'exploded' }, s.auth)).status, 400);
    assert.equal(seen.length, 6, 'an invalid event is never recorded');
  } finally { await s.close(); }
});

test('/release returns the lease only when it is held by the calling node', async () => {
  const returned = [];
  const leases = { mine: { taskId: 'mine', nodeId: 'grimm' }, theirs: { taskId: 'theirs', nodeId: 'other' } };
  const s = await start({ deps: { leaseFor: (id) => leases[id] || null, returnLease: (id) => { returned.push(id); return true; } } });
  try {
    assert.equal((await s.post('/release', { id: 'grimm', taskId: 'theirs' }, s.auth)).status, 409);
    assert.equal((await s.post('/release', { id: 'grimm', taskId: 'nobody' }, s.auth)).status, 409);
    assert.equal((await s.post('/release', { id: 'grimm' }, s.auth)).status, 400);
    assert.deepEqual(returned, [], 'nothing is returned for a lease the node does not hold');
    assert.deepEqual(await s.post('/release', { id: 'grimm', taskId: 'mine' }, s.auth), { status: 200, body: { ok: true } });
    assert.deepEqual(returned, ['mine']);
  } finally { await s.close(); }
});

test('/release answers 409 when the ledger has no lent lease left to return', async () => {
  const s = await start({ deps: { leaseFor: () => ({ taskId: 't', nodeId: 'grimm' }), returnLease: () => null } });
  try {
    assert.equal((await s.post('/release', { id: 'grimm', taskId: 't' }, s.auth)).status, 409);
  } finally { await s.close(); }
});

test('every node route keeps the heartbeat checks: 401 bad token, 403 wrong address, 400 non-object body, 405 other methods; unknown paths stay 404', async () => {
  const deps = { claimNext: () => TASK, recordEvent: () => {}, leaseFor: () => ({ taskId: 't', nodeId: 'grimm' }), returnLease: () => true };
  const s = await start({ deps });
  const wrongAddress = await start({ address: '10.9.9.9', deps });
  try {
    for (const route of ['/claim', '/event', '/release']) {
      const body = { id: 'grimm', taskId: 't', event: 'merged' };
      assert.equal((await s.post(route, body, {})).status, 401, `${route} without a token`);
      assert.equal((await s.post(route, body, { Authorization: 'Bearer nope' })).status, 401, `${route} with a wrong token`);
      assert.equal((await s.post(route, [1, 2], s.auth)).status, 400, `${route} with an array body`);
      assert.equal((await s.post(route, 'not json', s.auth)).status, 400, `${route} with a body that is not JSON`);
      assert.equal((await s.post(route, body, wrongAddress.auth)).status, 401, `${route} with another node's token`);
      assert.equal((await wrongAddress.post(route, body, wrongAddress.auth)).status, 403, `${route} from a wrong address`);
      assert.equal((await s.post(route, body, s.auth, 'GET')).status, 405, `${route} with GET`);
    }
    assert.equal((await s.post('/claimx', { id: 'grimm' }, s.auth)).status, 404);
    assert.equal((await s.post('/__proto__', { id: 'grimm' }, s.auth)).status, 404);
  } finally { await s.close(); await wrongAddress.close(); }
});
