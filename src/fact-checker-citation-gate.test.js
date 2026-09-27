'use strict';

// Unit tests for checkCitationsAgainstHarnessFiles (2026-09-16) -- the hard
// pre-flight gate in fact-checker.js that validates every cited file path and line
// number against the harness-search file checklist (task.promptContext.harnessFiles)
// before the implement pass is scored.
//
// Run: node --test src/fact-checker-citation-gate.test.js

const test = require('node:test');
const assert = require('node:assert');
const { checkCitationsAgainstHarnessFiles } = require('./fact-checker.js');

test('valid: a cited path in the checklist with an in-range line passes', () => {
  const r = checkCitationsAgainstHarnessFiles(
    'Fix the bug in src/foo.js:2.',
    [{ path: 'src/foo.js', content: 'a\nb\nc' }]
  );
  assert.strictEqual(r.valid, true);
  assert.deepStrictEqual(r.failures, []);
});

test('reject: a cited file not in the checklist is not_in_harness_files', () => {
  const r = checkCitationsAgainstHarnessFiles(
    'Fix the bug in src/bar.js:10.',
    [{ path: 'src/foo.js', content: 'a\nb\nc' }]
  );
  assert.strictEqual(r.valid, false);
  assert.ok(r.failures.some((f) => f.reason === 'not_in_harness_files' && f.path === 'src/bar.js'));
});

test('reject: a line number past the checklist content window is line_out_of_range', () => {
  const r = checkCitationsAgainstHarnessFiles(
    'Fix the bug in src/foo.js:9999.',
    [{ path: 'src/foo.js', content: 'a\nb\nc' }]
  );
  assert.strictEqual(r.valid, false);
  const f = r.failures.find((x) => x.path === 'src/foo.js');
  assert.ok(f, 'expected a failure for src/foo.js');
  assert.strictEqual(f.reason, 'line_out_of_range');
  assert.strictEqual(f.line, 9999);
});

test('no-op: an empty checklist passes (nothing to gate against)', () => {
  assert.deepStrictEqual(
    checkCitationsAgainstHarnessFiles('see src/foo.js:2', []),
    { valid: true, failures: [] }
  );
});

test('no-op: an undefined checklist passes', () => {
  assert.deepStrictEqual(
    checkCitationsAgainstHarnessFiles('see src/foo.js:2', undefined),
    { valid: true, failures: [] }
  );
});

test('no-op: empty draft text passes regardless of checklist', () => {
  assert.deepStrictEqual(
    checkCitationsAgainstHarnessFiles('', [{ path: 'src/foo.js', content: 'a' }]),
    { valid: true, failures: [] }
  );
});

test('excluded: a create-mode target not in the checklist is not flagged', () => {
  const draft = JSON.stringify([{ mode: 'create', file: 'src/new-module.js', note: 'new file' }]);
  const r = checkCitationsAgainstHarnessFiles(
    draft,
    [{ path: 'src/foo.js', content: 'a\nb' }]
  );
  assert.ok(!r.failures.some((f) => f.path === 'src/new-module.js'),
    'create-mode target must not be flagged as not_in_harness_files');
});

test('basename fallback: a bare unique-basename citation matches a nested checklist path', () => {
  const r = checkCitationsAgainstHarnessFiles(
    'Fix the bug in app.py:1.',
    [{ path: 'python/dashboard/app.py', content: 'x' }]
  );
  assert.strictEqual(r.valid, true);
  assert.deepStrictEqual(r.failures, []);
});

test('ambiguous basenames do NOT match via the fallback', () => {
  const r = checkCitationsAgainstHarnessFiles(
    'Fix the bug in app.py:1.',
    [
      { path: 'python/dashboard/app.py', content: 'x' },
      { path: 'other/app.py', content: 'y' },
    ]
  );
  assert.strictEqual(r.valid, false);
  assert.ok(r.failures.some((f) => f.path === 'app.py' && f.reason === 'not_in_harness_files'));
});

test('URL host:port is not treated as a file:line citation', () => {
  const r = checkCitationsAgainstHarnessFiles(
    'See https://example.com:8080/docs for the API in src/foo.js:1.',
    [{ path: 'src/foo.js', content: 'a' }]
  );
  assert.strictEqual(r.valid, true);
  assert.deepStrictEqual(r.failures, []);
});
