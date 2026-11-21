'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CLASSIFIERS, classifyBlockedTask, signatureForTask } = require('./blocked-task-classifiers');

test('a real matched task keeps its source::category signature', () => {
  const task = { source: 'adhoc', blockedReason: 'Ungrounded draft: fabricated file path(s): src/nope.js' };
  const { category, classifierName } = classifyBlockedTask(task);
  assert.notEqual(category, 'uncategorized');
  assert.ok(classifierName);
  assert.equal(signatureForTask(task), `adhoc::${category}`);
});

test('a task no classifier recognizes returns null', () => {
  assert.equal(signatureForTask({ source: 'adhoc', blockedReason: 'qwerty unmatched marker 4471' }), null);
});

test('a classifier yielding uncategorized returns null even with a non-null classifierName', () => {
  const entry = {
    name: 'fake-uncategorized',
    classify(task) {
      if (!String(task.blockedReason).includes('FAKE-MARKER')) return null;
      return { category: 'uncategorized', faultSide: 'model', retryable: true };
    },
  };
  CLASSIFIERS.unshift(entry);
  try {
    const task = { source: 'adhoc', blockedReason: 'FAKE-MARKER' };
    assert.equal(classifyBlockedTask(task).classifierName, 'fake-uncategorized');
    assert.equal(signatureForTask(task), null);
  } finally {
    CLASSIFIERS.splice(CLASSIFIERS.indexOf(entry), 1);
  }
});
