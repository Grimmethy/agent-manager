'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { oldestLiveLease } = require('./node-lease-age.js');

const NOW = Date.parse('2026-06-01T12:00:00.000Z');
const MIN = 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

// A lease row shaped like the ones src/lease-ledger.js listLeases returns.
const lease = (taskId, nodeId, leasedMs, expiresMs, state = 'lent') => ({
  taskId, nodeId, state, leasedAt: iso(leasedMs), expiresAt: iso(expiresMs),
});

test('no leases gives null', () => {
  assert.equal(oldestLiveLease([], 'n1', NOW), null);
});

test('only other nodes\' leases gives null', () => {
  const leases = [lease('a', 'n2', NOW - 5 * MIN, NOW + 50 * MIN)];
  assert.equal(oldestLiveLease(leases, 'n1', NOW), null);
});

test('only returned, expired or merged rows give null', () => {
  const leases = [
    lease('a', 'n1', NOW - 5 * MIN, NOW + 50 * MIN, 'returned'),
    lease('b', 'n1', NOW - 5 * MIN, NOW + 50 * MIN, 'expired'),
    lease('c', 'n1', NOW - 5 * MIN, NOW + 50 * MIN, 'merged'),
  ];
  assert.equal(oldestLiveLease(leases, 'n1', NOW), null);
});

test('a lent row already at or past expiresAt is not live', () => {
  assert.equal(oldestLiveLease([lease('a', 'n1', NOW - 60 * MIN, NOW - 1)], 'n1', NOW), null);
  assert.equal(oldestLiveLease([lease('a', 'n1', NOW - 60 * MIN, NOW)], 'n1', NOW), null);
});

test('of two live leases the earliest leasedAt is chosen', () => {
  const leases = [
    lease('late', 'n1', NOW - 10 * MIN, NOW + 50 * MIN),
    lease('early', 'n1', NOW - 30 * MIN, NOW + 30 * MIN),
  ];
  const r = oldestLiveLease(leases, 'n1', NOW);
  assert.equal(r.taskId, 'early');
  assert.equal(r.ageMin, 30);
  assert.equal(r.leftMin, 30);
});

test('a tie on leasedAt keeps the first row in input order', () => {
  const leases = [
    lease('first', 'n1', NOW - 20 * MIN, NOW + 40 * MIN),
    lease('second', 'n1', NOW - 20 * MIN, NOW + 10 * MIN),
  ];
  assert.equal(oldestLiveLease(leases, 'n1', NOW).taskId, 'first');
});

test('ageMin floors whole minutes: 119 seconds is 1', () => {
  const r = oldestLiveLease([lease('a', 'n1', NOW - 119 * 1000, NOW + 60 * MIN)], 'n1', NOW);
  assert.equal(r.ageMin, 1);
});

test('ageMin is never below 0 when leasedAt is in the future', () => {
  const r = oldestLiveLease([lease('a', 'n1', NOW + 5 * MIN, NOW + 60 * MIN)], 'n1', NOW);
  assert.equal(r.ageMin, 0);
  assert.equal(r.leftMin, 60);
});

test('leftMin rounds up: 61 seconds left is 2', () => {
  const r = oldestLiveLease([lease('a', 'n1', NOW - 10 * MIN, NOW + 61 * 1000)], 'n1', NOW);
  assert.equal(r.leftMin, 2);
});

test('a live lease with an unparsable leasedAt is skipped', () => {
  const bad = { taskId: 'bad', nodeId: 'n1', state: 'lent', leasedAt: 'not-a-date', expiresAt: iso(NOW + 60 * MIN) };
  assert.equal(oldestLiveLease([bad], 'n1', NOW), null);
  const good = lease('good', 'n1', NOW - 10 * MIN, NOW + 50 * MIN);
  assert.equal(oldestLiveLease([bad, good], 'n1', NOW).taskId, 'good');
});

test('null and non-object rows are skipped without throwing', () => {
  const good = lease('good', 'n1', NOW - 10 * MIN, NOW + 50 * MIN);
  assert.equal(oldestLiveLease([null, 5, 'row', good], 'n1', NOW).taskId, 'good');
  assert.equal(oldestLiveLease([null, undefined], 'n1', NOW), null);
});

test('TypeError: leases must be an array', () => {
  for (const bad of [null, undefined, {}, 'x']) {
    assert.throws(() => oldestLiveLease(bad, 'n1', NOW), { name: 'TypeError', message: 'leases must be an array' });
  }
});

test('TypeError: nodeId must be a non-empty string', () => {
  for (const bad of ['', undefined, null, 7]) {
    assert.throws(() => oldestLiveLease([], bad, NOW), { name: 'TypeError', message: 'nodeId must be a non-empty string' });
  }
});

test('a lent row with an unparsable expiresAt is not live', () => {
  const bad = { taskId: 'bad', nodeId: 'n1', state: 'lent', leasedAt: iso(NOW - 10 * MIN), expiresAt: 'not a date' };
  assert.equal(oldestLiveLease([bad], 'n1', NOW), null);
});

test('a valid live lease is returned over an unparsable-expiresAt lease', () => {
  const bad = { taskId: 'bad', nodeId: 'n1', state: 'lent', leasedAt: iso(NOW - 40 * MIN), expiresAt: 'not a date' };
  const good = lease('good', 'n1', NOW - 10 * MIN, NOW + 50 * MIN);
  assert.equal(oldestLiveLease([bad, good], 'n1', NOW).taskId, 'good');
});

test('TypeError: now must be a finite number', () => {
  for (const bad of [NaN, Infinity, '123', undefined]) {
    assert.throws(() => oldestLiveLease([], 'n1', bad), { name: 'TypeError', message: 'now must be a finite number' });
  }
});
