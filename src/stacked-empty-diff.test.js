'use strict';

// Tests for the pure stacked empty-diff classifier.
//
// Run: node --test src/stacked-empty-diff.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyStackedEmptyDiff } = require('./stacked-empty-diff.js');

test('clean stop with target already in base is already-landed', () => {
  assert.deepEqual(
    classifyStackedEmptyDiff({ endClass: 'stop', toolErrorCount: 0, targetPresentInBase: true, baseHasPredecessorLanding: false }),
    { outcome: 'already-landed', reason: 'already-landed' },
  );
});

for (const endClass of ['tool-calls', 'unknown', 'length', 'length-tool-call-suspected', 'other']) {
  test(`endClass ${endClass} never returns already-landed even when target is in base`, () => {
    const result = classifyStackedEmptyDiff({ endClass, toolErrorCount: 0, targetPresentInBase: true, baseHasPredecessorLanding: false });
    assert.notEqual(result.outcome, 'already-landed');
    assert.equal(result.outcome, 'redraft-on-landed-base');
    assert.equal(result.reason, 'empty-stacked-diff');
  });
}

test('toolErrorCount > 0 on a stop turn never returns already-landed and reports apply-failure', () => {
  const result = classifyStackedEmptyDiff({ endClass: 'stop', toolErrorCount: 1, targetPresentInBase: true, baseHasPredecessorLanding: false });
  assert.notEqual(result.outcome, 'already-landed');
  assert.deepEqual(result, { outcome: 'redraft-on-landed-base', reason: 'apply-failure' });
});

test('clean stop, target absent, base has predecessor is redraft-on-landed-base', () => {
  assert.deepEqual(
    classifyStackedEmptyDiff({ endClass: 'stop', toolErrorCount: 0, targetPresentInBase: false, baseHasPredecessorLanding: true }),
    { outcome: 'redraft-on-landed-base', reason: 'empty-stacked-diff' },
  );
});

test('clean stop, target absent, no predecessor is needs-clarification', () => {
  assert.deepEqual(
    classifyStackedEmptyDiff({ endClass: 'stop', toolErrorCount: 0, targetPresentInBase: false, baseHasPredecessorLanding: false }),
    { outcome: 'needs-clarification', reason: 'empty-stacked-diff' },
  );
});

for (const toolErrorCount of [NaN, undefined, null, Infinity, '0']) {
  test(`non-finite toolErrorCount (${String(toolErrorCount)}) never returns already-landed`, () => {
    const result = classifyStackedEmptyDiff({ endClass: 'stop', toolErrorCount, targetPresentInBase: true, baseHasPredecessorLanding: false });
    assert.notEqual(result.outcome, 'already-landed');
  });
}

test('outcomes and reasons stay within the shared contract sets', () => {
  const outcomes = new Set(['already-landed', 'redraft-on-landed-base', 'needs-clarification']);
  const reasons = new Set(['already-landed', 'empty-stacked-diff', 'true-conflict', 'apply-failure']);
  const inputs = [];
  for (const endClass of ['stop', 'tool-calls', 'unknown', 'length', 'length-tool-call-suspected', 'other']) {
    for (const toolErrorCount of [0, 1]) {
      for (const targetPresentInBase of [true, false]) {
        for (const baseHasPredecessorLanding of [true, false]) {
          inputs.push({ endClass, toolErrorCount, targetPresentInBase, baseHasPredecessorLanding });
        }
      }
    }
  }
  for (const input of inputs) {
    const r = classifyStackedEmptyDiff(input);
    assert.ok(outcomes.has(r.outcome), `unexpected outcome ${r.outcome}`);
    assert.ok(reasons.has(r.reason), `unexpected reason ${r.reason}`);
  }
});
