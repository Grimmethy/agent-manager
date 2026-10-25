'use strict';

// Unit tests for hub-apply-routing.js (S2 of the hub-tasks extraction, 2026-09-23).
// Run: node --test src/hub-apply-routing.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  applyCoordinatingOutcome, DEFAULT_HUB_APPLY_ROUTING, getHubApplyRouting, setHubApplyRouting,
} = require('./hub-apply-routing.js');

test('getHubApplyRouting returns the default bundle when nothing has overridden it', () => {
  setHubApplyRouting(null);
  assert.equal(getHubApplyRouting(), DEFAULT_HUB_APPLY_ROUTING);
});

test('applyCoordinatingOutcome stamps subTasks/progress from the result', () => {
  const task = {};
  applyCoordinatingOutcome(task, { subTasks: [{ id: 'a' }, { id: 'b' }] });
  assert.equal(task.subTasks.length, 2);
  assert.deepEqual(task.progress, { done: 0, total: 2 });
});

test('applyCoordinatingOutcome defaults subTasks to an empty array when the result has none', () => {
  const task = {};
  applyCoordinatingOutcome(task, {});
  assert.deepEqual(task.subTasks, []);
  assert.deepEqual(task.progress, { done: 0, total: 0 });
});

test('applyCoordinatingOutcome stamps hubSerial/hubLabel and rewrites the title only when both are present', () => {
  const task = { title: 'AC-2 · Original title' };
  applyCoordinatingOutcome(task, { subTasks: [], hubSerial: 7, hubLabel: 'HUB0007' });
  assert.equal(task.hubSerial, 7);
  assert.equal(task.hubLabel, 'HUB0007');
  assert.ok(task.title.startsWith('HUB0007'), `expected the title to lead with the hub label, got: ${task.title}`);
});

test('applyCoordinatingOutcome leaves hubSerial/hubLabel/title untouched when the result has neither', () => {
  const task = { title: 'Untouched title' };
  applyCoordinatingOutcome(task, { subTasks: [] });
  assert.equal(task.hubSerial, undefined);
  assert.equal(task.hubLabel, undefined);
  assert.equal(task.title, 'Untouched title');
});

test('applyCoordinatingOutcome stamps parentHub from promptContext.decomposedFrom', () => {
  const task = { promptContext: { decomposedFrom: 'hub-original' } };
  applyCoordinatingOutcome(task, { subTasks: [] });
  assert.equal(task.parentHub, 'hub-original');
});

test('applyCoordinatingOutcome does not stamp parentHub when there is no owning hub', () => {
  const task = {};
  applyCoordinatingOutcome(task, { subTasks: [] });
  assert.equal(Object.prototype.hasOwnProperty.call(task, 'parentHub'), false);
});

test('setHubApplyRouting swaps the live implementation; a falsy argument restores the default', () => {
  const custom = { applyCoordinatingOutcome: () => {} };
  setHubApplyRouting(custom);
  assert.equal(getHubApplyRouting(), custom);
  setHubApplyRouting(null);
  assert.equal(getHubApplyRouting(), DEFAULT_HUB_APPLY_ROUTING);
});

test('applyCoordinatingOutcome stamps ownerGates and one advisory history event when the result has gated pieces, and nothing when it has none', () => {
  const gates = [{ id: 'HUB0001-02-x', title: 'Vendor it', why: 'owner approval' }, { id: 'HUB0001-03-y', title: 'Pick one', why: 'design decision' }];
  const task = { history: [] };
  applyCoordinatingOutcome(task, { subTasks: [{ id: 'a' }], ownerGates: gates });
  assert.deepEqual(task.ownerGates, gates);
  assert.equal(task.history.at(-1).stage, 'advisory');
  assert.match(task.history.at(-1).detail, /owner-gated pieces: HUB0001-02-x, HUB0001-03-y/);
  const plain = { history: [] };
  applyCoordinatingOutcome(plain, { subTasks: [{ id: 'a' }], ownerGates: [] });
  applyCoordinatingOutcome(plain, { subTasks: [{ id: 'a' }] });
  assert.equal('ownerGates' in plain, false);
  assert.deepEqual(plain.history, []);
});
