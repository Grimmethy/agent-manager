'use strict';

// Tests for the multi-pipeline lookup of src/package-intake-server.js: the registry may hand tasks out of several pipelines (AGENT_MANAGER_NODE_PIPELINE_DIRS),
// so a node's draft must find its original in any of them while the draft itself is filed in the intake's own pipeline. Temp dirs and a loopback port only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createServer, findOriginal, nodePipelineDirs } = require('./package-intake-server.js');
const { registerNode } = require('./node-registry.js');
const { lendLease, leaseFor } = require('./lease-ledger.js');
const { buildRecordPackage } = require('./review-package.js');

const ID = 'pool-task-1';
const DRAFT = { id: ID, title: 'T', rawDiff: 'diff --git a b', implementResponse: 'did it', status: 'drafting', leasedTo: 'grimm', localVotes: [1], history: [{ stage: 'draft-done' }] };

function setup(t, withExtra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'package-intake-multi-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const main = path.join(dir, 'main');
  const pool = path.join(dir, 'pool');
  const env = { HOME: dir, AGENT_MANAGER_NODES_DIR: path.join(dir, 'nodes'), AGENT_MANAGER_PIPELINE_DIR: main };
  if (withExtra) env.AGENT_MANAGER_NODE_PIPELINE_DIRS = ' ' + pool + ' ,, ';
  const { token } = registerNode({ id: 'grimm', address: '', cores: 4, ramGb: 15, concurrencyCap: 2 }, env);
  fs.mkdirSync(path.join(pool, 'queue', 'adhoc'), { recursive: true });
  const original = path.join(pool, 'queue', 'adhoc', ID + '.json');
  fs.writeFileSync(original, JSON.stringify({ id: ID, title: 'T', leasedTo: 'grimm' }));
  lendLease(ID, 'grimm', { env });
  return { dir, main, pool, env, token, original };
}

function post(port, token, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/package', agent: false, headers: { 'Content-Length': Buffer.byteLength(data), Authorization: 'Bearer ' + token } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

async function withServer(s, fn) {
  const server = createServer({ env: s.env, send: async () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { return await fn(server.address().port); } finally { server.close(); server.closeAllConnections(); }
}

test('nodePipelineDirs splits on commas, trims and drops empty entries', () => {
  assert.deepEqual(nodePipelineDirs({ AGENT_MANAGER_NODE_PIPELINE_DIRS: ' /a , ,/b,' }), ['/a', '/b']);
  assert.deepEqual(nodePipelineDirs({}), []);
});

test('findOriginal searches the extra pipelines after the main one, and the main one wins', (t) => {
  const s = setup(t, false);
  assert.equal(findOriginal(s.main, ID), null);
  assert.equal(findOriginal(s.main, ID, [s.pool]), s.original);
  fs.mkdirSync(path.join(s.main, 'queue', 'adhoc'), { recursive: true });
  const mainFile = path.join(s.main, 'queue', 'adhoc', ID + '.json');
  fs.writeFileSync(mainFile, JSON.stringify({ id: ID }));
  assert.equal(findOriginal(s.main, ID, [s.pool]), mainFile);
  fs.writeFileSync(mainFile, 'not json');
  assert.equal(findOriginal(s.main, ID, [s.pool]), s.original);
});

test('a draft whose original sits in a node pipeline is filed in the main pipeline review and the original is removed', async (t) => {
  const s = setup(t, true);
  const pkg = buildRecordPackage({ record: DRAFT, nodeId: 'grimm', now: Date.UTC(2026, 10, 15) });
  await withServer(s, async (port) => {
    const r = await post(port, s.token, pkg);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, taskId: ID });
  });
  assert.equal(fs.existsSync(s.original), false);
  const draft = JSON.parse(fs.readFileSync(path.join(s.main, 'queue', 'review', ID + '.json'), 'utf8'));
  assert.equal(draft.fromNode, 'grimm');
  assert.equal('leasedTo' in draft, false);
  assert.equal(fs.existsSync(path.join(s.pool, 'queue', 'review')), false);
  assert.equal(leaseFor(ID, s.env).state, 'returned');
});

test('without AGENT_MANAGER_NODE_PIPELINE_DIRS the same draft is still a 409 and nothing is moved', async (t) => {
  const s = setup(t, false);
  const pkg = buildRecordPackage({ record: DRAFT, nodeId: 'grimm', now: Date.UTC(2026, 10, 15) });
  await withServer(s, async (port) => {
    const r = await post(port, s.token, pkg);
    assert.equal(r.status, 409);
    assert.match(r.json.error, /original/);
  });
  assert.equal(fs.existsSync(s.original), true);
  assert.equal(fs.existsSync(path.join(s.main, 'queue', 'review', ID + '.json')), false);
  assert.equal(leaseFor(ID, s.env).state, 'lent');
});
