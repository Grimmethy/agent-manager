'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyGeneratedLease } = require('../src/node-generated-lease.js');
const { registerTaskSource } = require('../src/task-source-registry.js');

registerTaskSource('node_lease_test_core', { scope: 'core', next: () => null });
registerTaskSource('node_lease_test_plain', { next: () => null });

const coreTask = () => ({ id: 'T1', source: 'node_lease_test_core' });

test('grimm node with a core-scope source leases the task', () => {
  const task = coreTask();
  assert.equal(applyGeneratedLease(task, { AGENT_MANAGER_NODE_ID: 'grimm' }), 'lease');
  assert.equal(task.leasedTo, 'grimm');
});

test('wok node leaves the task unleased', () => {
  const task = coreTask();
  assert.equal(applyGeneratedLease(task, { AGENT_MANAGER_NODE_ID: 'wok' }), 'leave');
  assert.equal(task.leasedTo, undefined);
});

test('unset node id leaves the task unleased', () => {
  const task = coreTask();
  assert.equal(applyGeneratedLease(task, {}), 'leave');
  assert.equal(task.leasedTo, undefined);
});

test('non-core source leaves the task unleased', () => {
  const task = { id: 'T2', source: 'node_lease_test_plain' };
  assert.equal(applyGeneratedLease(task, { AGENT_MANAGER_NODE_ID: 'grimm' }), 'leave');
  assert.equal(task.leasedTo, undefined);
});

test('existing leasedTo is left untouched', () => {
  const task = { ...coreTask(), leasedTo: 'other' };
  assert.equal(applyGeneratedLease(task, { AGENT_MANAGER_NODE_ID: 'grimm' }), 'leave');
  assert.equal(task.leasedTo, 'other');
});

test('unknown source never throws and leaves the task unleased', () => {
  const task = { id: 'T3', source: 'no_such_source_for_lease_test' };
  assert.doesNotThrow(() => applyGeneratedLease(task, { AGENT_MANAGER_NODE_ID: 'grimm' }));
  assert.equal(applyGeneratedLease(task, { AGENT_MANAGER_NODE_ID: 'grimm' }), 'leave');
  assert.equal(task.leasedTo, undefined);
});
