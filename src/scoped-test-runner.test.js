'use strict';

// Unit tests for scoped-test-runner.js, run against real temp directories with real
// node --test / python3 -m unittest child processes -- this module's whole job is finding
// and running REAL test files, so a mocked filesystem/exec would just prove the mocks
// agree with themselves, not that the scoping logic actually finds the right files or that
// the real test runners' output gets parsed correctly.
//
// Run: node --test src/scoped-test-runner.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const {
  findAffectedTestFiles, runScopedTests, parseNodeTestFailures, parsePyTestFailures,
  MAX_REVERSE_DEP_FILES, MAX_TEST_FILES,
} = require('./scoped-test-runner.js');

function tmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'scoped-test-runner-'));
}
function write(repoRoot, rel, content) {
  const full = path.join(repoRoot, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

// --- findAffectedTestFiles ----------------------------------------------------------

test('findAffectedTestFiles: finds a co-located JS test for a changed source file', () => {
  const repo = tmpRepo();
  write(repo, 'src/thing.js', 'module.exports = {};\n');
  write(repo, 'src/thing.test.js', '');
  const affected = findAffectedTestFiles(repo, ['src/thing.js']);
  assert.deepEqual(affected.js, ['src/thing.test.js']);
  assert.deepEqual(affected.py, []);
});

test('findAffectedTestFiles: finds a co-located Python test (test_<name>.py convention)', () => {
  const repo = tmpRepo();
  write(repo, 'app.py', '');
  write(repo, 'test_app.py', '');
  const affected = findAffectedTestFiles(repo, ['app.py']);
  assert.deepEqual(affected.py, ['test_app.py']);
  assert.deepEqual(affected.js, []);
});

test('findAffectedTestFiles: a changed file with no covering test at all yields nothing', () => {
  const repo = tmpRepo();
  write(repo, 'src/orphan.js', '');
  assert.deepEqual(findAffectedTestFiles(repo, ['src/orphan.js']), { js: [], py: [] });
});

test('findAffectedTestFiles: a changed file that IS a test file runs itself', () => {
  const repo = tmpRepo();
  write(repo, 'src/thing.test.js', '');
  assert.deepEqual(findAffectedTestFiles(repo, ['src/thing.test.js']), { js: ['src/thing.test.js'], py: [] });
});

test('findAffectedTestFiles: reverse-dependency search finds another test file that requires the changed one', () => {
  const repo = tmpRepo();
  write(repo, 'src/util.js', 'module.exports = {};\n');
  // util.js has no OWN test, but consumer.test.js requires it directly.
  write(repo, 'src/consumer.test.js', "require('./util.js');\n");
  const affected = findAffectedTestFiles(repo, ['src/util.js']);
  assert.deepEqual(affected.js, ['src/consumer.test.js']);
});

test('findAffectedTestFiles: reverse-dependency search is bounded to MAX_REVERSE_DEP_FILES', () => {
  const repo = tmpRepo();
  write(repo, 'src/util.js', '');
  for (let i = 0; i < MAX_REVERSE_DEP_FILES + 5; i += 1) {
    write(repo, `src/consumer${i}.test.js`, "require('./util.js');\n");
  }
  const affected = findAffectedTestFiles(repo, ['src/util.js']);
  assert.equal(affected.js.length, MAX_REVERSE_DEP_FILES);
});

test('findAffectedTestFiles: reverse-dependency search does not cross into unrelated directories', () => {
  const repo = tmpRepo();
  write(repo, 'src/deep/nested/util.js', '');
  // A same-named file's test two levels removed must not match -- only the changed
  // file's own directory and its immediate parent are searched.
  write(repo, 'other/far/away.test.js', "require('./util.js');\n");
  const affected = findAffectedTestFiles(repo, ['src/deep/nested/util.js']);
  assert.deepEqual(affected.js, []);
});

test('findAffectedTestFiles: overall result is capped at MAX_TEST_FILES across multiple changed files', () => {
  const repo = tmpRepo();
  const files = [];
  for (let i = 0; i < MAX_TEST_FILES + 5; i += 1) {
    write(repo, `src/m${i}.js`, '');
    write(repo, `src/m${i}.test.js`, '');
    files.push(`src/m${i}.js`);
  }
  const affected = findAffectedTestFiles(repo, files);
  assert.equal(affected.js.length, MAX_TEST_FILES);
});

// --- runScopedTests: real node --test / python3 -m unittest child processes ----------

test('runScopedTests: returns null when no covering test exists for any changed file', () => {
  const repo = tmpRepo();
  write(repo, 'src/orphan.js', 'module.exports = 1;\n');
  assert.equal(runScopedTests(repo, ['src/orphan.js']), null);
});

test('runScopedTests: a real passing JS test reports passed:true', () => {
  const repo = tmpRepo();
  write(repo, 'src/thing.js', 'module.exports = { add: (a, b) => a + b };\n');
  write(repo, 'src/thing.test.js', [
    "const test = require('node:test');",
    "const assert = require('node:assert/strict');",
    "const { add } = require('./thing.js');",
    "test('adds', () => { assert.equal(add(1, 2), 3); });",
  ].join('\n'));
  const result = runScopedTests(repo, ['src/thing.js']);
  assert.equal(result.passed, true);
  assert.deepEqual(result.ran, ['src/thing.test.js']);
  assert.deepEqual(result.failures, []);
});

test('runScopedTests: a real FAILING JS test reports passed:false with the failing test name', () => {
  const repo = tmpRepo();
  // The exact incident shape (change-review-86b45ff): a function's return shape changed
  // but the test's exact-equality assertion was never updated.
  write(repo, 'src/thing.js', "module.exports = { summarize: () => ({ checked: 0, errorDetails: [] }) };\n");
  write(repo, 'src/thing.test.js', [
    "const test = require('node:test');",
    "const assert = require('node:assert/strict');",
    "const { summarize } = require('./thing.js');",
    "test('returns the old shape', () => { assert.deepEqual(summarize(), { checked: 0 }); });",
  ].join('\n'));
  const result = runScopedTests(repo, ['src/thing.js']);
  assert.equal(result.passed, false);
  assert.equal(result.ran.length, 1);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /returns the old shape/);
});

test('runScopedTests: a real passing Python test reports passed:true', () => {
  const repo = tmpRepo();
  write(repo, 'thing.py', 'def add(a, b):\n    return a + b\n');
  write(repo, 'test_thing.py', [
    'import unittest',
    'from thing import add',
    'class T(unittest.TestCase):',
    '    def test_add(self):',
    '        self.assertEqual(add(1, 2), 3)',
  ].join('\n'));
  const result = runScopedTests(repo, ['thing.py']);
  assert.equal(result.passed, true);
  assert.deepEqual(result.ran, ['test_thing.py']);
});

test('runScopedTests: prefers a repo-local .venv interpreter over bare python3 when one exists', () => {
  const repo = tmpRepo();
  // A fake "venv" whose interpreter is really just a shell script proving it (not the
  // system python3) got invoked -- exact shape of the bug this guards: real regression
  // was `python3 -m unittest` picking up a system interpreter that lacks the project's
  // actual dependencies (confirmed live: 100% of python-covering commits false-failed on
  // "No module named 'flask'" because plain `python3` has no access to <repoRoot>/.venv).
  write(repo, '.venv/bin/python', '#!/bin/sh\necho "VENV_PYTHON_RAN"\nexit 0\n');
  fs.chmodSync(path.join(repo, '.venv/bin/python'), 0o755);
  write(repo, 'thing.py', '');
  write(repo, 'test_thing.py', 'raise SystemExit("should never actually be imported by the fake venv script")\n');
  const result = runScopedTests(repo, ['thing.py']);
  assert.equal(result.passed, true, 'the fake venv script exits 0 without ever importing test_thing.py');
});

test('runScopedTests: a real FAILING Python test reports passed:false', () => {
  const repo = tmpRepo();
  write(repo, 'thing.py', 'def add(a, b):\n    return a - b\n');
  write(repo, 'test_thing.py', [
    'import unittest',
    'from thing import add',
    'class T(unittest.TestCase):',
    '    def test_add(self):',
    '        self.assertEqual(add(1, 2), 3)',
  ].join('\n'));
  const result = runScopedTests(repo, ['thing.py']);
  assert.equal(result.passed, false);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /test_add/);
});

