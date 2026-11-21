'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { selectPrunable } = require('./lease-ledger-prune.js');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-06-01T00:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const row = (taskId, state, fields) => ({ taskId, nodeId: 'grimm', state, leasedAt: iso(NOW - 30 * DAY), expiresAt: iso(NOW - 29 * DAY), ...fields });
const run = (leases, olderThanDays = 7) => selectPrunable(leases, { olderThanDays, now: NOW });

test('a returned row exactly olderThanDays old is kept, one a millisecond older is prunable', () => {
  assert.deepEqual(run([row('t1', 'returned', { returnedAt: iso(NOW - 7 * DAY) })]), { prunable: [], kept: 1 });
  assert.deepEqual(run([row('t1', 'returned', { returnedAt: iso(NOW - 7 * DAY - 1) })]), { prunable: ['t1'], kept: 0 });
});

test('returned, expired and merged rows are each prunable when old enough', () => {
  const old = iso(NOW - 10 * DAY);
  assert.deepEqual(run([row('r', 'returned', { returnedAt: old })]).prunable, ['r']);
  assert.deepEqual(run([row('e', 'expired', { expiresAt: old })]).prunable, ['e']);
  assert.deepEqual(run([row('m', 'merged', { mergedAt: old })]).prunable, ['m']);
});

test('a lent row is never prunable, even when its expiresAt is old', () => {
  assert.deepEqual(run([row('l', 'lent', { expiresAt: iso(NOW - 30 * DAY) })]), { prunable: [], kept: 1 });
});

test('mergedAt decides over returnedAt, and returnedAt over expiresAt', () => {
  const fresh = iso(NOW - 1 * DAY);
  const old = iso(NOW - 30 * DAY);
  // mergedAt fresh beats returnedAt old: kept
  assert.deepEqual(run([row('a', 'merged', { mergedAt: fresh, returnedAt: old })]).prunable, []);
  // mergedAt old beats returnedAt fresh: prunable
  assert.deepEqual(run([row('b', 'merged', { mergedAt: old, returnedAt: fresh })]).prunable, ['b']);
  // returnedAt fresh beats expiresAt old: kept
  assert.deepEqual(run([row('c', 'returned', { returnedAt: fresh, expiresAt: old })]).prunable, []);
  // returnedAt old beats expiresAt fresh: prunable
  assert.deepEqual(run([row('d', 'returned', { returnedAt: old, expiresAt: fresh })]).prunable, ['d']);
});

test('an unparsable finish field falls through to the next, and a row with no parsable finish time is kept', () => {
  const old = iso(NOW - 30 * DAY);
  assert.deepEqual(run([row('f', 'merged', { mergedAt: 'not a date', returnedAt: old })]).prunable, ['f']);
  assert.deepEqual(run([row('g', 'expired', { expiresAt: 'garbage' })]), { prunable: [], kept: 1 });
});

test('a null row, and a row that is not an object, are counted in kept and do not throw', () => {
  const leases = [null, 5, 'x', [], row('t1', 'returned', { returnedAt: iso(NOW - 30 * DAY) })];
  assert.deepEqual(run(leases), { prunable: ['t1'], kept: 4 });
});

test('prunable taskIds come back in input order', () => {
  const old = iso(NOW - 30 * DAY);
  const leases = [row('z', 'merged', { mergedAt: old }), row('keep', 'lent'), row('a', 'expired', { expiresAt: old })];
  assert.deepEqual(run(leases), { prunable: ['z', 'a'], kept: 1 });
});

test('a non-array leases throws a TypeError', () => {
  assert.throws(() => selectPrunable({}, { olderThanDays: 7, now: NOW }), { name: 'TypeError', message: 'leases must be an array' });
});

test('olderThanDays that is not a finite number above 0 throws a RangeError', () => {
  for (const bad of [0, -1, NaN, Infinity, '7']) {
    assert.throws(() => run([], bad), { name: 'RangeError', message: 'olderThanDays must be a positive number' }, String(bad));
  }
});

test('a non-finite now throws a TypeError', () => {
  for (const bad of [NaN, Infinity, 'x']) {
    assert.throws(() => selectPrunable([], { olderThanDays: 7, now: bad }), { name: 'TypeError', message: 'now must be a finite number' }, String(bad));
  }
});

test('the input array and its rows are not modified', () => {
  const leases = [row('t1', 'returned', { returnedAt: iso(NOW - 30 * DAY) }), null, row('t2', 'lent')];
  const before = structuredClone(leases);
  run(leases);
  assert.deepEqual(leases, before);
});

test('a numeric mergedAt is not a finish time: a returned row is judged by its parsable returnedAt', () => {
  const fresh = iso(NOW - 1 * DAY);
  // mergedAt is the number 5, so it must be skipped and returnedAt (fresh) decides: kept
  assert.deepEqual(run([row('n1', 'returned', { mergedAt: 5, returnedAt: fresh })]), { prunable: [], kept: 1 });
});

test('a returned row with a numeric mergedAt and an old returnedAt is prunable by returnedAt', () => {
  const old = iso(NOW - 30 * DAY);
  assert.deepEqual(run([row('n2', 'returned', { mergedAt: 5, returnedAt: old })]).prunable, ['n2']);
});

test('a returned row whose only finish field is a number has no parsable finish time and is kept', () => {
  assert.deepEqual(run([row('n3', 'returned', { mergedAt: 5, returnedAt: null, expiresAt: null })]), { prunable: [], kept: 1 });
});
