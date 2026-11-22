'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createServer, normalizeIp, bearer } = require('./node-registry-server.js');
const { registerNode, loadNodes } = require('./node-registry.js');
const { setPause } = require('./worker-switch.js');

const T0 = Date.UTC(2026, 10, 11, 12, 0, 0);

async function start(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-intake-'));
  const env = { HOME: '/nonexistent-home', AGENT_MANAGER_NODES_DIR: dir, AGENT_MANAGER_DISABLED_WORKERS_DIR: path.join(dir, 'switch') };
  const { token } = registerNode({ id: 'grimm', address: opts.address === undefined ? '127.0.0.1' : opts.address, cores: 4 }, env);
  const sweeps = [];
  const server = createServer({ env, now: () => T0, sweep: opts.sweep || (async () => { sweeps.push(1); }), ...(opts.server || {}) });
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
  return { env, token, sweeps, post, auth: { Authorization: `Bearer ${token}` }, close: () => new Promise((r) => server.close(r)) };
}

test('a valid heartbeat is recorded and answered with ok, globalPause false and the server time', async () => {
  const s = await start();
  try {
    const r = await s.post({ id: 'grimm', state: 'up', load: 0.5, freeRamGb: 11, paused: false }, s.auth);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, globalPause: false, serverTime: '2026-11-11T12:00:00.000Z' });
    const rec = loadNodes(s.env).grimm;
    assert.equal(rec.lastSeen, '2026-11-11T12:00:00.000Z');
    assert.equal(rec.freeRamGb, 11);
    assert.equal(s.sweeps.length, 1, 'every heartbeat is followed by a sweep');
  } finally { await s.close(); }
});

test('a missing, malformed or wrong token and an unknown node all get the same 401 and record nothing', async () => {
  const s = await start();
  try {
    const answers = [];
    for (const [body, headers] of [[{ id: 'grimm' }, {}], [{ id: 'grimm' }, { Authorization: 'Bearer nope' }], [{ id: 'grimm' }, { Authorization: s.token }], [{ id: 'ghost' }, s.auth], [{}, s.auth]]) {
      const r = await s.post(body, headers);
      assert.equal(r.status, 401);
      answers.push(JSON.stringify(r.body));
    }
    assert.equal(new Set(answers).size, 1);
    assert.equal(loadNodes(s.env).grimm.lastSeen, null);
    assert.equal(s.sweeps.length, 0);
  } finally { await s.close(); }
});

test('a request from an address other than the registered one is a 403 and records nothing; no registered address means any address', async () => {
  const wrong = await start({ address: '10.9.9.9' });
  try {
    const r = await wrong.post({ id: 'grimm' }, wrong.auth);
    assert.equal(r.status, 403);
    assert.equal(loadNodes(wrong.env).grimm.lastSeen, null);
  } finally { await wrong.close(); }
  const open = await start({ address: '' });
  try {
    assert.equal((await open.post({ id: 'grimm' }, open.auth)).status, 200);
  } finally { await open.close(); }
});

test('bad bodies are 400: not JSON, an array, an oversized body, a bad state, a non-boolean paused', async () => {
  const s = await start();
  try {
    assert.equal((await s.post('not json', s.auth)).status, 400);
    assert.equal((await s.post('[1,2]', s.auth)).status, 400);
    assert.equal((await s.post('null', s.auth)).status, 400);
    const big = await s.post({ id: 'grimm', pad: 'x'.repeat(9000) }, s.auth);
    assert.equal(big.status, 400);
    assert.equal(big.body.error, 'body too large');
    const state = await s.post({ id: 'grimm', state: 'sleeping' }, s.auth);
    assert.equal(state.status, 400);
    assert.match(state.body.error, /state must be one of/);
    assert.equal((await s.post({ id: 'grimm', paused: 'yes' }, s.auth)).status, 400);
    assert.equal(loadNodes(s.env).grimm.lastSeen, null);
  } finally { await s.close(); }
});

test('only POST /heartbeat exists: other paths are 404, other methods on it are 405', async () => {
  const s = await start();
  try {
    assert.equal((await s.post({}, s.auth, '/nodes')).status, 404);
    assert.equal((await s.post({}, s.auth, '/')).status, 404);
    assert.equal((await s.post({}, s.auth, '/heartbeat/extra')).status, 404);
    assert.equal((await s.post('', s.auth, '/heartbeat', 'GET')).status, 405);
    assert.equal((await s.post({ id: 'grimm' }, s.auth, '/heartbeat?x=1')).status, 200, 'a query string is ignored');
  } finally { await s.close(); }
});

