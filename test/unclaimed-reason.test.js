'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { reasonFor } = require('../src/unclaimed-reason');

// reasonFor reads only boolean flags on poolState; the task record is passed through
// for shape but is not inspected. Each case flips exactly one flag.
function pool(overrides = {}) {
  return {
    claimed: false,
    dependencyUnmet: false,
    laneNotAllowed: false,
    ioHeld: false,
    paused: false,
    premiumRotating: false,
    ...overrides,
  };
}

// HUB0001-05 depends on HUB0001-04, which is applied (in queue/done) but not yet merged.
const hub0001_05 = {
  id: 'HUB0001-05',
  dependsOn: ['HUB0001-04'],
  dependencies: { 'HUB0001-04': { state: 'done', applied: true, mergedAt: null } },
};
const plainTask = { id: 'adhoc-plain-task' };

test('dependency-unmerged: HUB0001-05 waits on applied-but-not-merged HUB0001-04', () => {
  assert.deepEqual(
    reasonFor(hub0001_05, pool({ dependencyUnmet: true })),
    { code: 'dependency-unmerged', text: 'Blocked by unmerged dependency' },
  );
});

test('lane-not-allowed', () => {
  assert.deepEqual(
    reasonFor(plainTask, pool({ laneNotAllowed: true })),
    { code: 'lane-not-allowed', text: 'Lane not allowed for this task' },
  );
});

test('io-hold', () => {
  assert.deepEqual(
    reasonFor(plainTask, pool({ ioHeld: true })),
    { code: 'io-hold', text: 'Held by IO operation' },
  );
});

test('paused', () => {
  assert.deepEqual(
    reasonFor(plainTask, pool({ paused: true })),
    { code: 'paused', text: 'Task is paused' },
  );
});

test('premium-ordering', () => {
  assert.deepEqual(
    reasonFor(plainTask, pool({ premiumRotating: true })),
    { code: 'premium-ordering', text: 'Rotated for premium priority ordering' },
  );
});

test('claimable task returns null', () => {
  assert.equal(reasonFor(plainTask, pool()), null);
});

test('missing poolState returns null', () => {
  assert.equal(reasonFor(plainTask, undefined), null);
});

test('already-claimed task returns null even with a blocking flag', () => {
  assert.equal(reasonFor(plainTask, pool({ claimed: true, paused: true })), null);
});

test('dependency takes precedence over later gates', () => {
  assert.equal(
    reasonFor(hub0001_05, pool({ dependencyUnmet: true, paused: true })).code,
    'dependency-unmerged',
  );
});
