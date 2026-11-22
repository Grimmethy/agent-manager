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

// --- Regression tests for the live false-positive root-caused by the self-audit
// queue/done/_archived/2026-09/pipeline-self-audit-function_length_review-truncated-draft-1788034686181:
// function_length_review advisory drafts that merely QUOTE and DISCUSS code (fenced ```js
// blocks, diff hunks with braces/brackets) were misflagged "truncated". The source-aware
// advisoryProse carve-out in detectTruncatedImplementResponse (advisoryProse guard on the
// registered source entry) fixes that; these tests lock it in, and the third test proves
// the real Topology-incident signal (odd unescaped double-quote in the final token) STILL
// fires for non-advisory sources. function_length_review is a plugin (agent-manager-hygiene)
// source, so a bare `node --test` process has not registered it with the task-source
// registry -- register it here exactly the way apply-task.test.js registers its fixture
// sources, so the carve-out path is actually exercised rather than vacuously skipped.
const { registerTaskSource, getRegisteredSource } = require('./task-source-registry.js');
if (!getRegisteredSource('function_length_review')) {
  registerTaskSource('function_length_review', { priority: 90, next: () => null, advisoryProse: true });
}

test('function_length_review advisory draft quoting a fenced js block with braces is NOT flagged truncated (ends in an odd unescaped quote, so it WOULD be flagged without the advisoryProse carve-out)', () => {
  const draft = [
    '### AC-1: extract the 214-line processTask body into helpers',
    '',
    'The current function mixes payload extraction with queue bookkeeping.',
    '',
    '```js',
    'function extractPayload(task) {',
    '  const body = task.body || {};',
    '  const meta = task.meta || [];',
    '  return { body, meta };',
    '}',
    '```',
    '',
    'That leaves the "outer" loop untouched -- the "loop',
  ].join('\n');
  assert.deepEqual(
    detectTruncatedImplementResponse(draft, 'function_length_review'),
    { truncated: false, reason: null },
  );
});

test('function_length_review advisory draft quoting a diff hunk containing { and [] is NOT flagged truncated (also ends in an odd unescaped quote, so it WOULD be flagged without the advisoryProse carve-out)', () => {
  const draft = [
    '### AC-2: split validateInput out of the main loop',
    '',
    'Proposed diff:',
    '',
    '```diff',
    '--- a/src/worker.js',
    '+++ b/src/worker.js',
    '@@ -12,7 +12,10 @@ function process(batch) {',
    ' const items = batch.filter(x => x.active);',
    '+ const valid = items.map(x => ({ ...x, n: x.n + 1 }));',
    '+ const buckets = valid.reduce((acc, x) => { acc[x.key] = (acc[x.key] || []).concat(x); return acc; }, []);',
    '+ return { items: valid, buckets };',
    ' }',
    '```',
    '',
    'Net: process() shrinks by ~40 lines; the "buckets" field keeps the "shape',
  ].join('\n');
  assert.deepEqual(
    detectTruncatedImplementResponse(draft, 'function_length_review'),
    { truncated: false, reason: null },
  );
});

test('non-advisory source whose final token has an odd number of unescaped double-quotes is STILL flagged truncated (the real Topology-incident signal survives the advisoryProse carve-out)', () => {
  const draft = 'All acceptance criteria verified. Final line: return "Topology';
  assert.deepEqual(
    detectTruncatedImplementResponse(draft, 'adhoc'),
    { truncated: true, reason: 'truncated output' },
  );
  // Legacy no-source shape must be equally unaffected by the advisoryProse guard.
  assert.deepEqual(
    detectTruncatedImplementResponse(draft),
    { truncated: true, reason: 'truncated output' },
  );
});

// --- COMPLETE-DIFF EXEMPTION (2026-10-18): a diff that is complete per its hunk headers is never "truncated output" ---------------------
const { diffIsComplete, TRUNCATION_GATE_VERSION } = require('./validate-implement-truncation.js');

