'use strict';

// Tests for src/failure-render.js (HUB0844 · 2/5).
//
// Sets HOME to a temp dir so no real filesystem state is touched.
// Uses node:test (the repo's test runner).
//
// Run: node --test tests/failure-render.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Point HOME at a temp dir before requiring the module under test.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'failure-render-home-'));
process.env.HOME = tmpHome;

const {
  normalizeFailure,
  renderFailures,
  summarizeFailingTests,
  extractResourceWarnings,
} = require('../src/failure-render.js');

const failing = {
  testId: 'suite.case.renders_message',
  message: 'AssertionError: expected 2 to equal 3',
  stack: 'AssertionError: expected 2 to equal 3\n    at Context.<anonymous> (tests/x.test.js:10:5)',
};

test('a failing object yields its testId and assertion text, never [object Object]', () => {
  const normalized = normalizeFailure(failing);
  assert.equal(normalized.testId, failing.testId);
  assert.match(normalized.message, /expected 2 to equal 3/);

  const out = renderFailures([failing]);
  assert.ok(out.includes(failing.testId), 'output should name the testId');
  assert.ok(out.includes('expected 2 to equal 3'), 'output should include the assertion text');
  assert.ok(!out.includes('[object Object]'), 'output must not contain [object Object]');

  assert.ok(summarizeFailingTests([failing]).includes(failing.testId));
});

test('an empty failure list gives empty output (passed verdict)', () => {
  // No verdict function is named by the contract; an empty list is the passed case,
  // asserted through its empty outputs.
  assert.equal(renderFailures([]), '');
  assert.equal(summarizeFailingTests([]), '');
});

test('ResourceWarning lines are extracted from stderr', () => {
  const stderr = [
    'some ordinary log line',
    '(node:123) ResourceWarning: unclosed file',
    'another ordinary line',
  ].join('\n');

  const found = extractResourceWarnings(stderr);
  assert.ok(Array.isArray(found));
  assert.equal(found.length, 1);
  assert.ok(found[0].includes('ResourceWarning'));

  assert.deepEqual(extractResourceWarnings('all quiet\n'), []);
});
