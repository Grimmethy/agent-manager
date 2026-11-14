'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { claimableOnNode, workerNode, LEDGER_OWNER } = require('./node-affinity.js');
const { pickClaimableTasks } = require('./next-claimable-task.js');

test('an unset or blank node id means the ledger owner, wok', () => {
  assert.equal(LEDGER_OWNER, 'wok');
  for (const v of [undefined, null, '', '   ']) assert.equal(workerNode(v), 'wok', JSON.stringify(v));
  assert.equal(workerNode(' grimm '), 'grimm');
});

test('an unleased task is claimable only on the ledger owner', () => {
  assert.equal(claimableOnNode({ id: 't' }, undefined), true);
  assert.equal(claimableOnNode({ id: 't' }, 'wok'), true);
  assert.equal(claimableOnNode({ id: 't' }, 'grimm'), false);
  assert.equal(claimableOnNode({ id: 't', leasedTo: '' }, 'grimm'), false, 'an empty leasedTo is no lease');
  assert.equal(claimableOnNode({ id: 't', leasedTo: '  ' }, undefined), true);
});

test('a leased task is claimable only on the node it is leased to, including wok when it is leased to wok', () => {
  assert.equal(claimableOnNode({ leasedTo: 'grimm' }, 'grimm'), true);
  assert.equal(claimableOnNode({ leasedTo: 'grimm' }, undefined), false);
  assert.equal(claimableOnNode({ leasedTo: 'grimm' }, 'wok'), false);
  assert.equal(claimableOnNode({ leasedTo: 'grimm' }, 'other'), false);
  assert.equal(claimableOnNode({ leasedTo: 'wok' }, undefined), true);
});

test('junk tasks: null, a non-string leasedTo (treated as unleased)', () => {
  assert.equal(claimableOnNode(null, undefined), true);
  assert.equal(claimableOnNode(null, 'grimm'), false);
  assert.equal(claimableOnNode({ leasedTo: 7 }, 'grimm'), false);
  assert.equal(claimableOnNode({ leasedTo: 7 }, undefined), true);
});

function pendingWith(...tasks) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'node-affinity-'));
  const dir = path.join(root, 'queue', 'pending');
  fs.mkdirSync(dir, { recursive: true });
  for (const t of tasks) fs.writeFileSync(path.join(dir, `${t.id}.json`), JSON.stringify({ source: 'trouble_log', promptContext: {}, ...t }));
  return dir;
}

function withNode(value, fn) {
  const saved = process.env.AGENT_MANAGER_NODE_ID;
  if (value === undefined) delete process.env.AGENT_MANAGER_NODE_ID; else process.env.AGENT_MANAGER_NODE_ID = value;
  try { return fn(); } finally { if (saved === undefined) delete process.env.AGENT_MANAGER_NODE_ID; else process.env.AGENT_MANAGER_NODE_ID = saved; }
}

test('the claim ranking offers a grimm worker only the grimm lease and a wok worker only the unleased task', () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'node-affinity-cache-'));
  process.env.AGENT_MANAGER_QUEUE_CACHE_DIR = cache;
  const dir = pendingWith({ id: 'lent', leasedTo: 'grimm' }, { id: 'home' }, { id: 'elsewhere', leasedTo: 'other' });
  assert.deepEqual(withNode('grimm', () => pickClaimableTasks(dir, 'worker-1')), ['lent.json']);
  assert.deepEqual(withNode(undefined, () => pickClaimableTasks(dir, 'worker-1')), ['home.json']);
  assert.deepEqual(withNode('', () => pickClaimableTasks(dir, 'worker-1')), ['home.json']);
  assert.deepEqual(withNode('other', () => pickClaimableTasks(dir, 'worker-1')), ['elsewhere.json']);
});

test('with no AGENT_MANAGER_NODE_ID and no lease anywhere the ranking is unchanged', () => {
  const dir = pendingWith({ id: 'a' }, { id: 'b' });
  assert.deepEqual(withNode(undefined, () => pickClaimableTasks(dir, 'worker-1')).sort(), ['a.json', 'b.json']);
});

test('a lease wins over an operator pin: a task pinned to this worker but leased to another node is not offered here', () => {
  const dir = pendingWith({ id: 'pinned', leasedTo: 'grimm', pinnedWorker: 'worker-1' });
  assert.deepEqual(withNode(undefined, () => pickClaimableTasks(dir, 'worker-1')), []);
  assert.deepEqual(withNode('grimm', () => pickClaimableTasks(dir, 'worker-1')), ['pinned.json']);
});
