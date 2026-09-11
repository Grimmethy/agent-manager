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
