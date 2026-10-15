'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  recentBlockedAttempts, rotationDemoted, laneAvoided, recordAvoidedLane, ROTATION_DEMOTED_PRIORITY,
} = require('./premium-rotation.js');

const NOW = Date.parse('2026-10-15T12:00:00Z');
const minsAgo = (m) => new Date(NOW - m * 60_000).toISOString();
const blocked = (m) => ({ outcome: 'blocked', finishedAt: minsAgo(m) });

test('recentBlockedAttempts counts only blocked attempts inside the window', () => {
  const task = { draftAttempts: [blocked(10), blocked(170), blocked(200), { outcome: 'succeeded', finishedAt: minsAgo(5) }, { outcome: 'blocked', at: minsAgo(20) }] };
  assert.equal(recentBlockedAttempts(task, 180 * 60_000, NOW), 3); // 10 min, 170 min, and the `at`-only entry; 200 min is outside
  assert.equal(recentBlockedAttempts({}, 180 * 60_000, NOW), 0);
  assert.equal(recentBlockedAttempts(null, 180 * 60_000, NOW), 0);
});

test('rotationDemoted: a premium task with two recent blocked attempts is demoted; a fresh one, a one-attempt one and a non-premium one are not', () => {
  assert.equal(rotationDemoted({ premiumPriority: true, draftAttempts: [blocked(30), blocked(10)] }, {}, NOW), true);
  assert.equal(rotationDemoted({ premiumPriority: true, draftAttempts: [blocked(10)] }, {}, NOW), false);
  assert.equal(rotationDemoted({ premiumPriority: true }, {}, NOW), false);
  assert.equal(rotationDemoted({ draftAttempts: [blocked(30), blocked(10)] }, {}, NOW), false, 'a non-premium task is never demoted by this rule');
});

test('rotationDemoted: old blocked attempts age out of the window; thresholds are env-tunable; the off switch disables it', () => {
  const task = { premiumPriority: true, draftAttempts: [blocked(300), blocked(250)] };
  assert.equal(rotationDemoted(task, {}, NOW), false, 'both attempts are outside the 180 min window');
  assert.equal(rotationDemoted(task, { AGENT_MANAGER_PREMIUM_ROTATION_WINDOW_MIN: '600' }, NOW), true);
  const three = { premiumPriority: true, draftAttempts: [blocked(30), blocked(10)] };
  assert.equal(rotationDemoted(three, { AGENT_MANAGER_PREMIUM_ROTATION_ATTEMPTS: '3' }, NOW), false);
  assert.equal(rotationDemoted(three, { AGENT_MANAGER_PREMIUM_ROTATION: 'off' }, NOW), false);
});

test('laneAvoided: skipped only while another lane exists, never when pinned to the lane, off switch honoured', () => {
  const task = { avoidLanes: ['worker-p40'] };
  assert.equal(laneAvoided(task, 'worker-p40', 2, {}), true);
  assert.equal(laneAvoided(task, 'worker-3090', 2, {}), false, 'only the named lane is avoided');
  assert.equal(laneAvoided(task, 'worker-p40', 1, {}), false, 'a single-lane setup must still run the task');
  assert.equal(laneAvoided({ ...task, pinnedWorker: 'worker-p40' }, 'worker-p40', 2, {}), false, 'an explicit pin wins');
  assert.equal(laneAvoided(task, 'worker-p40', 2, { AGENT_MANAGER_LANE_AVOIDANCE: 'off' }), false);
  assert.equal(laneAvoided({}, 'worker-p40', 2, {}), false);
});

test('recordAvoidedLane adds the latest attempt\'s lane once, only when more than one lane exists', () => {
  const task = { draftAttempts: [{ lane: 'worker-3090' }, { lane: 'worker-p40' }] };
  assert.equal(recordAvoidedLane(task, 1, {}), null);
  assert.equal(task.avoidLanes, undefined);
  assert.equal(recordAvoidedLane(task, 2, {}), 'worker-p40');
  assert.deepEqual(task.avoidLanes, ['worker-p40']);
  assert.equal(recordAvoidedLane(task, 2, {}), null, 'already recorded');
  assert.equal(recordAvoidedLane({ draftAttempts: [{ lane: null }] }, 2, {}), null, 'unknown lane is not recorded');
  assert.equal(recordAvoidedLane({ draftAttempts: [{ lane: 'worker-p40' }] }, 2, { AGENT_MANAGER_LANE_AVOIDANCE: 'off' }), null);
});

test('ROTATION_DEMOTED_PRIORITY sits between fresh premium and the hub tier', () => {
  const { HUB_TIER_PRIORITY } = require('./hub-priority.js');
  assert.ok(ROTATION_DEMOTED_PRIORITY > -Infinity);
  assert.ok(ROTATION_DEMOTED_PRIORITY < HUB_TIER_PRIORITY);
});
