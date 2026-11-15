'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { computeMechanicalPreChecks } = require('./adhoc-mechanical-prechecks.js');

// A minimal clean adhoc task: no IDs, no cost claims, no block history -- passes every
// deterministic check on its own.
function cleanTask() {
  return {
    id: 'adhoc-clean',
    title: 'Update src/real.js to add a guard',
    implementResponse: 'Edited src/real.js to add a null guard before the retry loop.',
  };
}

test('all checks passing gives mechanicalPass true', () => {
  const r = computeMechanicalPreChecks(cleanTask(), []);
  assert.equal(r.fileExists, true);
  assert.equal(r.idExists, true);
  assert.equal(r.costMatches, true);
  assert.equal(r.forbiddenPathClear, true);
  assert.equal(r.mechanicalPass, true);
});

test('accepts the full checkDraft() result object, not just the flags array', () => {
  const r = computeMechanicalPreChecks(cleanTask(), { flags: [], fileChecks: [] });
  assert.equal(r.mechanicalPass, true);
});

test('a missing-file flag gives fileExists false and mechanicalPass false', () => {
  const r = computeMechanicalPreChecks(cleanTask(), [
    { type: 'missing-file', detail: 'src/phantom.js' },
  ]);
  assert.equal(r.fileExists, false);
  assert.equal(r.mechanicalPass, false);
});

test('an ungrounded-path flag also fails fileExists', () => {
  const r = computeMechanicalPreChecks(cleanTask(), [
    { type: 'ungrounded-path', detail: 'python/does-not-exist.py' },
  ]);
  assert.equal(r.fileExists, false);
  assert.equal(r.mechanicalPass, false);
});

test('an isCreateTarget-stamped missing-file flag is carved out (fileExists true)', () => {
  const r = computeMechanicalPreChecks(cleanTask(), [
    { type: 'missing-file', detail: 'src/brand-new.js', isCreateTarget: true },
  ]);
  assert.equal(r.fileExists, true);
  assert.equal(r.mechanicalPass, true);
});

test('an informational imprecise-file-path flag does NOT fail fileExists', () => {
  const r = computeMechanicalPreChecks(cleanTask(), [
    { type: 'imprecise-file-path', detail: 'app.py -> server/app.py' },
  ]);
  assert.equal(r.fileExists, true);
});

test('zero ID citations gives idExists true (conservative pass)', () => {
  const r = computeMechanicalPreChecks(cleanTask(), []);
  assert.equal(r.idExists, true);
});

test('an ID cited in the response AND present in a flag gives idExists false', () => {
  const task = { ...cleanTask(), implementResponse: 'Per AC-123, the fix lives in src/real.js.' };
  const r = computeMechanicalPreChecks(task, [
    { type: 'ungrounded-field', detail: 'AC-123 is not grounded in the source material' },
  ]);
  assert.equal(r.fileExists, true); // ungrounded-field is not a file problem -- isolates idExists
  assert.equal(r.idExists, false);
  assert.equal(r.mechanicalPass, false);
});

test('an ID cited in the response but absent from all flags still gives idExists true', () => {
  const task = { ...cleanTask(), implementResponse: 'Fixes AC-42; HUB0068-02 is covered; see bd-178.' };
  const r = computeMechanicalPreChecks(task, [
    { type: 'unconfirmed-relationship', detail: 'unrelated note' },
  ]);
  assert.equal(r.idExists, true);
  assert.equal(r.mechanicalPass, true);
});

test('a kebab-slug citation flagged in a flag gives idExists false', () => {
  const task = {
    ...cleanTask(),
    implementResponse: 'Extends the function-length-fix-ac-34 work in src/real.js.',
  };
  const r = computeMechanicalPreChecks(task, [
    { type: 'fabricated-commit-reference', detail: 'function-length-fix-ac-34' },
  ]);
  assert.equal(r.idExists, false);
  assert.equal(r.mechanicalPass, false);
});

test('no cost claims gives costMatches true regardless of the record', () => {
  const r = computeMechanicalPreChecks(cleanTask(), []);
  assert.equal(r.costMatches, true);
});

test('a cost claim contradicting the recorded stats gives costMatches false', () => {
  const task = {
    ...cleanTask(),
    implementResponse: 'This draft used 12 model calls this session.',
    modelCallStats: { calls: 5 },
  };
  const r = computeMechanicalPreChecks(task, []);
  assert.equal(r.costMatches, false);
  assert.equal(r.mechanicalPass, false);
});

test('a cost claim whose number appears verbatim in the record gives costMatches true', () => {
  const task = {
    ...cleanTask(),
    implementResponse: 'This draft used 5 model calls this session.',
    modelCallStats: { calls: 5 },
  };
  const r = computeMechanicalPreChecks(task, []);
  assert.equal(r.costMatches, true);
  assert.equal(r.mechanicalPass, true);
});

test('a cost claim with NO recorded stats/history is unverified, and unverified is not a mechanicalPass', () => {
  const task = {
    id: 'adhoc-no-record',
    implementResponse: 'This draft used 12 model calls this session.',
  };
  const r = computeMechanicalPreChecks(task, []);
  assert.equal(r.costMatches, 'unverified');
  assert.equal(r.mechanicalPass, false);
});

test('a cost-adjacent number that IS in the task history does not fail costMatches', () => {
  const task = {
    ...cleanTask(),
    implementResponse: '7 turns were used for this edit.',
    history: [{ stage: 'implement', turnsUsed: 7 }],
  };
  const r = computeMechanicalPreChecks(task, []);
  assert.equal(r.costMatches, true);
});

test('forbiddenPathClear false when the block names the task\'s own declared target', () => {
  const task = {
    ...cleanTask(),
    blockedReason: 'src/real.js matches forbidden "src/real.js"',
  };
  const r = computeMechanicalPreChecks(task, []);
  assert.equal(r.forbiddenPathClear, false);
  assert.equal(r.mechanicalPass, false);
});

test('does not make model calls -- no network/subprocess/LLM-client imports at all', () => {
  const src = fs.readFileSync(path.join(__dirname, 'adhoc-mechanical-prechecks.js'), 'utf8');
  assert.ok(!/child_process|execFile|spawn|https?\.request|\bfetch\(|local-client|model-provider|majorityVote/.test(src));
  const requires = [...src.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
  assert.deepEqual(requires, ['./lib/reject-retry-check.js']);
});
