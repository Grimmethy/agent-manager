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

// --- 2026-09-15 regression (day-of PR #265, root-caused hours later): a complete,
// correct Group A implementResponse (prose summary + real diff) was misflagged
// "truncated" because the old fallback both (a) tried to extract-and-parse JSON from
// ANYWHERE in the text (grabbing a brace pair from inside real code) and (b) treated any
// unparsed code marker as truncation evidence. Confirmed live: ~half of real adhoc/
// brain-dump reviews false-blocked and auto-requeued for a from-scratch redraft in the
// hours after this landed. ------------------------------------------------------------

test('does not flag a complete Group A implementResponse (summary + real diff)', () => {
  const text = [
    'RESOLUTION: implemented',
    '',
    'Added getSecondBrainDir()/requireSecondBrainDir() to src/config.js.',
    '',
    'Acceptance:',
    '1. helpers exist -- read src/config.js -- PASS',
    '',
    '=== DIFF ===',
    'diff --git a/src/config.js b/src/config.js',
    '--- a/src/config.js',
    '+++ b/src/config.js',
    '@@ -440,4 +440,8 @@ function ensureRegistered() {',
    '   }',
    ' }',
    '',
    '-module.exports = { getConfig };',
    '+function getSecondBrainDir() { return process.env.SECOND_BRAIN_DIR || null; }',
    '+',
    '+module.exports = { getConfig, getSecondBrainDir };',
    '',
  ].join('\n');
  assert.deepEqual(detectTruncatedImplementResponse(text), { truncated: false, reason: null });
});

test('does not flag the real 2026-09-15 incident text (adhoc-add-7-coverage-path-tests-to-src-config-test-js-1789403753654-1, ends in a complete ordinary sentence, 7457 real chars in production)', () => {
  const text = 'All acceptance criteria verified. The `exitCode: 1` is just because the final `git diff` step ran against a worktree that had already been reset -- confirmed via git-runner.js: the reason we\'re moving to a dedicated apply worktree instead of the shared checkout is that resetToMain() in git-runner.js auto-stashes\n';
  assert.deepEqual(detectTruncatedImplementResponse(text), { truncated: false, reason: null });
});

test('does not flag a RESOLUTION: decompose response (a fixed-format prefix line followed by a real JSON array)', () => {
  const text = 'RESOLUTION: decompose\n\n[{"title": "Add config plumbing", "rawText": "Add a new path, e.g. AGENT_MANAGER_SECOND_BRAIN_REVIEW_PATH, following the pattern of existing paths in config.js."}]';
  assert.deepEqual(detectTruncatedImplementResponse(text), { truncated: false, reason: null });
});

test('still flags a genuinely truncated Group A response (cuts off mid-string inside real code, same shape as the real Topology incident)', () => {
  const text = [
    'RESOLUTION: implemented',
    '',
    '=== DIFF ===',
    'diff --git a/src/config.js b/src/config.js',
    '+function requireSecondBrainDir() { throw new Error("SECOND_BRAIN_DIR',
  ].join('\n');
  assert.deepEqual(detectTruncatedImplementResponse(text), { truncated: true, reason: 'truncated output' });
});
