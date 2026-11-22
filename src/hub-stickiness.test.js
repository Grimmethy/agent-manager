'use strict';

// Tests for src/hub-stickiness.js isHubBlocked(): a task is blocked when ANOTHER node holds a live lease on a task of the same stacked branch.
// Everything is injected (leases and readRecord), so no files, clocks or processes are used.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isHubBlocked } = require('./hub-stickiness.js');

const NOW = Date.parse('2026-11-15T12:00:00Z');
const FUTURE = '2026-11-15T13:00:00Z';
const PAST = '2026-11-15T11:00:00Z';

function lease(taskId, nodeId, expiresAt, state = 'lent') {
  return { taskId, nodeId, expiresAt, state };
}

const records = {
  held: { id: 'held', stacked: { branch: 'agent/hub-x' } },
  other: { id: 'other', stacked: { branch: 'agent/hub-y' } },
  bare: { id: 'bare', stacked: {} },
};
const readRecord = (taskId) => records[taskId] || null;
const candidate = { id: 'next', stacked: { branch: 'agent/hub-x' } };

test('a task with no stacked branch is never blocked', () => {
  const leases = [lease('held', 'node-a', FUTURE)];
  assert.equal(isHubBlocked({ id: 'plain' }, 'node-b', NOW, { leases, readRecord }), false);
  assert.equal(isHubBlocked({ id: 'plain', stacked: {} }, 'node-b', NOW, { leases, readRecord }), false);
  assert.equal(isHubBlocked(null, 'node-b', NOW, { leases, readRecord }), false);
});

test('blocked when another node holds an unexpired lease on a task of the same branch', () => {
  const leases = [lease('held', 'node-a', FUTURE)];
  assert.equal(isHubBlocked(candidate, 'node-b', NOW, { leases, readRecord }), true);
});

test('not blocked by an expired lease, or a lease that is not in the lent state', () => {
  assert.equal(isHubBlocked(candidate, 'node-b', NOW, { leases: [lease('held', 'node-a', PAST)], readRecord }), false);
  assert.equal(isHubBlocked(candidate, 'node-b', NOW, { leases: [lease('held', 'node-a', FUTURE, 'expired')], readRecord }), false);
});

test("not blocked by the claimant's own lease", () => {
  assert.equal(isHubBlocked(candidate, 'node-a', NOW, { leases: [lease('held', 'node-a', FUTURE)], readRecord }), false);
});

test('not blocked by another node holding a different branch, or a lease whose record cannot be read', () => {
  assert.equal(isHubBlocked(candidate, 'node-b', NOW, { leases: [lease('other', 'node-a', FUTURE)], readRecord }), false);
  assert.equal(isHubBlocked(candidate, 'node-b', NOW, { leases: [lease('missing', 'node-a', FUTURE)], readRecord }), false);
});

test('another node holding the branch blocks even when the claimant also holds a lease on it', () => {
  const leases = [lease('held', 'node-b', FUTURE), lease('held', 'node-a', FUTURE)];
  assert.equal(isHubBlocked(candidate, 'node-b', NOW, { leases, readRecord }), true);
});

test('a candidate without a branch is not matched to a held task that also has no branch', () => {
  const leases = [lease('bare', 'node-a', FUTURE)];
  assert.equal(isHubBlocked({ id: 'plain2', stacked: {} }, 'node-b', NOW, { leases, readRecord }), false);
});
