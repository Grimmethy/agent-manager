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
  MAX_REVERSE_DEP_FILES, MAX_TEST_FILES, RUN_TIMEOUT_MS,
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

test('runScopedTests: a test file that times out is inconclusive (null), not a failure', { timeout: RUN_TIMEOUT_MS + 20000 }, () => {
  // Exact shape of a real live bug: src/local-draft.test.js legitimately waits on a real
  // `flock` for up to 600s under GPU-lane contention with the live pipeline -- this gate
  // always runs DURING live pipeline processing, so that contention is the normal case,
  // not an edge case. Confirmed live: a timeout was reported as `passed: false`, which
  // change-review.js's fileDeterministicTestFailureFinding would auto-file as a "high
  // severity confirmed regression" for a file that never actually failed an assertion --
  // it just didn't finish in time. Necessarily slow (waits out the real timeout) since this
  // module intentionally never mocks its own child-process execution -- see file header.
  const repo = tmpRepo();
  write(repo, 'src/thing.js', 'module.exports = {};\n');
  // A promise that never resolves gets caught almost instantly by node's OWN test-runner
  // heuristic ("event loop resolved with nothing left pending") -- not a real timeout, and
  // not the SIGTERM path this test needs to exercise. A real `flock` wait keeps the process
  // genuinely BUSY/alive, which is what actually makes execFileSync's own `timeout` option
  // fire -- reproduced here with a real blocking `sleep` past RUN_TIMEOUT_MS.
  write(repo, 'src/thing.test.js', [
    "const test = require('node:test');",
    "const { execSync } = require('child_process');",
    `test('takes too long', () => { execSync('sleep ${Math.ceil(RUN_TIMEOUT_MS / 1000) + 10}'); });`,
  ].join('\n'));
  const result = runScopedTests(repo, ['src/thing.js']);
  assert.equal(result, null, 'a timeout must degrade to null (inconclusive), the same as no-coverage-exists -- never a hard pass or fail');
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

// 2026-09-23 (change_review backlog incident): the child `node --test` must never inherit the LIVE
// pipeline's write targets -- config.js derives every Docs/*_CANDIDATES.md path from
// AGENT_MANAGER_APPLY_REPO_ROOT, so a covering test that reaches for getConfig() wrote fixtures into the
// real apply clone and blocked ~266 change_review tasks.
function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; process.env[k] = vars[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(vars)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

test('childEnv: live pipeline roots and path overrides are replaced/stripped, unrelated env is kept', () => {
  const { childEnv } = require('./scoped-test-runner.js');
  withEnv({
    AGENT_MANAGER_APPLY_REPO_ROOT: '/live/apply', AGENT_MANAGER_REPO_ROOT: '/live/repo', AGENT_MANAGER_REGISTER_PATH: '/live/register.js',
    AGENT_MANAGER_ARCH_CANDIDATES_PATH: '/live/Docs/ARCH.md', AGENT_MANAGER_CHANGE_REVIEW_CURSOR_PATH: '/live/cursor.json',
    NODE_TEST_CONTEXT: 'child-v8', KEEP_ME: 'yes',
  }, () => {
    const env = childEnv('/sandbox');
    assert.equal(env.AGENT_MANAGER_APPLY_REPO_ROOT, '/sandbox');
    assert.equal(env.AGENT_MANAGER_REPO_ROOT, '/sandbox');
    assert.equal(env.AGENT_MANAGER_REGISTER_PATH, undefined);
    assert.equal(env.AGENT_MANAGER_ARCH_CANDIDATES_PATH, undefined);
    assert.equal(env.AGENT_MANAGER_CHANGE_REVIEW_CURSOR_PATH, undefined);
    assert.equal(env.NODE_TEST_CONTEXT, undefined);
    assert.equal(env.KEEP_ME, 'yes');
  });
});

test('runScopedTests: a real covering test run under a live-looking env sees a throwaway sandbox, never the live roots', () => {
  const repo = tmpRepo();
  write(repo, 'src/thing.js', 'module.exports = 1;\n');
  write(repo, 'src/thing.test.js', [
    "const test = require('node:test');",
    "const assert = require('node:assert/strict');",
    "const os = require('os');",
    "test('env is sandboxed', () => {",
    "  for (const k of ['AGENT_MANAGER_APPLY_REPO_ROOT', 'AGENT_MANAGER_REPO_ROOT']) {",
    "    assert.ok(process.env[k].startsWith(os.tmpdir()), k + ' must be a sandbox, got ' + process.env[k]);",
    "    assert.notEqual(process.env[k], '/live/apply');",
    "  }",
    "  assert.equal(process.env.AGENT_MANAGER_REGISTER_PATH, undefined);",
    "});",
  ].join('\n'));
  withEnv({ AGENT_MANAGER_APPLY_REPO_ROOT: '/live/apply', AGENT_MANAGER_REPO_ROOT: '/live/repo', AGENT_MANAGER_REGISTER_PATH: '/live/register.js' }, () => {
    const result = runScopedTests(repo, ['src/thing.js']);
    assert.equal(result.passed, true, result.raw || JSON.stringify(result));
  });
});

// --- vitest packages (2026-10-08) ------------------------------------------------------------------------------------------------------------------------------
// change_review runs runScopedTests over merged commits. `node --test` cannot execute a .tsx, so a commit touching a component with a vitest test would have
// auto-filed a false "confirmed regression". The runner now comes from the package that owns the test file.
{
  const fs2 = require('node:fs');
  const os2 = require('node:os');
  const path2 = require('node:path');
  const test2 = require('node:test');
  const assert2 = require('node:assert/strict');
  const { runJsTests } = require('./scoped-test-runner.js');

  // A repo with a vitest package whose "vitest.mjs" is a stub: it exits with the code in STUB_EXIT.mjs's text and prints a FAIL line when it fails.
  const mk = ({ installed = true, fail = false } = {}) => {
    const dir = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'sc-vitest-'));
    const put = (rel, text) => { fs2.mkdirSync(path2.dirname(path2.join(dir, rel)), { recursive: true }); fs2.writeFileSync(path2.join(dir, rel), text); };
    put('web/package.json', JSON.stringify({ devDependencies: { vitest: '^3.2.7' } }));
    put('web/src/A.test.tsx', 'x');
    put('plain.test.js', "const test = require('node:test'); test('ok', () => {});\n");
    put('package.json', '{}');
    if (installed) put('web/node_modules/vitest/vitest.mjs', fail
      ? "console.log(' FAIL  ' + process.argv.slice(2).filter((a) => a.endsWith('.tsx'))[0] + ' > A > breaks'); process.exit(1);"
      : 'process.exit(0);');
    return dir;
  };

  test2('runJsTests: a .tsx test goes to vitest from its package (pass), and a plain .js test still goes to node --test', () => {
    const dir = mk();
    const r = runJsTests(dir, ['web/src/A.test.tsx', 'plain.test.js']);
    assert2.equal(r.passed, true);
    assert2.deepEqual([...r.ran].sort(), ['plain.test.js', 'web/src/A.test.tsx']);
  });

  test2('runJsTests: a failing vitest test is a real failure with its name; a package without installed node_modules is INCONCLUSIVE, never a regression', () => {
    const failing = runJsTests(mk({ fail: true }), ['web/src/A.test.tsx']);
    assert2.equal(failing.passed, false);
    assert2.deepEqual(failing.failures, ['src/A.test.tsx > A > breaks']);
    const missing = runJsTests(mk({ installed: false }), ['web/src/A.test.tsx']);
    assert2.equal(missing.passed, null);
    assert2.match(missing.raw, /vitest is not installed for web \(run npm ci there\)/);
  });

  test2('runJsTests: when one package fails and another is inconclusive the combined verdict is false (a real failure always wins), and inconclusive + pass is null', () => {
    const dir = mk({ fail: true });
    const put = (rel, text) => { fs2.mkdirSync(path2.dirname(path2.join(dir, rel)), { recursive: true }); fs2.writeFileSync(path2.join(dir, rel), text); };
    put('web2/package.json', JSON.stringify({ devDependencies: { vitest: '^3.2.7' } }));      // declares vitest but has no node_modules: inconclusive
    put('web2/src/B.test.tsx', 'x');
    assert2.equal(runJsTests(dir, ['web/src/A.test.tsx', 'web2/src/B.test.tsx']).passed, false);
    const ok = mk();
    fs2.mkdirSync(path2.join(ok, 'web2', 'src'), { recursive: true });
    fs2.writeFileSync(path2.join(ok, 'web2', 'package.json'), JSON.stringify({ devDependencies: { vitest: '^3.2.7' } }));
    fs2.writeFileSync(path2.join(ok, 'web2', 'src', 'B.test.tsx'), 'x');
    assert2.equal(runJsTests(ok, ['web/src/A.test.tsx', 'web2/src/B.test.tsx']).passed, null);
  });

  test2('runJsTests: a .tsx test in a package with no runner is not run at all (no evidence either way), and mixed results combine false > null > true', () => {
    const dir = mk();
    fs2.writeFileSync(path2.join(dir, 'web', 'package.json'), '{}');
    assert2.equal(runJsTests(dir, ['web/src/A.test.tsx']), null, 'nothing runnable -> no verdict');
    const both = runJsTests(mk({ fail: true }), ['web/src/A.test.tsx', 'plain.test.js']);
    assert2.equal(both.passed, false, 'a failing suite wins over a passing one');
    assert2.deepEqual(both.failures, ['src/A.test.tsx > A > breaks']);
  });
}
