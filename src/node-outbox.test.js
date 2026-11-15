'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isNodeWorker, main } = require('./node-outbox.js');

const SCRIPT = path.join(__dirname, 'node-outbox.js');

test('isNodeWorker is true only for a non-empty node id that is not wok', () => {
  assert.equal(isNodeWorker({ AGENT_MANAGER_NODE_ID: 'grimm' }), true);
  assert.equal(isNodeWorker({ AGENT_MANAGER_NODE_ID: '  grimm  ' }), true);
  assert.equal(isNodeWorker({ AGENT_MANAGER_NODE_ID: 'wok' }), false);
  assert.equal(isNodeWorker({ AGENT_MANAGER_NODE_ID: ' wok ' }), false);
  assert.equal(isNodeWorker({ AGENT_MANAGER_NODE_ID: '' }), false);
  assert.equal(isNodeWorker({ AGENT_MANAGER_NODE_ID: '   ' }), false);
  assert.equal(isNodeWorker({}), false);
});

test('isNodeWorker reads the process environment when no environment is given', () => {
  const saved = process.env.AGENT_MANAGER_NODE_ID;
  try {
    process.env.AGENT_MANAGER_NODE_ID = 'grimm';
    assert.equal(isNodeWorker(), true);
    delete process.env.AGENT_MANAGER_NODE_ID;
    assert.equal(isNodeWorker(), false);
  } finally {
    if (saved === undefined) delete process.env.AGENT_MANAGER_NODE_ID; else process.env.AGENT_MANAGER_NODE_ID = saved;
  }
});

test('main answers 0 on a node, 1 on wok, and 2 with a usage line for anything else', () => {
  const lines = [];
  const err = { write: (t) => lines.push(t) };
  assert.equal(main(['is-node'], { AGENT_MANAGER_NODE_ID: 'grimm' }, err), 0);
  assert.equal(main(['is-node'], {}, err), 1);
  assert.deepEqual(lines, []);
  for (const argv of [[], ['other'], ['is-node', 'extra'], ['IS-NODE']]) assert.equal(main(argv, { AGENT_MANAGER_NODE_ID: 'grimm' }, err), 2, JSON.stringify(argv));
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^usage: node src\/node-outbox\.js is-node\n$/);
});

test('the command line exits 0 on a node, 1 on wok and 2 on bad arguments', () => {
  const run = (args, nodeId) => {
    const env = { PATH: process.env.PATH };
    if (nodeId !== undefined) env.AGENT_MANAGER_NODE_ID = nodeId;
    return spawnSync(process.execPath, [SCRIPT, ...args], { env, encoding: 'utf8', timeout: 20000 });
  };
  assert.equal(run(['is-node'], 'grimm').status, 0);
  assert.equal(run(['is-node'], 'wok').status, 1);
  assert.equal(run(['is-node']).status, 1);
  const bad = run([], 'grimm');
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /usage/);
  assert.equal(bad.stdout, '');
});
