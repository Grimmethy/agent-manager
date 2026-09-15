// src/validate-implement-truncation.test.js
// Run: node --test src/validate-implement-truncation.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { detectTruncatedImplementResponse } = require('./validate-implement-truncation.js');

test('flags the Topology unterminated-string case', () => {
  const result = detectTruncatedImplementResponse('...return "Topology');
  assert.deepEqual(result, { truncated: true, reason: 'truncated output' });
});

test('accepts a valid JSON envelope', () => {
  const result = detectTruncatedImplementResponse('[{"content":"hello world"}]');
  assert.deepEqual(result, { truncated: false, reason: null });
});

test('accepts a plain refusal sentence with no code', () => {
  const result = detectTruncatedImplementResponse('I cannot help with that request.');
  assert.deepEqual(result, { truncated: false, reason: null });
});

test('flags an empty string as truncated', () => {
  const result = detectTruncatedImplementResponse('');
  assert.deepEqual(result, { truncated: true, reason: 'truncated output' });
});

test('flags a sub-40-char JSON fragment as truncated', () => {
  const result = detectTruncatedImplementResponse('{"content": "he');
  assert.deepEqual(result, { truncated: true, reason: 'truncated output' });
});

// 2026-09-15, found live wiring this into review-task.js: a bare code KEYWORD (as
// opposed to a real brace/bracket/backtick marker) is not a reliable code signal --
// ordinary English sentences use these words constantly. A real brain_dump_sort refusal
// hit exactly this before the fix.
test('does not flag ordinary English refusal sentences that happen to contain code keywords', () => {
  const cases = [
    'let me read the vault first',
    'this class of bug keeps coming back',
    'please return to the previous step',
    'I cannot import that dependency here',
    'the constraints of the request make this infeasible',
  ];
  for (const text of cases) {
    assert.deepEqual(detectTruncatedImplementResponse(text), { truncated: false, reason: null }, `should not flag: "${text}"`);
  }
});
