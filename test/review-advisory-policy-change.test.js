'use strict';

// Regression checks for the structured shadow/escalated fields on task.policyChange
// (policyChangeCheck in src/review-advisory-checks.js). Runs under node:test.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { policyChangeCheck } = require('../src/review-advisory-checks.js');

// Adds a threshold constant to a pipeline-behaviour file (src/*.js): classified as a policy change.
const POLICY_DIFF = [
  'diff --git a/src/widget-policy.js b/src/widget-policy.js',
  '--- a/src/widget-policy.js',
  '+++ b/src/widget-policy.js',
  '@@ -1,1 +1,2 @@',
  '+const MAX_LOCAL_WIDGET_RETRIES = 5;',
  ' const x = 1;',
  ''
].join('\n');

const NON_POLICY_DIFF = [
  'diff --git a/src/widget.js b/src/widget.js',
  '--- a/src/widget.js',
  '+++ b/src/widget.js',
  '@@ -1,1 +1,2 @@',
  '+const label = "hello world";',
  ' const y = 2;',
  ''
].join('\n');

function makeTask(rawDiff) {
  return {
    id: 'test-task',
    title: 'policy change fixture',
    source: 'adhoc',
    adhocResolution: 'implemented',
    rawDiff,
    promptContext: { rawText: 'Change how the pipeline routes policy changes.' },
    history: [],
  };
}

function runCheck(task, env) {
  const saved = process.env.AGENT_MANAGER_POLICY_CHANGE_ROUTING;
  if (env === undefined) delete process.env.AGENT_MANAGER_POLICY_CHANGE_ROUTING;
  else process.env.AGENT_MANAGER_POLICY_CHANGE_ROUTING = env;
  try {
    return policyChangeCheck({ task, factCheckVerdict: null, recordModelOutcome: () => {} });
  } finally {
    if (saved === undefined) delete process.env.AGENT_MANAGER_POLICY_CHANGE_ROUTING;
    else process.env.AGENT_MANAGER_POLICY_CHANGE_ROUTING = saved;
  }
}

test('shadow mode: policy diff gets shadow=true, escalated=false, no blocked verdict', () => {
  const task = makeTask(POLICY_DIFF);
  const result = runCheck(task, undefined);
  assert.equal(task.policyChange.policy, true, 'fixture must be classified as a policy change');
  assert.equal(result, null);
  assert.equal(typeof task.policyChange.shadow, 'boolean');
  assert.equal(typeof task.policyChange.escalated, 'boolean');
  assert.equal(task.policyChange.shadow, true);
  assert.equal(task.policyChange.escalated, false);
});

test('routing on: shadow=false and escalated mirrors whether the review blocked', () => {
  const task = makeTask(POLICY_DIFF);
  const result = runCheck(task, 'true');
  assert.equal(task.policyChange.policy, true, 'fixture must be classified as a policy change');
  assert.equal(task.policyChange.shadow, false);
  assert.equal(typeof task.policyChange.escalated, 'boolean');
  assert.equal(task.policyChange.escalated, !!(result && result.verdict === 'blocked'));
});

test('non-policy diff: shadow and escalated are still present as booleans', () => {
  const task = makeTask(NON_POLICY_DIFF);
  runCheck(task, undefined);
  assert.ok(task.policyChange);
  assert.equal(task.policyChange.policy, false);
  assert.equal(typeof task.policyChange.shadow, 'boolean');
  assert.equal(typeof task.policyChange.escalated, 'boolean');
});