test('runScopedTests: mixed JS + Python changed files run both suites and combine the verdict', () => {
  const repo = tmpRepo();
  write(repo, 'src/thing.js', 'module.exports = { ok: () => true };\n');
  write(repo, 'src/thing.test.js', [
    "const test = require('node:test');",
    "const assert = require('node:assert/strict');",
    "const { ok } = require('./thing.js');",
    "test('ok', () => { assert.equal(ok(), true); });",
  ].join('\n'));
  write(repo, 'thing.py', 'def broken():\n    return 1 / 0\n');
  write(repo, 'test_thing.py', [
    'import unittest',
    'from thing import broken',
    'class T(unittest.TestCase):',
    '    def test_broken(self):',
    '        broken()',
  ].join('\n'));
  const result = runScopedTests(repo, ['src/thing.js', 'thing.py']);
  assert.equal(result.passed, false, 'the Python failure must make the combined verdict fail even though JS passed');
  assert.equal(result.ran.length, 2);
});

// --- output parsing -------------------------------------------------------------------

test('parseNodeTestFailures: extracts every "not ok N - <name>" line', () => {
  const out = '# Subtest: a\nnot ok 1 - a\n# Subtest: b\nok 2 - b\nnot ok 3 - c\n';
  assert.deepEqual(parseNodeTestFailures(out), ['a', 'c']);
});

test('parsePyTestFailures: extracts FAIL and ERROR lines', () => {
  const out = 'FAIL: test_a (module.T)\nERROR: test_b (module.T)\nok\n';
  assert.deepEqual(parsePyTestFailures(out), ['test_a (module.T)', 'test_b (module.T)']);
});
