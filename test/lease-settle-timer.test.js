'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { armSettle, disarmSettle } = require('../src/lease-settle-timer.js');

const MAX_DELAY = 2147483647;
const NOW = 1000000;

test('fires exactly once after the delay and not again later', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  let calls = 0;
  armSettle('a1', NOW + 500, () => { calls++; });
  t.mock.timers.tick(499);
  assert.strictEqual(calls, 0);
  t.mock.timers.tick(1);
  assert.strictEqual(calls, 1);
  t.mock.timers.tick(100000);
  assert.strictEqual(calls, 1);
  disarmSettle('a1');
});

test('arming the same leaseId twice fires only the second onDue', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  let first = 0;
  let second = 0;
  armSettle('a2', NOW + 1000, () => { first++; });
  armSettle('a2', NOW + 1000, () => { second++; });
  t.mock.timers.tick(1000);
  assert.strictEqual(first, 0);
  assert.strictEqual(second, 1);
});

test('disarmSettle before the due time prevents the call', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  let calls = 0;
  armSettle('a3', NOW + 1000, () => { calls++; });
  disarmSettle('a3');
  t.mock.timers.tick(5000);
  assert.strictEqual(calls, 0);
});

test('disarmSettle with nothing armed does not throw', () => {
  assert.doesNotThrow(() => disarmSettle('never-armed'));
});

test('an expiresAt in the past fires with delay 0', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  let calls = 0;
  armSettle('a5', NOW - 5000, () => { calls++; });
  t.mock.timers.tick(1);
  assert.strictEqual(calls, 1);
});

test('a far-future expiresAt is clamped to MAX_DELAY', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  let calls = 0;
  armSettle('a6', NOW + MAX_DELAY + 1000000, () => { calls++; });
  t.mock.timers.tick(MAX_DELAY - 1);
  assert.strictEqual(calls, 0);
  t.mock.timers.tick(1);
  assert.strictEqual(calls, 1);
  t.mock.timers.tick(MAX_DELAY);
  assert.strictEqual(calls, 1);
});
