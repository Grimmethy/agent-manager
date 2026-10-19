'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  recentBlockedAttempts, rotationDemoted, laneAvoided, recordAvoidedLane, describeTopTierFailure, ROTATION_DEMOTED_PRIORITY,
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

// --- Lane avoidance must never strand a task (2026-10-17) ---------------------------------------------------------------------------------------------------
// Stranded record (queue/pending/adhoc-initiative-record-design-doc-extend-..., premium): avoidLanes holds BOTH the biggest lane and the P40 while the only other lane
// has a taskClasses allowlist, so no lane would claim it. Fields copied from the stored record.
const STRANDED_TASK_JSON = '{"id": "adhoc-initiative-record-design-doc-extend-the-merged-doc-with-the-missing-sections-docs-only-one-file-1792157631660", "domain": "adhoc", "source": "manual", "humanQueued": true, "premiumPriority": true, "avoidLanes": ["worker-3090", "worker-p40"]}';
const STRANDED_TASK = JSON.parse(STRANDED_TASK_JSON);

const LANE_BIG = { id: 'worker-3090', model: 'qwen3.8:27b-q4_K_M', tier: 27, taskClasses: null };
const LANE_SMALL = { id: 'worker-rx580', model: 'qwen3-vl:8b-instruct', tier: 8, taskClasses: ['brain_dump_sort'] };
const attemptOn = (lane) => ({ draftAttempts: [{ outcome: 'blocked', lane }] });

test('recordAvoidedLane with a lane list: the biggest-tier lane is never recorded', () => {
  const task = { ...attemptOn('worker-3090') };
  assert.equal(recordAvoidedLane(task, 2, {}, [LANE_BIG, LANE_SMALL]), null);
  assert.equal(task.avoidLanes, undefined);
});

test('recordAvoidedLane with a lane list: a lower-tier lane that has a bigger one above it is recorded', () => {
  const task = { ...attemptOn('worker-rx580') };
  assert.equal(recordAvoidedLane(task, 2, {}, [LANE_BIG, LANE_SMALL]), 'worker-rx580');
  assert.deepEqual(task.avoidLanes, ['worker-rx580']);
});

test('recordAvoidedLane with a lane list: a tie for biggest is never recorded', () => {
  const tie = [{ id: 'worker-3090', tier: 27 }, { id: 'worker-p40', tier: 27 }];
  assert.equal(recordAvoidedLane({ ...attemptOn('worker-p40') }, 2, {}, tie), null);
  assert.equal(recordAvoidedLane({ ...attemptOn('worker-3090') }, 2, {}, tie), null);
});

test('recordAvoidedLane with a lane list: an unknown tier or a lane missing from the list is still recorded (laneAvoided ctx keeps it from stranding)', () => {
  const lanes = [LANE_BIG, { id: 'worker-p40', tier: null }];
  assert.equal(recordAvoidedLane({ ...attemptOn('worker-p40') }, 2, {}, lanes), 'worker-p40');
  assert.equal(recordAvoidedLane({ ...attemptOn('worker-p40') }, 2, {}, [LANE_BIG, LANE_SMALL]), 'worker-p40', 'a legacy lane that is not in the list');
});

test('recordAvoidedLane without a lane list keeps the old behaviour (records the lane, even the biggest)', () => {
  const task = { ...attemptOn('worker-3090') };
  assert.equal(recordAvoidedLane(task, 2, {}), 'worker-3090');
});

test('laneAvoided with a lane context: skipped only while another lane exists that is not avoided, allows the source and is alive', () => {
  const task = { avoidLanes: ['worker-rx580'] };
  const ctx = (extra) => ({ lanes: [LANE_BIG, LANE_SMALL], source: 'brain_dump_sort', alive: () => true, ...extra });
  assert.equal(laneAvoided(task, 'worker-rx580', 2, {}, ctx()), true, 'the 3090 can take it, so the small lane steps aside');
  assert.equal(laneAvoided(task, 'worker-rx580', 2, {}, ctx({ alive: (id) => id !== 'worker-3090' })), false, 'the only alternative is down: do not hold the task');
  assert.equal(laneAvoided({ avoidLanes: ['worker-3090'] }, 'worker-3090', 2, {}, ctx({ source: 'adhoc' })), false, 'the only other lane is allowlist-restricted and does not allow this source');
  assert.equal(laneAvoided({ avoidLanes: ['worker-3090', 'worker-rx580'] }, 'worker-3090', 2, {}, ctx()), false, 'every lane is avoided: nowhere else to go');
});

test('laneAvoided without a lane context is unchanged', () => {
  assert.equal(laneAvoided({ avoidLanes: ['worker-3090', 'worker-p40'] }, 'worker-3090', 2, {}), true);
});

test('describeTopTierFailure: a finding for the biggest lane, identical text across tasks, none for a smaller or unknown-tier lane', () => {
  const lanes = [LANE_BIG, LANE_SMALL];
  const a = describeTopTierFailure({ id: 'task-a', ...attemptOn('worker-3090') }, lanes);
  const b = describeTopTierFailure({ id: 'task-b', ...attemptOn('worker-3090') }, lanes);
  assert.ok(a && /worker-3090/.test(a.title) && /qwen3\.8:27b/.test(a.title));
  assert.deepEqual(a, b, 'the same failure on the same lane and model must be the same text so the sweep merges repeats');
  assert.equal(describeTopTierFailure({ ...attemptOn('worker-rx580') }, lanes), null, 'avoidance, not a finding, is the response for a smaller lane');
  assert.equal(describeTopTierFailure({ ...attemptOn('worker-p40') }, [LANE_BIG, { id: 'worker-p40', tier: null }]), null);
  assert.equal(describeTopTierFailure({ ...attemptOn('worker-3090') }, null), null);
});

test('regression (stranded premium task): with the real avoidLanes shape no lane list leaves it unclaimable', () => {
  const lanes = [LANE_BIG, LANE_SMALL];
  const alive = () => true;
  assert.equal(laneAvoided(STRANDED_TASK, 'worker-3090', 2, {}, { lanes, source: 'manual', alive }), false, 'the 3090 must be able to claim it');
});
