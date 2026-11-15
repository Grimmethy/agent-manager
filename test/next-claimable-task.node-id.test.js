'use strict';

// pickClaimableTasks(opts.nodeId): the node this worker runs on is the passed nodeId when given,
// else process.env.AGENT_MANAGER_NODE_ID, else the ledger owner (wok). Only the nodeId check is exercised here.

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pickClaimableTasks } = require('../src/next-claimable-task.js');

const savedEnv = process.env.AGENT_MANAGER_NODE_ID;

afterEach(() => {
  if (savedEnv === undefined) delete process.env.AGENT_MANAGER_NODE_ID;
  else process.env.AGENT_MANAGER_NODE_ID = savedEnv;
});

function setEnv(value) {
  if (value === undefined) delete process.env.AGENT_MANAGER_NODE_ID;
  else process.env.AGENT_MANAGER_NODE_ID = value;
}

// Builds <tmp>/queue/pending with the given task records and returns { pendingDir, instancesDir }.
function mk(tasks) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeid-test-'));
  const pendingDir = path.join(root, 'queue', 'pending');
  const instancesDir = path.join(root, 'instances');
  fs.mkdirSync(pendingDir, { recursive: true });
  fs.mkdirSync(instancesDir, { recursive: true });
  for (const [name, record] of Object.entries(tasks)) {
    fs.writeFileSync(path.join(pendingDir, name), JSON.stringify({ id: name.replace(/\.json$/, ''), title: name, ...record }));
  }
  return { pendingDir, instancesDir };
}

function pick(pendingDir, instancesDir, opts = {}) {
  return pickClaimableTasks(pendingDir, 'worker-1', { lanes: [{ id: 'worker-1' }], instancesDir, ...opts });
}

test('an explicit nodeId is used instead of AGENT_MANAGER_NODE_ID', () => {
  setEnv('node-env');
  const { pendingDir, instancesDir } = mk({
    'for-arg.json': { leasedTo: 'node-arg' },
    'for-env.json': { leasedTo: 'node-env' },
  });
  assert.deepEqual(pick(pendingDir, instancesDir, { nodeId: 'node-arg' }), ['for-arg.json']);
});

test('an explicit nodeId other than wok does not claim an unleased task', () => {
  setEnv(undefined);
  const { pendingDir, instancesDir } = mk({ 'free.json': {} });
  assert.deepEqual(pick(pendingDir, instancesDir, { nodeId: 'node-arg' }), []);
});

test('omitting nodeId falls back to AGENT_MANAGER_NODE_ID', () => {
  setEnv('node-env');
  const { pendingDir, instancesDir } = mk({
    'for-arg.json': { leasedTo: 'node-arg' },
    'for-env.json': { leasedTo: 'node-env' },
  });
  assert.deepEqual(pick(pendingDir, instancesDir), ['for-env.json']);
});

test('omitting nodeId with AGENT_MANAGER_NODE_ID unset claims unleased tasks as wok', () => {
  setEnv(undefined);
  const { pendingDir, instancesDir } = mk({ 'free.json': {} });
  assert.deepEqual(pick(pendingDir, instancesDir), ['free.json']);
});
