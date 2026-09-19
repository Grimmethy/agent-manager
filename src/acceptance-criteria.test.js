'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveAcceptanceCriteria, parseAcceptanceBlock, parseCriteriaBlock, detectContradictoryLiteralAcceptance, declaredEditFiles, dropSingleFileScopeContradictions } = require('./acceptance-criteria.js');
const { runAcceptanceCommand } = require('./acceptance-command-gate.js');

test('resolveAcceptanceCriteria: promptContext array', () => {
  const r = resolveAcceptanceCriteria({ promptContext: { acceptanceCriteria: ['x passes', 'y is 200'] } });
  assert.deepEqual(r, { criteria: ['x passes', 'y is 200'], source: 'promptContext' });
});

test('resolveAcceptanceCriteria: promptContext newline string, bullet-stripped', () => {
  const r = resolveAcceptanceCriteria({ promptContext: { acceptanceCriteria: '- a\n- b\n1. c' } });
  assert.deepEqual(r.criteria, ['a', 'b', 'c']);
  assert.equal(r.source, 'promptContext');
});

test('resolveAcceptanceCriteria: falls back to a trailing CRITERIA: block in the plan', () => {
  const plan = '1. do a thing\n2. do another\n\nCRITERIA:\n- pytest test_x passes\n- GET /api/y returns 200';
  const r = resolveAcceptanceCriteria({ planResponse: plan });
  assert.deepEqual(r.criteria, ['pytest test_x passes', 'GET /api/y returns 200']);
  assert.equal(r.source, 'plan-derived');
});

test('resolveAcceptanceCriteria: none -> empty + null source', () => {
  assert.deepEqual(resolveAcceptanceCriteria({ planResponse: '1. just a plan' }), { criteria: [], source: null });
});

test('parseCriteriaBlock: stops at a blank line after the bullets', () => {
  const r = parseCriteriaBlock('CRITERIA:\n- one\n- two\n\nunrelated trailing prose');
  assert.deepEqual(r, ['one', 'two']);
});

test('parseAcceptanceBlock: three-part lines, PASS/FAIL detection', () => {
  const s = 'summary\n\nAcceptance:\n1. x passes -- ran pytest -- PASS (3 passed)\n2. y is 200 -- curl localhost -- FAIL got 500\n- z exists -- ls -- could not check -- no shell';
  const r = parseAcceptanceBlock(s);
  assert.equal(r.length, 3);
  assert.equal(r[0].pass, true);
  assert.equal(r[1].pass, false);
  assert.equal(r[2].pass, false);
  assert.equal(r[0].check, 'ran pytest');
});

test('parseAcceptanceBlock: absent block -> []', () => {
  assert.deepEqual(parseAcceptanceBlock('RESOLUTION: implemented\ndid the thing'), []);
});

test('runAcceptanceCommand: empty command -> ok, no checks', () => {
  assert.deepEqual(runAcceptanceCommand({ repoRoot: '/x', command: '  ' }), { ok: true, checks: [] });
});

test('runAcceptanceCommand: success via injected exec', () => {
  const exec = () => 'all good\n';
  const r = runAcceptanceCommand({ repoRoot: '/x', command: 'true', exec });
  assert.equal(r.ok, true);
  assert.equal(r.checks[0].status, 'pass');
});

test('runAcceptanceCommand: failure via injected exec that throws', () => {
  const exec = () => { const e = new Error('exit 1'); e.stderr = 'AssertionError: 500 != 200'; throw e; };
  const r = runAcceptanceCommand({ repoRoot: '/x', command: 'pytest', exec });
  assert.equal(r.ok, false);
  assert.equal(r.checks[0].status, 'fail');
  assert.match(r.checks[0].detail, /AssertionError/);
});

// --- detectContradictoryLiteralAcceptance (2026-09-15, brain-dump bd-1789433484492,
// "pipeline hardening 5/5") -- root-caused live against system-report.js's
// LESSONS-LEARNED comment task, which burned 3 real automated attempts before a human
// caught that its own acceptance check was unsatisfiable by construction. -------------

test('detectContradictoryLiteralAcceptance: the real incident text (required phrase spans a line boundary in the mandated literal)', () => {
  const rawText = "Insert exactly this text (as // comments): '// LESSONS-LEARNED CONSTRAINT:' '//   All findings file into the SAME' '//   vault, under Lessons/. Do NOT create a' '//   parallel store, sidecar DB, or separate index.' Verify the string 'Do NOT create a parallel store' appears in the header block.";
  const result = detectContradictoryLiteralAcceptance({ promptContext: { rawText } });
  assert.ok(result, 'must detect the contradiction');
  assert.equal(result.contradictory, true);
  assert.equal(result.requiredPhrase, 'Do NOT create a parallel store');
  assert.match(result.reason, /line boundary/);
});

test('detectContradictoryLiteralAcceptance: null when the required phrase fits on one line of the mandated literal', () => {
  const rawText = "Insert exactly this text: '// LESSONS-LEARNED CONSTRAINT:' '// All findings go to the SAME vault.' '// Do NOT create a parallel store.' '// See the concept note.' Verify the string 'Do NOT create a parallel store' appears in the header.";
  assert.equal(detectContradictoryLiteralAcceptance({ promptContext: { rawText } }), null);
});

test('detectContradictoryLiteralAcceptance: null when there is no literal-line cluster at all (an ordinary task)', () => {
  const rawText = "In src/foo.js, add a guard that returns early when 'input' is empty. Verify with node --test src/foo.test.js.";
  assert.equal(detectContradictoryLiteralAcceptance({ promptContext: { rawText } }), null);
});

