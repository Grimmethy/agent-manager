'use strict';

// Retraction-note gate at candidate apply (src/candidate-docs.js retractionGateReason).
// Run: node --test test/candidate-docs-retraction-gate.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { applyArchDiscoveryCandidates } = require('../src/candidate-docs.js');

// Fixtures reproduce the reported shape of the AC-60..62 retraction notes.
const RETRACT_AC60 = [
  '### AC-60 · ~~MF filter bypasses dedupe~~ -- **RETRACTED**',
  'Strength: Strong',
  'Files: src/a.js',
  '',
  'Status: Withdrawn. No defect exists.',
].join('\n');

const RETRACT_AC61 = [
  '### AC-61 · MF filter bypass -- Withdrawn',
  'Strength: Strong',
  'Files: src/b.js',
  '',
  'Status: Withdrawn. No defect exists.',
].join('\n');

// No Files: line -> body anchor falls back to the heading, so Strength: sits at the start of body.
const RETRACT_AC62 = [
  '### AC-62 · Summary of corrections applied',
  'Strength: Strong',
  '',
  'Status: No defect exists.',
].join('\n');

const NORMAL_AC70 = [
  '### AC-70 · Cache miss on stale key',
  'Strength: Strong',
  'Files: src/cache.js',
  '',
  'Problem: the earlier approach was retracted in review, but the key is still stale on reload.',
  '',
  'Solution: invalidate the key on write.',
].join('\n');

// Protected: "Withdrawal" is not "Withdrawn", and the status value starts with "Open", not a retraction phrase.
const PROTECTED_AC71 = [
  '### AC-71 · Withdrawal flow skips balance check',
  'Strength: Strong',
  'Files: src/w.js',
  '',
  'Status: Open -- not a defect in the caller, but the balance check is skipped.',
].join('\n');

function run(implementResponse) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retraction-gate-'));
  const candidatesPath = path.join(dir, 'ARCH_REVIEW_CANDIDATES.md');
  const result = applyArchDiscoveryCandidates({ implementResponse, candidatesPath });
  const text = fs.existsSync(candidatesPath) ? fs.readFileSync(candidatesPath, 'utf8') : null;
  return { result, text };
}

test('the three AC-60..62 retraction sections are skipped with a reason each', () => {
  const { result, text } = run([RETRACT_AC60, RETRACT_AC61, RETRACT_AC62].join('\n\n'));
  assert.equal(result.skipped, true);
  assert.equal(text, null, 'nothing must be written when every block is a retraction');
  assert.deepEqual(result.skippedByGate.map((s) => s.id), ['AC-60', 'AC-61', 'AC-62']);
  assert.deepEqual(result.skippedByGate.map((s) => s.rule), ['R1', 'R1', 'R2']);
  for (const s of result.skippedByGate) {
    assert.match(s.reason, /^retraction-gate:R[12]$/);
    assert.ok(s.title.length <= 80);
  }
});

test('a retraction block is dropped while real candidates in the same batch are kept', () => {
  const { result, text } = run([RETRACT_AC60, NORMAL_AC70].join('\n\n'));
  assert.equal(result.skipped, undefined);
  assert.equal(result.candidateCount, 1);
  assert.deepEqual(result.skippedByGate.map((s) => s.id), ['AC-60']);
  assert.match(text, /Cache miss on stale key/);
  assert.doesNotMatch(text, /RETRACTED|Withdrawn\. No defect/);
});

test('prose mentioning "retracted" in a body is kept', () => {
  const { result, text } = run(NORMAL_AC70);
  assert.equal(result.candidateCount, 1);
  assert.equal(result.skippedByGate, undefined);
  assert.match(text, /the earlier approach was retracted in review/);
});

test('a title containing "Withdrawal" and a non-retraction Status line are kept', () => {
  const { result, text } = run(PROTECTED_AC71);
  assert.equal(result.candidateCount, 1);
  assert.equal(result.skippedByGate, undefined);
  assert.match(text, /Withdrawal flow skips balance check/);
});
