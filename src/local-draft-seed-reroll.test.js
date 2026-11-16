'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
// local-draft.js calls ensureRegistered() at load, which requires this env var.
if (!process.env.AGENT_MANAGER_REPO_ROOT) process.env.AGENT_MANAGER_REPO_ROOT = process.cwd();
const { attemptSeedReroll } = require('./local-draft.js');

test('attemptSeedReroll: a non-gated task keeps the initial plan result and does not re-roll', async () => {
  const calls = [];
  const planRecords = [];
  const historyEvents = [];
  const task = { id: 'seed-reroll-non-gated', source: 'manual', promptContext: {} };

  const callPlan = async (...args) => {
    calls.push(args);
    return { response: 'long enough plan response', attempts: 1 };
  };

  const result = await attemptSeedReroll({
    planResult: { response: 'short', attempts: 1 },
    substanceGated: false,
    seedPlan: undefined,
    callPlan,
    recordModelCall: undefined,
    recordPlan: (...args) => planRecords.push(args),
    appendHistoryEvent: (...args) => historyEvents.push(args),
    attempt: 1,
    grounding: undefined,
    task,
    ruleId: undefined,
    expectedDisposition: undefined,
  });

  assert.equal(calls.length, 0, 'callPlan must not be called for a non-gated task');
  assert.equal(result.reRolled, false);
  assert.equal(result.stillThin, false);
  assert.equal(result.seededFromPrior, false);
  assert.equal(task.planResponse, 'short');

  assert.equal(planRecords.length, 1, 'recordPlan called exactly once');
  assert.equal(planRecords[0][0], 1, 'recordPlan receives the attempt number first');
  assert.equal(planRecords[0][1].text, 'short', 'recordPlan records the initial response text');

  assert.equal(historyEvents.length, 1, 'appendHistoryEvent called exactly once');
  assert.equal(historyEvents[0][1], 'plan-done', "history event stage is 'plan-done'");
});
