'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { findParentCycle } = require('./task-graph-cycle-guard.js');

const fromMap = (m) => (id) => (id in m ? m[id] : null);

test('acyclic chain is ok', () => {
  const r = findParentCycle('a', fromMap({ a: 'b', b: 'c', c: null }));
  assert.strictEqual(r.status, 'ok');
  assert.deepStrictEqual(r.chain, ['a', 'b', 'c']);
});

test('absent start / missing parent is ok', () => {
  assert.strictEqual(findParentCycle('x', fromMap({})).status, 'ok');
  assert.strictEqual(findParentCycle(null, fromMap({})).status, 'ok');
});

test('self-loop is a cycle', () => {
  const r = findParentCycle('a', fromMap({ a: 'a' }));
  assert.strictEqual(r.status, 'cycle');
  assert.deepStrictEqual(r.cycle, ['a']);
});

test('2-cycle', () => {
  const r = findParentCycle('a', fromMap({ a: 'b', b: 'a' }));
  assert.strictEqual(r.status, 'cycle');
  assert.deepStrictEqual(r.cycle, ['a', 'b']);
});

test('3-cycle', () => {
  const r = findParentCycle('a', fromMap({ a: 'b', b: 'c', c: 'a' }));
  assert.strictEqual(r.status, 'cycle');
  assert.deepStrictEqual(r.cycle, ['a', 'b', 'c']);
});

test('tail leading into a cycle', () => {
  const r = findParentCycle('t', fromMap({ t: 'a', a: 'b', b: 'a' }));
  assert.strictEqual(r.status, 'cycle');
  assert.deepStrictEqual(r.cycle, ['a', 'b']);
});

test('maxDepth exceeded is too-deep', () => {
  const r = findParentCycle(0, (n) => n + 1, { maxDepth: 10 });
  assert.strictEqual(r.status, 'too-deep');
  assert.strictEqual(r.depth, 10);
});

test('chain exactly at maxDepth is ok', () => {
  const r = findParentCycle(0, (n) => (n < 4 ? n + 1 : null), { maxDepth: 5 });
  assert.strictEqual(r.status, 'ok');
});
