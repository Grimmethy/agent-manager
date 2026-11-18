'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateTestGate } = require('./test-failure-gate');

test('blocks when a failing test was added by this diff and is named in blockedReason', () => {
  const result = evaluateTestGate({
    failingTests: ['adds new widget renders'],
    addedTestNames: ['adds new widget renders'],
    masterFailingTests: [],
  });
  assert.equal(result.blocked, true);
  assert.match(result.blockedReason, /adds new widget renders/);
});

test('does not block when a failure is also on master and was not added by the diff', () => {
  const result = evaluateTestGate({
    failingTests: ['legacy flaky test'],
    addedTestNames: [],
    masterFailingTests: ['legacy flaky test'],
  });
  assert.equal(result.blocked, false);
  assert.equal(result.blockedReason, '');
});

test('blocks when there is a failure but no master baseline is available', () => {
  const result = evaluateTestGate({
    failingTests: ['some test'],
    addedTestNames: [],
    masterFailingTests: null,
  });
  assert.equal(result.blocked, true);
  assert.match(result.blockedReason, /some test/);
});

test('does not block when there are zero failures', () => {
  const result = evaluateTestGate({
    failingTests: [],
    addedTestNames: [],
    masterFailingTests: [],
  });
  assert.equal(result.blocked, false);
  assert.equal(result.blockedReason, '');
});