test('globalPause is true while a global pause set here is active, and false for an expired one or one that came from wok', async () => {
  const s = await start();
  try {
    setPause('global', { source: 'dashboard', ttlMin: 10 }, s.env, T0);
    assert.equal((await s.post({ id: 'grimm' }, s.auth)).body.globalPause, true);
    setPause('global', { source: 'dashboard', ttlMin: 10 }, s.env, T0 - 20 * 60 * 1000);
    assert.equal((await s.post({ id: 'grimm' }, s.auth)).body.globalPause, false, 'expired');
    setPause('global', { source: 'wok', ttlMin: 10 }, s.env, T0);
    assert.equal((await s.post({ id: 'grimm' }, s.auth)).body.globalPause, false, 'a pause that came from wok is not echoed back');
    setPause('node', { source: 'dashboard' }, s.env, T0);
    setPause('global', { source: 'operator' }, s.env, T0);
    assert.equal((await s.post({ id: 'grimm' }, s.auth)).body.globalPause, true);
  } finally { await s.close(); }
});

test('a sweep that throws does not fail the heartbeat', async () => {
  const s = await start({ sweep: async () => { throw new Error('notifier down'); } });
  try {
    const r = await s.post({ id: 'grimm' }, s.auth);
    assert.equal(r.status, 200);
    assert.equal(loadNodes(s.env).grimm.lastSeen, '2026-11-11T12:00:00.000Z');
  } finally { await s.close(); }
});

test('/claim answers idle with task null and a 60 second retry when the queue is empty', async () => {
  const s = await start({ server: { claimNext: () => null } });
  try {
    const r = await s.post({ id: 'grimm' }, s.auth, '/claim');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, task: null, retryAfterSec: 60 });
  } finally { await s.close(); }
});

test('/claim never calls claimNext for a paused node and answers idle', async () => {
  let calls = 0;
  const s = await start({ server: { claimNext: () => { calls += 1; return { task: { id: 'T1' }, lease: {}, repo: '/repo' }; } } });
  try {
    await s.post({ id: 'grimm', state: 'up', paused: true }, s.auth);
    const r = await s.post({ id: 'grimm' }, s.auth, '/claim');
    assert.deepEqual(r.body, { ok: true, task: null, retryAfterSec: 60 });
    assert.equal(calls, 0);
  } finally { await s.close(); }
});

test('/claim with a claimable task answers the task, lease and repo and passes the node id and classes', async () => {
  const seen = [];
  const s = await start({ server: { claimNext: (args) => { seen.push(args); return { task: { id: 'T1' }, lease: { taskId: 'T1' }, repo: '/repo' }; } } });
  try {
    const r = await s.post({ id: 'grimm', classes: ['adhoc'] }, s.auth, '/claim');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, task: { id: 'T1' }, lease: { taskId: 'T1' }, repo: '/repo' });
    assert.equal(seen[0].nodeId, 'grimm');
    assert.equal(seen[0].claimant, 'grimm');
    assert.deepEqual(seen[0].classes, ['adhoc']);
  } finally { await s.close(); }
});

test('/event answers 503 without recordEvent, 400 on an event outside the six, and calls recordEvent otherwise', async () => {
  const bare = await start();
  try {
    const r = await bare.post({ id: 'grimm', taskId: 'T1', event: 'merged' }, bare.auth, '/event');
    assert.equal(r.status, 503);
    assert.equal(r.body.error, 'events unavailable');
  } finally { await bare.close(); }
  const recorded = [];
  const s = await start({ server: { recordEvent: async (e) => { recorded.push(e); } } });
  try {
    assert.equal((await s.post({ id: 'grimm', taskId: 'T1', event: 'exploded' }, s.auth, '/event')).status, 400);
    const ok = await s.post({ id: 'grimm', taskId: 'T1', event: 'merged' }, s.auth, '/event');
    assert.deepEqual(ok.body, { ok: true });
    assert.deepEqual(recorded, [{ id: 'grimm', taskId: 'T1', event: 'merged' }]);
  } finally { await s.close(); }
});

test('/release returns the lease only when this node holds it, and answers 409 when returnLease reports nothing lent', async () => {
  const returned = [];
  let holder = 'grimm';
  let lent = true;
  const s = await start({ server: {
    leaseFor: () => (holder ? { nodeId: holder } : null),
    returnLease: (taskId) => { returned.push(taskId); return lent; },
  } });
  try {
    assert.deepEqual((await s.post({ id: 'grimm', taskId: 'T1' }, s.auth, '/release')).body, { ok: true });
    assert.deepEqual(returned, ['T1']);
    holder = 'someone-else';
    assert.equal((await s.post({ id: 'grimm', taskId: 'T1' }, s.auth, '/release')).status, 409);
    assert.deepEqual(returned, ['T1'], 'a lease held by another node is not returned');
    holder = 'grimm';
    lent = false;
    assert.equal((await s.post({ id: 'grimm', taskId: 'T1' }, s.auth, '/release')).status, 409);
  } finally { await s.close(); }
});

test('normalizeIp strips the IPv4-mapped prefix and bearer reads exactly one token', () => {
  assert.equal(normalizeIp('::ffff:192.168.40.83'), '192.168.40.83');
  assert.equal(normalizeIp('192.168.40.83'), '192.168.40.83');
  assert.equal(normalizeIp(undefined), '');
  assert.equal(bearer('Bearer abc123'), 'abc123');
  for (const bad of ['', 'bearer abc', 'Bearer', 'Bearer a b', 'Basic abc', undefined]) assert.equal(bearer(bad), '', String(bad));
});
