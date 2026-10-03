'use strict';

// Tests for src/pipeline/gate-deterministic-check.js (HUB0137 2/3).
//
// Contract under test (verified against the module source):
//   gateDeterministicCheck(draftPath, testFilePath, testName, opts?) ->
//     { approved: true,  reason: 'test-passed' }         -- draft contains testName AND `node --test` exits 0
//     { approved: false, reason: 'test-name-not-found' } -- draft missing/unreadable, or lacks testName (test NOT run)
//     { approved: false, reason: 'test-failed' }         -- name present but `node --test` exits non-zero (or times out)
// A test FILE that does not exist is a non-zero `node --test` exit, so (with the name
// present) it maps to 'test-failed' -- the same reason as a present-but-failing test.
//
// The gate strips NODE_TEST_* (incl. NODE_TEST_CONTEXT) from the child environment
// before running `node --test`; this matters because this file is itself run under
// `node --test`, so the child would otherwise believe it is an IPC worker and exit 0
// regardless of its own result. The gate's env-stripping is exactly what makes the
// failing/missing-file cases below report a real failure.
//
// Run: node --test test/gate-deterministic-check.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { gateDeterministicCheck } = require('../src/pipeline/gate-deterministic-check.js');

// The exact test name the draft is searched for. The gate does a plain substring
// search, so any unique token works.
const TEST_NAME = 'acceptance-check-for-gate-deterministic-check';

// Write a file into a fresh temp dir; returns its absolute path.
function writeFile(content, baseName = 'draft.txt') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-dc-'));
  const p = path.join(dir, baseName);
  fs.writeFileSync(p, content);
  return p;
}

// (a) A draft that DOES contain TEST_NAME, and (b) one that does not.
const draftWith = writeFile(`# Draft\n\nThis change is covered by \`${TEST_NAME}\`.\n`);
const draftWithout = writeFile('# Draft\n\nThis change does not name that test anywhere.\n');

// A `node --test` file that passes, one that fails, and a path to a file that does not exist.
const passingTest = writeFile(
  "const { test } = require('node:test');\ntest('ok', () => {});\n",
  'passing.test.js'
);
const failingTest = writeFile(
  "const { test } = require('node:test');\n" +
  "const assert = require('node:assert/strict');\n" +
  "test('nope', () => { assert.strictEqual(1, 2); });\n",
  'failing.test.js'
);
const missingTest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gate-dc-missing-')), 'absent.test.js');
assert.ok(!fs.existsSync(missingTest), 'the "missing test file" stand-in must not actually exist');

// (1) Test name present, but the named test fails -> test-failed.
test('(1) name present but test fails -> { approved:false, reason:"test-failed" }', () => {
  const r = gateDeterministicCheck(draftWith, failingTest, TEST_NAME);
  assert.equal(r.approved, false);
  assert.equal(r.reason, 'test-failed');
});

// (2) Test name present, and the named test passes -> test-passed.
test('(2) name present and test passes -> { approved:true, reason:"test-passed" }', () => {
  const r = gateDeterministicCheck(draftWith, passingTest, TEST_NAME);
  assert.equal(r.approved, true);
  assert.equal(r.reason, 'test-passed');
});

// (3) Test name missing from the draft -> test-name-not-found (test is never run).
test('(3) name missing -> { approved:false, reason:"test-name-not-found" }', () => {
  const r = gateDeterministicCheck(draftWithout, passingTest, TEST_NAME);
  assert.equal(r.approved, false);
  assert.equal(r.reason, 'test-name-not-found');
});

// (4) Test file missing (name present) -> node --test exits non-zero -> test-failed.
test('(4) test file missing -> { approved:false, reason:"test-failed" }', () => {
  const r = gateDeterministicCheck(draftWith, missingTest, TEST_NAME);
  assert.equal(r.approved, false);
  assert.equal(r.reason, 'test-failed');
});
