'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerTaskSource, getRegisteredSource, updateTaskSource, clearRegistry } = require('./task-source-registry.js');

test.beforeEach(() => clearRegistry());
test.afterEach(() => clearRegistry());

test('a falsy gate makes next() return null and never calls the source', () => {
  let called = false;
  registerTaskSource('s', { gate: () => false, next: () => { called = true; return { id: 'x' }; } });
  assert.equal(getRegisteredSource('s').next(), null);
  assert.equal(called, false);
});

test('a truthy gate passes arguments through and returns the inner result', () => {
  registerTaskSource('s', { gate: () => true, next: (a, b) => ({ sum: a + b }) });
  assert.deepEqual(getRegisteredSource('s').next(1, 2), { sum: 3 });
});

test('a source without a gate is unchanged', () => {
  const next = () => ({ id: 'plain' });
  registerTaskSource('s', { next });
  assert.equal(getRegisteredSource('s').next, next);
});

test('a non-function gate throws at registration and update', () => {
  assert.throws(() => registerTaskSource('s', { gate: 'yes', next: () => null }), /gate must be a function/);
  registerTaskSource('t', { next: () => null });
  assert.throws(() => updateTaskSource('t', { gate: true }), /gate must be a function/);
});

test('the gate is re-evaluated on every call', () => {
  let open = false;
  registerTaskSource('s', { gate: () => open, next: () => ({ id: 'x' }) });
  const src = getRegisteredSource('s');
  assert.equal(src.next(), null);
  open = true;
  assert.deepEqual(src.next(), { id: 'x' });
});

test('updateTaskSource gates a next() attached later', () => {
  registerTaskSource('s', { gate: () => false });
  updateTaskSource('s', { next: () => ({ id: 'x' }) });
  assert.equal(getRegisteredSource('s').next(), null);
});
