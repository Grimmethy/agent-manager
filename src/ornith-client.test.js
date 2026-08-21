'use strict';

// Unit tests for ornith-client.js's detectDegenerate() -- pure and easy to test in
// isolation, unlike call()/callOnce() which need real (or heavily mocked) HTTP/GPU-
// capacity/throughput plumbing. No test file existed for this module before; scoped to
// just this function rather than building out a full harness for the rest.
//
// Run: node --test src/ornith-client.test.js  (or `npm test`)

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectDegenerate } = require('./ornith-client.js');

test('detectDegenerate flags a genuinely empty response as "empty"', () => {
  assert.equal(detectDegenerate(''), 'empty');
  assert.equal(detectDegenerate('   '), 'empty');
  assert.equal(detectDegenerate(null), 'empty');
});

test('detectDegenerate respects allowEmpty for a genuinely empty response', () => {
  assert.equal(detectDegenerate('', { allowEmpty: true }), null);
});

// Re-applied fresh 2026-08-21 (originally drafted on the now-9-days-stale
// review-pipeline-hardening branch, which had diverged too far from current
// ornith-client.js to merge cleanly -- see this session's branch-conflict investigation).
test('detectDegenerate flags the literal two-character JSON-style empty-string quirk ("" or \'\') the same as genuine emptiness', () => {
  assert.equal(detectDegenerate('""'), 'empty');
  assert.equal(detectDegenerate("''"), 'empty');
  // Whitespace-padded is still the same quirk.
  assert.equal(detectDegenerate('  ""  '), 'empty');
});

test('detectDegenerate respects allowEmpty for the two-character quirk too, not just genuine emptiness', () => {
  assert.equal(detectDegenerate('""', { allowEmpty: true }), null);
  assert.equal(detectDegenerate("''", { allowEmpty: true }), null);
});

test('detectDegenerate does not false-positive on real short JSON containing quotes', () => {
  // A real, non-degenerate two-character-adjacent string should not be caught -- only the
  // EXACT literal '""'/"''" (nothing else) counts as the quirk.
  assert.equal(detectDegenerate('{"a":1}'), null);
});

test('detectDegenerate still flags repeated-character garbage', () => {
  assert.equal(detectDegenerate('0'.repeat(30)), 'repeated-character');
});

test('detectDegenerate still flags a repetition loop', () => {
  const chunk = 'the quick brown fox jumps over';
  const text = Array(4).fill(chunk).join(' more filler text here to pad it out ');
  assert.equal(detectDegenerate(text), 'repetition-loop');
});

test('detectDegenerate still flags non-ascii gibberish', () => {
  assert.equal(detectDegenerate('こんにちは世界これは日本語のテキストです'), 'non-ascii-gibberish');
});

test('detectDegenerate returns null for genuinely fine text', () => {
  assert.equal(detectDegenerate('This is a normal, real response with real content in it.'), null);
});