test('detectContradictoryLiteralAcceptance: null when there is a literal-line cluster but no verify/grep clause', () => {
  const rawText = "Insert exactly this text: '// line one' '// line two' '// line three' at the top of the file.";
  assert.equal(detectContradictoryLiteralAcceptance({ promptContext: { rawText } }), null);
});

test('detectContradictoryLiteralAcceptance: null on a task with no promptContext/rawText at all', () => {
  assert.equal(detectContradictoryLiteralAcceptance({}), null);
  assert.equal(detectContradictoryLiteralAcceptance(null), null);
});

test('detectContradictoryLiteralAcceptance: only 2 quoted segments (below the cluster minimum) is not flagged even if it would otherwise match', () => {
  const rawText = "Insert: '// Do NOT create a' '// parallel store here.' Verify the string 'Do NOT create a parallel store' appears.";
  assert.equal(detectContradictoryLiteralAcceptance({ promptContext: { rawText } }), null);
});

// --- dropSingleFileScopeContradictions (2026-09-15) -- root-caused live on
// adhoc-add-getsecondbraindir-and-requiresecondbraindir-helpers-to-config-js-with-tests:
// the task's own rawText names two edit-target files (src/config.js and
// src/config.test.js), but the plan pass's own CRITERIA: block asserted a single-file-
// only scope, contradicting the very same task -- burned 6 draft attempts before a
// human caught it. -----------------------------------------------------------------

test('declaredEditFiles: picks up files named anywhere in the prose, not just the title', () => {
  const rawText = 'In src/config.js, add a helper. Also, in src/config.test.js, add tests for it.';
  assert.deepEqual(declaredEditFiles(rawText), ['src/config.js', 'src/config.test.js']);
});

test('declaredEditFiles: a file named only inside a "do not touch" clause is excluded', () => {
  const rawText = 'Edit src/foo.js to add the helper. Do not touch src/bar.js.';
  assert.deepEqual(declaredEditFiles(rawText), ['src/foo.js']);
});

test('dropSingleFileScopeContradictions: drops a single-file-scope criterion when the task itself declares 2+ edit targets', () => {
  const task = { promptContext: { rawText: 'In src/config.js, add a helper. Also, in src/config.test.js, add tests for it.' } };
  const criteria = ['requireSecondBrainDir throws when unset', 'Only src/config.js is modified -- src/config.test.js must not appear'];
  assert.deepEqual(dropSingleFileScopeContradictions(task, criteria), ['requireSecondBrainDir throws when unset']);
});

test('dropSingleFileScopeContradictions: the real incident phrasing ("no other paths" / "does not appear", not "only"/"must not")', () => {
  const task = { promptContext: { rawText: 'In src/config.js, add getSecondBrainDir. Also, in src/config.test.js, add tests for it.' } };
  const criteria = [
    '`git diff --name-only` outputs exactly `src/config.js` (one line, no other paths). `src/config.test.js` does not appear.',
    '`src/config.js` contains top-level `function getSecondBrainDir()`.',
  ];
  assert.deepEqual(dropSingleFileScopeContradictions(task, criteria), ['`src/config.js` contains top-level `function getSecondBrainDir()`.']);
});

test('dropSingleFileScopeContradictions: keeps the criterion when the task only names one file', () => {
  const task = { promptContext: { rawText: 'In src/config.js, add a helper function.' } };
  const criteria = ['Only src/config.js is modified'];
  assert.deepEqual(dropSingleFileScopeContradictions(task, criteria), criteria);
});

test('resolveAcceptanceCriteria: strips a plan-derived criterion that contradicts the task\'s own multi-file scope', () => {
  const task = {
    promptContext: { rawText: 'In src/config.js, add getSecondBrainDir. Also, in src/config.test.js, add tests for it.' },
    planResponse: 'plan text\n\nCRITERIA:\n- getSecondBrainDir returns null when unset\n- Only src/config.js is modified, src/config.test.js must not appear',
  };
  const r = resolveAcceptanceCriteria(task);
  assert.deepEqual(r.criteria, ['getSecondBrainDir returns null when unset']);
  assert.equal(r.source, 'plan-derived');
});

// 2026-09-19 (PF-Client-Portal): a plan-derived CRITERIA block asked for "git log --oneline master contains
// a commit whose subject ...", "merged to master" and "the throwaway branch is deleted" -- history outcomes a
// drafting sandbox (shared git dir mounted read-only) can never produce, so a correct draft failed acceptance.
test('resolveAcceptanceCriteria drops criteria that depend on git history written by a commit/merge/branch', () => {
  const { resolveAcceptanceCriteria } = require('./acceptance-criteria.js');
  const plan = [
    '## PLAN', '1. Edit the file.', '',
    'CRITERIA:',
    '- `.env.tower.example` contains a comment stating six Prices',
    '- `git log --oneline master` contains a commit whose subject is exactly `fix(env.example): x`',
    '- The change is merged to master',
    '- `grep -c STRIPE_PRICE_ .env.tower.example` returns 6',
  ].join('\n');
  const { criteria, source } = resolveAcceptanceCriteria({ promptContext: {}, planResponse: plan });
  assert.equal(source, 'plan-derived');
  assert.deepEqual(criteria, ['`.env.tower.example` contains a comment stating six Prices', '`grep -c STRIPE_PRICE_ .env.tower.example` returns 6']);
  const fromCtx = resolveAcceptanceCriteria({ promptContext: { acceptanceCriteria: ['File X updated', 'Merged into main'] } });
  assert.deepEqual(fromCtx.criteria, ['File X updated']);
});
