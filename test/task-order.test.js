'use strict';

// Tests for src/task-order.js: tiered stable ordering (pinned, defaults, catalog, unknown).

const test = require('node:test');
const assert = require('node:assert/strict');
const { orderTasks } = require('../src/task-order.js');

test('pinned item precedes a default item even when the default arrived first', () => {
  const out = orderTasks(['d1', 'p1'], { pinned: ['p1'], defaults: ['d1'] });
  assert.deepEqual(out, ['p1', 'd1']);
});

test('default item precedes a catalog item', () => {
  const out = orderTasks(['c1', 'd1'], { defaults: ['d1'], catalog: ['c1'] });
  assert.deepEqual(out, ['d1', 'c1']);
});

test('unknown items go last and keep their input order', () => {
  const out = orderTasks(['u2', 'c1', 'u1', 'd1'], { defaults: ['d1'], catalog: ['c1'] });
  assert.deepEqual(out, ['d1', 'c1', 'u2', 'u1']);
});

test('input array is not mutated', () => {
  const items = ['c1', 'u1', 'p1', 'd1'];
  const snapshot = items.slice();
  const out = orderTasks(items, { pinned: ['p1'], defaults: ['d1'], catalog: ['c1'] });
  assert.deepEqual(items, snapshot);
  assert.notEqual(out, items);
});

test('duplicate keys and empty input do not throw', () => {
  assert.deepEqual(orderTasks([], { pinned: ['p1'] }), []);
  assert.doesNotThrow(() => orderTasks(['d1', 'd1', 'x'], { defaults: ['d1', 'd1'] }));
  assert.deepEqual(orderTasks(['d1', 'd1', 'x'], { defaults: ['d1', 'd1'] }), ['d1', 'd1', 'x']);
});
