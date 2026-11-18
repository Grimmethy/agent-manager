'use strict';

// Tests for the pure sub-task draft validator and deliverable-coverage checker.

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateSubTaskDraft, checkDeliverableCoverage } = require('./agentic-draft-validate.js');

const PROSE = 'draft is not a JSON array of sub-tasks with title and rawText';

const GOOD_DRAFT = [
  { title: 'Browser check', rawText: 'Run the browser check against the scratch dashboard.' },
  { title: 'Fresh probe', rawText: 'Send a fresh probe and confirm fewer retries.' },
];

test('validateSubTaskDraft returns the exact prose message for a plain string', () => {
  assert.deepEqual(validateSubTaskDraft('hello'), { ok: false, message: PROSE });
});

test('validateSubTaskDraft rejects a non-array value', () => {
  assert.equal(validateSubTaskDraft({ title: 'a', rawText: 'b' }).ok, false);
  assert.equal(validateSubTaskDraft(42).ok, false);
  assert.equal(validateSubTaskDraft(null).ok, false);
});

test('validateSubTaskDraft names the index and field when title is missing', () => {
  const res = validateSubTaskDraft([{ rawText: 'x' }]);
  assert.equal(res.ok, false);
  assert.match(res.message, /0/);
  assert.match(res.message, /title/);
});

test('validateSubTaskDraft names the index and field when rawText is empty', () => {
  const res = validateSubTaskDraft([{ title: 'a', rawText: 'x' }, { title: 'b', rawText: '' }]);
  assert.equal(res.ok, false);
  assert.match(res.message, /1/);
  assert.match(res.message, /rawText/);
});

test('validateSubTaskDraft accepts a valid draft given as an array or JSON text', () => {
  assert.deepEqual(validateSubTaskDraft(GOOD_DRAFT), { ok: true });
  assert.deepEqual(validateSubTaskDraft(JSON.stringify(GOOD_DRAFT)), { ok: true });
});

test('checkDeliverableCoverage passes when both halves are present (case-insensitive)', () => {
  assert.deepEqual(checkDeliverableCoverage('task', GOOD_DRAFT), { ok: true });
  const upper = [
    { title: 'BROWSER', rawText: 'Use the SCRATCH DASHBOARD.' },
    { title: 'FRESH PROBE', rawText: 'Expect FEWER errors.' },
  ];
  assert.deepEqual(checkDeliverableCoverage('task', upper), { ok: true });
});

test('checkDeliverableCoverage reports missing coverage: a when the browser phrase is absent', () => {
  const draft = [{ title: 'Probe', rawText: 'fresh probe with fewer calls' }];
  assert.deepEqual(checkDeliverableCoverage('task', draft), { ok: false, message: 'missing coverage: a' });
});

test('checkDeliverableCoverage reports missing coverage: b when the probe phrase is absent', () => {
  const draft = [{ title: 'Browser', rawText: 'open the scratch dashboard' }];
  assert.deepEqual(checkDeliverableCoverage('task', draft), { ok: false, message: 'missing coverage: b' });
});
