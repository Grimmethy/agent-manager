'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { returnHeldOnPause, isNodeExcluded } = require('./node-return-on-pause.js');

function world(leases, records) {
  const calls = [];
  const deps = {
    listLeases: () => leases,
    returnLease: (taskId) => {
      calls.push(taskId);
      const l = leases.find((x) => x.taskId === taskId);
      if (!l || l.state !== 'lent') return null;
      l.state = 'returned';
      return l;
    },
    readRecord: (taskId) => (records[taskId] ? JSON.parse(JSON.stringify(records[taskId])) : null),
    writeRecord: (taskId, rec) => { records[taskId] = rec; },
    now: 0,
    env: {},
  };
  return { deps, calls, records };
}

test('returns only lent, result-less leases of the paused node, clears leasedTo only on match, sorts premium first', () => {
  const leases = [
    { taskId: 'a', nodeId: 'n1', state: 'lent' },
    { taskId: 'b', nodeId: 'n1', state: 'lent' },
    { taskId: 'c', nodeId: 'n2', state: 'lent' },
    { taskId: 'd', nodeId: 'n1', state: 'returned' },
    { taskId: 'e', nodeId: 'n1', state: 'lent', result: 'done' },
  ];
  const records = {
    a: { leasedTo: 'n1' },
    b: { leasedTo: 'n1', premiumPriority: true },
    c: { leasedTo: 'n2' },
  };
  const w = world(leases, records);
  const out = returnHeldOnPause('n1', w.deps);

  assert.deepEqual(w.calls, ['a', 'b']);
  assert.deepEqual(out.map((e) => e.taskId), ['b', 'a']);
  assert.equal(out[0].premiumPriority, true);
  assert.equal('leasedTo' in w.records.a, false);
  assert.equal('leasedTo' in w.records.b, false);
  assert.equal(w.records.c.leasedTo, 'n2');
  assert.equal(leases.find((l) => l.taskId === 'c').state, 'lent');
  assert.equal(isNodeExcluded('n1'), true);
});

test('leaves leasedTo alone when the record names a different node', () => {
  const leases = [{ taskId: 'x', nodeId: 'n1', state: 'lent' }];
  const w = world(leases, { x: { leasedTo: 'other' } });
  returnHeldOnPause('n1', w.deps);
  assert.equal(w.records.x.leasedTo, 'other');
});

test('requires nodeId', () => {
  assert.throws(() => returnHeldOnPause('', {}));
});
