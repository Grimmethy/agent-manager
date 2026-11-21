'use strict';
// Run: node --test python/dashboard/static/js/nav-diff.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { navChanges } = require('./nav-diff.js');

const makeNav = (overrides = {}) => ({
  activeKey: 'a',
  groups: { g1: { collapsed: false } },
  tabs: [
    { key: 'a', group: 'g1', label: 'Alpha', count: 1, severity: null, indent: false },
    { key: 'b', group: 'g1', label: 'Beta', count: 0, severity: null, indent: false },
    { key: 'c', group: 'g1', label: 'Gamma', count: 5, severity: 'warn', indent: false },
  ],
  ...overrides,
});

test('counts-only change yields only setBadge ops', () => {
  const prev = makeNav();
  const next = makeNav();
  next.tabs[2] = { ...next.tabs[2], count: 9, severity: 'error' };
  const ops = navChanges(prev, next);
  assert.ok(ops.length > 0);
  for (const op of ops) assert.equal(op.op, 'setBadge');
  assert.deepEqual(ops, [{ op: 'setBadge', key: 'c', text: '9', severity: 'error' }]);
});

test('a tab added yields an add op', () => {
  const prev = makeNav();
  const next = makeNav();
  next.tabs.push({ key: 'd', group: 'g1', label: 'Delta', count: 0, severity: null, indent: false });
  const ops = navChanges(prev, next);
  assert.ok(ops.some((o) => o.op === 'add' && o.key === 'd'));
});

test('a tab removed yields a remove op', () => {
  const prev = makeNav();
  const next = makeNav();
  next.tabs = next.tabs.filter((t) => t.key !== 'b');
  const ops = navChanges(prev, next);
  assert.ok(ops.some((o) => o.op === 'remove' && o.key === 'b'));
});

test('active tab changed yields two setActive ops', () => {
  const prev = makeNav();
  const next = makeNav({ activeKey: 'b' });
  const ops = navChanges(prev, next);
  const active = ops.filter((o) => o.op === 'setActive');
  assert.equal(active.length, 2);
  assert.deepEqual(active, [
    { op: 'setActive', key: 'a', active: false },
    { op: 'setActive', key: 'b', active: true },
  ]);
});

test('no change yields an empty op list', () => {
  const a = makeNav();
  const b = makeNav();
  assert.deepEqual(navChanges(a, b), []);
  assert.deepEqual(navChanges(a, a), []);
});