const groupA = (diffLines) => ['RESOLUTION: implemented', '', 'Acceptance:', '1. done -- ran the tests -- PASS', '', '=== DIFF ===', ...diffLines, ''].join('\n');
// Real shape 1 (premium reach 3/5, 2026-10-18): the diff's last context line is an unchanged comment ending in a quoted phrase.
const QUOTED_LAST_TOKEN = [
  'diff --git a/scripts/review-runner.sh b/scripts/review-runner.sh',
  '--- a/scripts/review-runner.sh',
  '+++ b/scripts/review-runner.sh',
  '@@ -148,4 +148,4 @@ while :; do',
  '-  done < <(ls -1tr "$review_dir" 2>/dev/null)',
  '+  done < <(if "$PREMIUM_ONLY"; then ls -1tr "$review_dir" | filter_premium_names "$review_dir"; else ls -1tr "$review_dir"; fi)',
  ' ',
  '   # Iterate each item currently sitting in review/, oldest-first BY FILE MTIME (fixed',
  '   # 2026-08-20, Grimmethy: "we need to build this sort of analysis into the daily report"',
];
// Real shape 2 (HUB0073-01): the diff ends on the close of a quoted comment opened one line earlier -- odd quotes on the last LINE too.
const MULTILINE_QUOTED_COMMENT = [
  'diff --git a/scripts/start-pipeline.sh b/scripts/start-pipeline.sh',
  '--- a/scripts/start-pipeline.sh',
  '+++ b/scripts/start-pipeline.sh',
  '@@ -10,3 +10,4 @@',
  ' write_env() {',
  '+  mirror_env "$@"',
  '     # 2026-09-30 (Grimmethy: "the project dropdown should list every repo',
  '     # [in the Project tab] -- we should be able to select from any of the projects"):',
];

test('complete diff whose last context line ends in a quoted phrase is NOT flagged (real 2026-10-18 false block)', () => {
  assert.deepEqual(detectTruncatedImplementResponse(groupA(QUOTED_LAST_TOKEN)), { truncated: false, reason: null });
});

test('complete diff ending on the close of a multi-line quoted comment is NOT flagged (real HUB0073-01 false block)', () => {
  assert.deepEqual(detectTruncatedImplementResponse(groupA(MULTILINE_QUOTED_COMMENT), 'manual'), { truncated: false, reason: null });
});

test('the same diff with its last hunk one line short IS still flagged (a cut-off diff falls through to the quote rule)', () => {
  // Cut mid-line inside the quoted phrase: the hunk is one line short, so the exemption does not apply and the existing last-token rule
  // decides (it flags `"we`). A cut whose last token holds no quote was never flagged by that rule and still is not -- unchanged behaviour.
  const cut = groupA(QUOTED_LAST_TOKEN.slice(0, -2).concat(['   # 2026-08-20, Grimmethy: "we']));
  assert.equal(diffIsComplete(cut), false, 'one line short of the declared counts');
  assert.deepEqual(detectTruncatedImplementResponse(cut), { truncated: true, reason: 'truncated output' });
});

test('diffIsComplete: omitted counts mean 1, multiple files and hunks, "\\ No newline", and a diff with no hunk header', () => {
  assert.equal(diffIsComplete(groupA(['--- a/x', '+++ b/x', '@@ -5 +5 @@', '-a', '+b'])), true);
  assert.equal(diffIsComplete(groupA(['--- a/x', '+++ b/x', '@@ -1,2 +1,2 @@', ' k', '-a', '+b', '\\ No newline at end of file',
    'diff --git a/y b/y', '--- a/y', '+++ b/y', '@@ -3,1 +3,2 @@', ' z', '+w'])), true);
  assert.equal(diffIsComplete(groupA(['diff --git a/src/config.js b/src/config.js', '+function x() { throw new Error("SECOND_BRAIN_DIR'])), false, 'no hunk header');
  assert.equal(diffIsComplete('no diff here "at all'), false);
});

test('TRUNCATION_GATE_VERSION is exported for the bucket J re-admission', () => {
  assert.equal(typeof TRUNCATION_GATE_VERSION, 'string');
  assert.ok(TRUNCATION_GATE_VERSION.length > 0);
});
