'use strict';

// Tests for review-verify.js (executed verification for the review step). Run: node --test src/review-verify.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { splitCoveringTiers, resolveTestTimeoutMs, DEFAULT_TEST_TIMEOUT_MS, TEST_TIMEOUT_MS } = require('./review-verify.js');
const { addedTestNames, verifyDiff, extractChangedFiles, extractRunnableCommands, classifyCommand, tokenize, worktreePaths, extractChangedSymbols, findSymbolCoveringTests, findTestsWithSymbolFallback, relinkExternalDependencies, sandboxUnresolvedDependency } = require('./review-verify.js');
const { wrapWithSandbox } = require('./sandbox.js');

const DIFF = 'diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n-x\n+y\ndiff --git a/src/a.test.js b/src/a.test.js\nnew file mode 100644\n--- /dev/null\n+++ b/src/a.test.js\n@@ -0,0 +1 @@\n+z\n';

test('extractChangedFiles reads the b-side path of every file header, once', () => {
  assert.deepEqual(extractChangedFiles(DIFF), ['src/a.js', 'src/a.test.js']);
  assert.deepEqual(extractChangedFiles(''), []);
});

test('tokenize honours quotes and rejects shell metacharacters outside them', () => {
  assert.deepEqual(tokenize('node --test src/a.test.js'), ['node', '--test', 'src/a.test.js']);
  assert.deepEqual(tokenize('python -m unittest discover -p "test_*.py"'), ['python', '-m', 'unittest', 'discover', '-p', 'test_*.py']);
  for (const bad of ['node --test a.js | tee x', 'a && b', 'a; b', 'a > out', 'echo $HOME', 'a `b`', '(a)', "x 'unterminated"]) assert.equal(tokenize(bad), null, bad);
});

test('classifyCommand allows only node --test/--check and python -m unittest/py_compile with repo-relative paths', () => {
  assert.deepEqual(classifyCommand(tokenize('node --test src/a.test.js')), { bin: 'node', args: ['--test', 'src/a.test.js'] });
  assert.deepEqual(classifyCommand(tokenize('node --check python/x/y.js')), { bin: 'node', args: ['--check', 'python/x/y.js'] });
  assert.deepEqual(classifyCommand(tokenize('python3 -m unittest -v python.dashboard.test_a')), { bin: 'python', args: ['-m', 'unittest', '-v', 'python.dashboard.test_a'] });
  assert.deepEqual(classifyCommand(tokenize('python -m unittest discover -s python/dashboard -p "test_*.py"')), { bin: 'python', args: ['-m', 'unittest', 'discover', '-s', 'python/dashboard', '-p', 'test_*.py'] });
  assert.deepEqual(classifyCommand(tokenize('python -m py_compile python/x.py python/y.py')), { bin: 'python', args: ['-m', 'py_compile', 'python/x.py', 'python/y.py'] });
  const denied = [
    'grep -n foo src/a.js',                 // PASS often means "no matches" (exit 1) -- not exit-0 semantics
    'git diff --numstat', 'rm -rf x', 'curl http://x', 'bash -c "node --test a.js"', 'npm test', 'node script.js',
    'node --test /etc/passwd', 'node --test ../outside.test.js', 'node --test -x.js', 'node --test',
    'python -c "print(1)"', 'python -m pip install x', 'python -m http.server', 'python -m unittest ../evil',
    'python -m unittest discover -s /abs/path', 'python -m py_compile /abs.py',
  ];
  for (const cmd of denied) assert.equal(classifyCommand(tokenize(cmd)), null, cmd);
});

test('extractRunnableCommands pulls every allowlisted backticked command out of a check line and ignores the rest', () => {
  const check = 'ran `python -m py_compile a.py` then `python -m unittest x.y` and `grep -c foo a.py` and `git diff --numstat`';
  const cmds = extractRunnableCommands(check);
  assert.deepEqual(cmds.map((c) => c.text), ['python -m py_compile a.py', 'python -m unittest x.y']);
  assert.deepEqual(extractRunnableCommands('direct read of lines 10-20'), []);
});

test('worktreePaths never collides with the draft stage worktree for the same task id', () => {
  const { agenticWorktreePaths } = require('./agentic-draft-common.js');
  assert.notEqual(worktreePaths('t1').worktreeDir, agenticWorktreePaths('t1').worktreeDir);
  assert.notEqual(worktreePaths('t1').branchName, agenticWorktreePaths('t1').branchName);
});

// --- verifyDiff, engine dependencies injected ---------------------------------------------------------
function fakeDeps(over = {}) {
  const calls = { cleanup: 0, run: [] };
  return {
    calls,
    deps: {
      prepare: baseTree(['src/a.js', 'src/a.test.js']),
      applyDiff: () => ({ applied: true }),
      unapplyDiff: () => ({ applied: true }),
      cleanup: () => { calls.cleanup += 1; fs.rmSync(worktreePaths('t1').worktreeDir, { recursive: true, force: true }); },
      findTests: () => ({ js: [], py: [] }),
      run: (a) => { calls.run.push(a); return { ran: true, exitCode: 0, timedOut: false, output: '' }; },
      // The changed-file syntax step has its own runner so these legacy cases (which script and count `run` calls for the tests) stay unaffected.
      syntaxRun: () => ({ ran: true, exitCode: 0, timedOut: false, output: '' }),
      ...over,
    },
  };
}
const AR = (check, pass = true) => [{ criterion: 'c', check, result: pass ? 'PASS' : 'FAIL', pass }];
const base = { taskId: 't1', rawDiff: DIFF, repoRoot: '/repo', mainBranch: 'master' };

test('empty diff and unavailable worktree are inconclusive, and cleanup only runs after a worktree was prepared', () => {
  let f = fakeDeps();
  assert.equal(verifyDiff({ ...base, rawDiff: '  ', deps: f.deps }).status, 'inconclusive');
  assert.equal(f.calls.cleanup, 0);
  f = fakeDeps({ prepare: () => ({ ok: false, reason: 'fetch failed' }) });
  const r = verifyDiff({ ...base, deps: f.deps });
  assert.equal(r.status, 'inconclusive');
  assert.match(r.reasons[0], /fetch failed/);
  assert.equal(f.calls.cleanup, 1);
});

test('a diff that does not apply (unmet dependency slice) is inconclusive, not failed', () => {
  const f = fakeDeps({ applyDiff: () => ({ applied: false, reason: 'patch does not apply' }) });
  const r = verifyDiff({ ...base, deps: f.deps });
  assert.equal(r.status, 'inconclusive');
  assert.match(r.reasons[0], /depends on an unmerged earlier one/);
  assert.equal(f.calls.run.length, 0);
  assert.equal(f.calls.cleanup, 1);
});

test('a claimed-PASS command that really exits non-zero is contradicted and the result is failed', () => {
  const f = fakeDeps({ run: scriptedRun([{ exitCode: 1, output: 'AssertionError' }, passing]) });   // fails with the diff, passes on the base
  const r = verifyDiff({ ...base, acceptanceResults: AR('`node --test src/a.test.js`'), deps: f.deps });
  assert.equal(r.status, 'failed');
  assert.equal(r.commands[0].outcome, 'contradicted');
  assert.match(r.reasons[0], /exited 1 but the draft claimed PASS/);
});

test('a claimed-PASS command that exits 0 is confirmed and the result is passed', () => {
  const f = fakeDeps();
  const r = verifyDiff({ ...base, acceptanceResults: AR('`node --test src/a.test.js`'), deps: f.deps });
  assert.equal(r.status, 'passed');
  assert.equal(r.commands[0].outcome, 'confirmed');
});

test('a command the draft honestly claimed FAIL that does fail is consistent, not a contradiction', () => {
  const f = fakeDeps({ run: () => ({ ran: true, exitCode: 1, timedOut: false, output: '' }) });
  const r = verifyDiff({ ...base, acceptanceResults: AR('`node --test src/a.test.js`', false), deps: f.deps });
  assert.equal(r.commands[0].outcome, 'confirmed-fail');
  assert.notEqual(r.status, 'failed');
});

test('a timeout is inconclusive even when the draft claimed PASS (PR #454 rule)', () => {
  const f = fakeDeps({ run: () => ({ ran: true, exitCode: null, timedOut: true, output: '' }) });
  const r = verifyDiff({ ...base, acceptanceResults: AR('`node --test src/a.test.js`'), deps: f.deps });
  assert.equal(r.status, 'inconclusive');
  assert.equal(r.commands[0].outcome, 'inconclusive');
});

test('the covering-test timeout fits a ~3 min suite by default and AGENT_MANAGER_REVIEW_TEST_TIMEOUT_MS overrides it', () => {
  assert.ok(DEFAULT_TEST_TIMEOUT_MS >= 200000, 'default must exceed the slowest covering suite (local-draft.test.js ~3 min)');
  assert.equal(TEST_TIMEOUT_MS, resolveTestTimeoutMs({}));
  assert.equal(resolveTestTimeoutMs({}), DEFAULT_TEST_TIMEOUT_MS);
  assert.equal(resolveTestTimeoutMs({ AGENT_MANAGER_REVIEW_TEST_TIMEOUT_MS: '45000' }), 45000);
  assert.equal(resolveTestTimeoutMs({ AGENT_MANAGER_REVIEW_TEST_TIMEOUT_MS: 'junk' }), DEFAULT_TEST_TIMEOUT_MS);
  assert.equal(resolveTestTimeoutMs({ AGENT_MANAGER_REVIEW_TEST_TIMEOUT_MS: '0' }), DEFAULT_TEST_TIMEOUT_MS);
});

test('a covering-suite timeout is inconclusive and names the unverified files', () => {
  const f = fakeDeps({
    findTests: () => ({ js: ['src/a.test.js', 'src/b.test.js'], py: [] }),   // neither is changed/co-located by the diff, so both stay primary
    run: () => ({ ran: true, exitCode: null, timedOut: true, output: '' }),
    prepare: baseTree(['src/a.js', 'src/a.test.js', 'src/b.test.js']),
  });
  const r = verifyDiff({ ...base, rawDiff: 'diff --git a/src/other.js b/src/other.js\n--- a/src/other.js\n+++ b/src/other.js\n@@ -1 +1 @@\n-x\n+y\n', deps: f.deps });
  assert.equal(r.status, 'inconclusive');
  assert.deepEqual(r.tests.timedOutFiles, ['src/a.test.js', 'src/b.test.js']);
  assert.match(r.reasons.join(' '), /2 file\(s\) unverified.*src\/a\.test\.js, src\/b\.test\.js/);
});

test('covering tests that fail make the result failed and carry the parsed failure names', () => {
  const f = fakeDeps({
    findTests: () => ({ js: ['src/a.test.js'], py: [] }),
    run: scriptedRun([{ exitCode: 1, output: 'not ok 1 - the thing breaks\n' }, passing]),   // fails with the diff, passes on the base
  });
  const r = verifyDiff({ ...base, deps: f.deps });
  assert.equal(r.status, 'failed');
  assert.equal(r.tests.passed, false);
  assert.deepEqual(r.tests.failures, ['the thing breaks']);
});

test('covering tests that pass count as evidence; nothing runnable at all is inconclusive', () => {
  let f = fakeDeps({ findTests: () => ({ js: ['src/a.test.js'], py: [] }) });
  assert.equal(verifyDiff({ ...base, deps: f.deps }).status, 'passed');
  f = fakeDeps();
  const r = verifyDiff({ ...base, acceptanceResults: AR('`grep -c foo src/a.js`'), deps: f.deps });
  assert.equal(r.status, 'inconclusive');
  assert.match(r.reasons[0], /no covering tests and no runnable acceptance commands/);
  assert.equal(f.calls.run.length, 0, 'grep is not on the allowlist so it must never run');
});

test('when the sandbox is unavailable nothing is executed and the result is inconclusive, never an unsandboxed run', () => {
  const f = fakeDeps({ run: () => ({ ran: false, reason: 'bwrap sandbox unavailable' }) });
  const r = verifyDiff({ ...base, acceptanceResults: AR('`node --test src/a.test.js`'), deps: f.deps });
  assert.equal(r.status, 'inconclusive');
  assert.match(r.reasons[0], /sandbox is unavailable/);
});

test('an exception inside verification is inconclusive and still cleans up', () => {
  const f = fakeDeps({ applyDiff: () => { throw new Error('disk full'); } });
  const r = verifyDiff({ ...base, deps: f.deps });
  assert.equal(r.status, 'inconclusive');
  assert.match(r.reasons[0], /disk full/);
  assert.equal(f.calls.cleanup, 1);
});

// --- real integration: real git worktree + real bwrap sandbox ------------------------------------------
const HAVE_BWRAP = wrapWithSandbox('true', [], { workDir: '/tmp', readOnlyBinds: [], writableBinds: [], env: {} }).available;

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-verify-int-'));
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  const git = (args, cwd) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '--bare', '-b', 'master', origin], root);
  git(['clone', origin, work], root);
  git(['checkout', '-b', 'master'], work);
  fs.mkdirSync(path.join(work, 'src'));
  fs.writeFileSync(path.join(work, 'src', 'add.js'), 'module.exports = (a, b) => a + b;\n');
  fs.writeFileSync(path.join(work, '.gitignore'), 'node_modules/\n');
  git(['add', '-A'], work);
  git(['commit', '-m', 'base'], work);
  git(['push', 'origin', 'master'], work);
  return { root, work, git };
}

function diffAddingTest(work, git, body) {
  fs.writeFileSync(path.join(work, 'src', 'add.test.js'), body);
  git(['add', '-A'], work);
  const diff = git(['diff', '--cached', '--full-index', '--binary'], work);
  git(['reset', '-q'], work);
  fs.rmSync(path.join(work, 'src', 'add.test.js'));
  return diff;
}

const PASSING = "const test = require('node:test'); const assert = require('node:assert/strict'); const add = require('./add.js');\ntest('adds', () => assert.equal(add(1, 2), 3));\n";
const FAILING = PASSING.replace('3)', '4)');

test('integration: a real diff with a passing covering test verifies as passed inside the sandbox', { skip: !HAVE_BWRAP }, () => {
  const { root, work, git } = makeRepo();
  try {
    const r = verifyDiff({ taskId: 'int-pass', rawDiff: diffAddingTest(work, git, PASSING), repoRoot: work, mainBranch: 'master',
      acceptanceResults: AR('`node --test src/add.test.js`') });
    assert.equal(r.status, 'passed', JSON.stringify(r));
    assert.equal(r.tests.passed, true);
    assert.equal(r.commands[0].outcome, 'confirmed');
    assert.equal(fs.existsSync(worktreePaths('int-pass').worktreeDir), false, 'scratch worktree removed');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('integration: a real failing covering test is caught, and a draft that claimed PASS is contradicted', { skip: !HAVE_BWRAP }, () => {
  const { root, work, git } = makeRepo();
  try {
    const r = verifyDiff({ taskId: 'int-fail', rawDiff: diffAddingTest(work, git, FAILING), repoRoot: work, mainBranch: 'master',
      acceptanceResults: AR('`node --test src/add.test.js`') });
    assert.equal(r.status, 'failed', JSON.stringify(r));
    assert.equal(r.tests.passed, false);
    assert.equal(r.commands[0].outcome, 'contradicted');
    assert.equal(fs.existsSync(worktreePaths('int-fail').worktreeDir), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('integration: a diff that does not apply to the base is inconclusive', { skip: !HAVE_BWRAP }, () => {
  const { root, work, git } = makeRepo();
  try {
    const bad = 'diff --git a/src/missing.js b/src/missing.js\n--- a/src/missing.js\n+++ b/src/missing.js\n@@ -1 +1 @@\n-nope\n+yes\n';
    const r = verifyDiff({ taskId: 'int-noapply', rawDiff: bad, repoRoot: work, mainBranch: 'master' });
    assert.equal(r.status, 'inconclusive');
    assert.equal(r.apply.applied, false);
    void git;
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('integration: the sandbox contains the diff\'s own tests -- a test that writes into the main checkout cannot', { skip: !HAVE_BWRAP }, () => {
  const { root, work, git } = makeRepo();
  try {
    const target = path.join(work, 'PWNED.txt');
    const evil = `const test = require('node:test'); const fs = require('fs');\ntest('escape', () => { try { fs.writeFileSync(${JSON.stringify(target)}, 'x'); } catch (e) { /* contained */ } });\n`;
    const r = verifyDiff({ taskId: 'int-contain', rawDiff: diffAddingTest(work, git, evil), repoRoot: work, mainBranch: 'master',
      acceptanceResults: AR('`node --test src/add.test.js`') });
    assert.equal(fs.existsSync(target), false, 'the main checkout must not be writable from inside the sandbox');
    assert.ok(['passed', 'failed', 'inconclusive'].includes(r.status));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- covering tests by changed symbol (python/dashboard has no <name>.test.js / test_<name>.py convention) ---------
test('extractChangedSymbols reads added/removed declarations and the function named in a hunk header', () => {
  const diff = [
    'diff --git a/python/dashboard/app.py b/python/dashboard/app.py', '--- a/python/dashboard/app.py', '+++ b/python/dashboard/app.py',
    '@@ -10,3 +10,4 @@ def _existing_helper(x):', ' unchanged', '+    y = 1',
    '@@ -40,2 +41,9 @@', '+def _build_pipeline_env(raw_path):', '+    return {}', '-async function oldJsThing(a) {',
    '+const arrowHelper = async (a, b) => a + b;', '+class WidgetRegistry:', '+def run():', '+function main() {',
    '+def _build_pipeline_env(again):',
    '@@ -90,2 +99,2 @@', ' def context_only_function():', '-    return 1', '+    return 2',
  ].join('\n');
  assert.deepEqual(extractChangedSymbols(diff).sort(), ['WidgetRegistry', '_build_pipeline_env', '_existing_helper', 'arrowHelper', 'context_only_function', 'oldJsThing'].sort());
  assert.deepEqual(extractChangedSymbols(''), []);
  assert.deepEqual(extractChangedSymbols('+++ b/x.py\n--- a/x.py\n'), []);
});

function makeDashTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-verify-sym-'));
  const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  w('python/dashboard/app.py', 'def _build_pipeline_env():\n    return 1\n');
  w('python/dashboard/routes/x.py', 'def api_thing():\n    return 1\n');
  w('python/dashboard/test_alpha.py', 'from app import _build_pipeline_env\n_build_pipeline_env()\n');
  w('python/dashboard/test_beta.py', '_build_pipeline_env_extra()\nxx_build_pipeline_env()\n');   // only look-alikes: must NOT match
  w('python/dashboard/test_gamma.py', 'unrelated()\n');
  w('python/dashboard/test_delta.py', '_build_pipeline_env()\n');
  w('python/dashboard/test_zeta.py', '_build_pipeline_env()\napi_thing()\n');   // mentions BOTH symbols but sorts last alphabetically
  return root;
}

test('findSymbolCoveringTests matches whole identifiers only, ranks by distinct symbols, and looks in the file\'s directory and its parent', () => {
  const root = makeDashTree();
  try {
    let r = findSymbolCoveringTests(root, ['python/dashboard/app.py'], ['_build_pipeline_env']);
    assert.deepEqual(r.py, ['python/dashboard/test_alpha.py', 'python/dashboard/test_delta.py', 'python/dashboard/test_zeta.py']);
    assert.deepEqual(r.js, []);
    r = findSymbolCoveringTests(root, ['python/dashboard/routes/x.py'], ['_build_pipeline_env', 'api_thing']);
    assert.equal(r.py[0], 'python/dashboard/test_zeta.py', 'the file mentioning both symbols ranks first even though it sorts last alphabetically');   // parent dir searched
    // a test file the diff itself changes is left to the primary finder, never listed again here
    r = findSymbolCoveringTests(root, ['python/dashboard/app.py', 'python/dashboard/test_alpha.py'], ['_build_pipeline_env']);
    assert.ok(!r.py.includes('python/dashboard/test_alpha.py'));
    assert.deepEqual(findSymbolCoveringTests(root, ['python/dashboard/app.py'], []), { js: [], py: [] });
    assert.deepEqual(findSymbolCoveringTests(root, ['python/dashboard/app.py'], ['nothing_mentions_this']), { js: [], py: [] });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('findTestsWithSymbolFallback prefers the file-name based finder and only falls back when it finds nothing', () => {
  const root = makeDashTree();
  try {
    const diff = '@@ -1,2 +1,2 @@ def _build_pipeline_env():\n-    return 1\n+    return 2\n';
    assert.deepEqual(findTestsWithSymbolFallback(root, ['python/dashboard/app.py'], diff).py, ['python/dashboard/test_alpha.py', 'python/dashboard/test_delta.py', 'python/dashboard/test_zeta.py']);
    fs.writeFileSync(path.join(root, 'python/dashboard/test_app.py'), 'pass\n');     // now a co-located test exists
    assert.deepEqual(findTestsWithSymbolFallback(root, ['python/dashboard/app.py'], diff).py, ['python/dashboard/test_app.py']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const PY3 = ['/usr/bin/python3', '/usr/local/bin/python3'].find((p) => fs.existsSync(p));

function makePyRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-verify-py-'));
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  const git = (args, cwd) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '--bare', '-b', 'master', origin], root);
  git(['clone', origin, work], root);
  git(['checkout', '-b', 'master'], work);
  fs.mkdirSync(path.join(work, 'dash'), { recursive: true });
  fs.writeFileSync(path.join(work, 'dash', 'app.py'), 'def compute_total():\n    return 1\n');
  fs.writeFileSync(path.join(work, 'dash', 'test_feature.py'), 'import unittest\nfrom dash.app import compute_total\n\n\nclass T(unittest.TestCase):\n    def test_total(self):\n        self.assertEqual(compute_total(), 1)\n');
  fs.writeFileSync(path.join(work, 'dash', '__init__.py'), '');
  git(['add', '-A'], work);
  git(['commit', '-m', 'base'], work);
  git(['push', 'origin', 'master'], work);
  const changeTo = (v) => {
    fs.writeFileSync(path.join(work, 'dash', 'app.py'), `def compute_total():\n    return ${v}\n`);
    const d = git(['diff', '--full-index', '--binary'], work);
    git(['checkout', '--', '.'], work);
    return d;
  };
  return { root, work, changeTo };
}

test('integration: a dashboard-style Python change with no co-located test is verified by the test that mentions its function', { skip: !HAVE_BWRAP || !PY3 }, () => {
  const { root, work, changeTo } = makePyRepo();
  try {
    const bad = verifyDiff({ taskId: 'int-sym-fail', rawDiff: changeTo(2), repoRoot: work, mainBranch: 'master', pythonBin: PY3 });
    assert.equal(bad.status, 'failed', JSON.stringify(bad));
    assert.deepEqual(bad.tests.ran, ['dash/test_feature.py']);
    assert.equal(bad.tests.passed, false);
    const good = verifyDiff({ taskId: 'int-sym-pass', rawDiff: changeTo('1  # same value, new comment'), repoRoot: work, mainBranch: 'master', pythonBin: PY3 });
    assert.equal(good.status, 'passed', JSON.stringify(good));
    assert.deepEqual(good.tests.ran, ['dash/test_feature.py']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- differential check: a failure counts against the diff only if the same check passes on the base ----------------------------------------
// fake `prepare` builds a real (temp) worktree dir holding the BASE tree, so the engine's "does this test file exist on the base" check is real.
function baseTree(files) {
  return () => {
    const dir = worktreePaths('t1').worktreeDir;
    fs.rmSync(dir, { recursive: true, force: true });
    for (const f of files) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), '// base\n'); }
    return { ok: true };
  };
}
function scriptedRun(results) {   // returns the next scripted result per call, in order
  const calls = [];
  const fn = (a) => { calls.push(a); const r = results[Math.min(calls.length - 1, results.length - 1)]; return { ran: true, timedOut: false, output: '', ...r }; };
  fn.calls = calls;
  return fn;
}
const failing = (...names) => ({ exitCode: 1, output: names.map((n, i) => `not ok ${i + 1} - ${n}\n`).join('') });
const passing = { exitCode: 0 };
function diffDeps(over) {
  const f = fakeDeps({ findTests: () => ({ js: ['src/a.test.js'], py: [] }), prepare: baseTree(['src/a.test.js', 'src/a.js']), ...over });
  const inner = f.deps.cleanup;
  f.deps.cleanup = (...a) => { inner(...a); fs.rmSync(worktreePaths('t1').worktreeDir, { recursive: true, force: true }); };
  return f;
}

test('differential: a suite that fails with the diff but passes on the base is a real failure, and only then', () => {
  const run = scriptedRun([failing('the helper adds'), passing]);
  const f = diffDeps({ run });
  const r = verifyDiff({ ...base, deps: f.deps });
  assert.equal(r.status, 'failed');
  assert.deepEqual(r.tests.failures, ['the helper adds']);
  assert.equal(run.calls.length, 2, 'one run with the diff, one control run on the base');
});

test('differential: tests that ALSO fail on the base (same names) are inconclusive, never a block', () => {
  const f = diffDeps({ run: scriptedRun([failing('needs a writable HOME', 'needs the log dir'), failing('needs a writable HOME', 'needs the log dir')]) });
  const r = verifyDiff({ ...base, deps: f.deps });
  assert.equal(r.status, 'inconclusive');
  assert.deepEqual(r.tests.preexisting, ['needs a writable HOME', 'needs the log dir']);
  assert.equal(r.tests.passed, null);
  assert.match(r.reasons[0], /already fail on master in the review sandbox, so the failure is not caused by the diff/);
});

test('differential: only the failures the diff ADDS count; ones already failing on the base are listed as preexisting', () => {
  const f = diffDeps({ run: scriptedRun([failing('old env failure', 'new regression'), failing('old env failure')]) });
  const r = verifyDiff({ ...base, deps: f.deps });
  assert.equal(r.status, 'failed');
  assert.deepEqual(r.tests.failures, ['new regression']);
  assert.deepEqual(r.tests.preexisting, ['old env failure']);
});

test('differential: a base run that fails with no nameable test (import or environment error) or times out is inconclusive', () => {
  for (const baseRun of [{ exitCode: 1, output: 'Traceback (most recent call last): ... ImportError' }, { exitCode: null, timedOut: true }]) {
    const f = diffDeps({ run: scriptedRun([failing('x'), baseRun]) });
    const r = verifyDiff({ ...base, deps: f.deps });
    assert.equal(r.status, 'inconclusive', JSON.stringify(baseRun));
  }
});

test('differential: a failing test file that exists only in the diff has no base to compare with, so the failure stands without a control run', () => {
  const run = scriptedRun([failing('brand new test fails')]);
  const f = diffDeps({ prepare: baseTree(['src/a.js']), run });   // src/a.test.js is NOT on the base
  const r = verifyDiff({ ...base, deps: f.deps });
  assert.equal(r.status, 'failed');
  assert.equal(run.calls.length, 1);
});

test('differential: a contradicted claim is a failure only if the same command passes on the base', () => {
  const claim = AR('`node --test src/a.test.js`');
  let f = diffDeps({ findTests: () => ({ js: [], py: [] }), run: scriptedRun([{ exitCode: 1 }, passing]) });
  let r = verifyDiff({ ...base, acceptanceResults: claim, deps: f.deps });
  assert.equal(r.status, 'failed');
  assert.equal(r.commands[0].outcome, 'contradicted');
  f = diffDeps({ findTests: () => ({ js: [], py: [] }), run: scriptedRun([{ exitCode: 1 }, { exitCode: 1 }]) });
  r = verifyDiff({ ...base, acceptanceResults: claim, deps: f.deps });
  assert.equal(r.status, 'inconclusive');
  assert.equal(r.commands[0].outcome, 'inconclusive');
  assert.match(r.reasons[0], /also fails on master in the review sandbox/);
  const run = scriptedRun([{ exitCode: 1 }]);
  const tree = () => worktreePaths('t1').worktreeDir;
  f = diffDeps({ findTests: () => ({ js: [], py: [] }), prepare: baseTree(['src/a.js']), run,
    applyDiff: () => { fs.writeFileSync(path.join(tree(), 'src/a.test.js'), '// added by the diff\n'); return { applied: true }; },
    unapplyDiff: () => { fs.rmSync(path.join(tree(), 'src/a.test.js'), { force: true }); return { applied: true }; } });   // the claimed test file only exists in the diff
  r = verifyDiff({ ...base, acceptanceResults: claim, deps: f.deps });
  assert.equal(r.status, 'failed');
  assert.equal(run.calls.length, 1, 'no control run for a command whose target the base does not have');
});

test('differential: when the diff cannot be reversed the failure cannot be attributed, so it is inconclusive', () => {
  const f = diffDeps({ run: scriptedRun([failing('x')]), unapplyDiff: () => ({ applied: false, reason: 'patch does not reverse' }) });
  const r = verifyDiff({ ...base, deps: f.deps });
  assert.equal(r.status, 'inconclusive');
  assert.match(r.reasons[0], /could not be reversed/);
});

test('differential: an all-green run never reverses the diff or runs a control', () => {
  let reversed = 0;
  const run = scriptedRun([passing]);
  const f = diffDeps({ run, unapplyDiff: () => { reversed += 1; return { applied: true }; } });
  const r = verifyDiff({ ...base, deps: f.deps });
  assert.equal(r.status, 'passed');
  assert.equal(reversed, 0);
  assert.equal(run.calls.length, 1);
});

test('unapplyPartialDiff restores the exact base state and refuses an empty diff', () => {
  const { unapplyPartialDiff } = require('./review-verify.js');
  const { applyPartialDiff } = require('./agentic-draft-common.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-verify-unapply-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    fs.writeFileSync(path.join(dir, 'f.txt'), 'one\ntwo\n');
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'], { cwd: dir });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'f.txt'), 'one\nTWO\nthree\n');
    fs.writeFileSync(path.join(dir, 'new.txt'), 'brand new\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    const diff = execFileSync('git', ['diff', '--cached', '--full-index', '--binary'], { cwd: dir, encoding: 'utf8' });
    execFileSync('git', ['reset', '-q', '--hard'], { cwd: dir });
    assert.equal(applyPartialDiff(dir, diff).applied, true);
    assert.equal(fs.readFileSync(path.join(dir, 'f.txt'), 'utf8'), 'one\nTWO\nthree\n');
    assert.deepEqual(unapplyPartialDiff(dir, diff), { applied: true });
    assert.equal(fs.readFileSync(path.join(dir, 'f.txt'), 'utf8'), 'one\ntwo\n');
    assert.equal(fs.existsSync(path.join(dir, 'new.txt')), false);
    assert.equal(unapplyPartialDiff(dir, '  ').applied, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// real bwrap: the HUB0068-02 incident. A base test that needs the real HOME fails in the sandbox with or without the diff.
test('integration: a test that already fails on the base inside the sandbox does not block a harmless diff, but a regression the diff adds still does', { skip: !HAVE_BWRAP }, () => {
  const { root, work, git } = makeRepo();
  try {
    const envTest = "const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('fs'); const path = require('path');\n" +
      "test('needs the real HOME state dir', () => assert.ok(fs.existsSync(path.join(process.env.HOME, '.local', 'state', 'agent-manager'))));\n" +
      "test('adds', () => assert.equal(require('./add.js')(1, 2), 3));\n";
    fs.writeFileSync(path.join(work, 'src', 'add.test.js'), envTest);
    git(['add', '-A'], work); git(['commit', '-m', 'add tests'], work); git(['push', 'origin', 'master'], work);
    // harmless diff: a comment; the env test still fails, but it fails on the base too
    fs.writeFileSync(path.join(work, 'src', 'add.js'), 'module.exports = (a, b) => a + b; // harmless\n');
    const harmless = git(['diff', '--full-index', '--binary'], work); git(['checkout', '--', '.'], work);
    const ok = verifyDiff({ taskId: 'int-diff-env', rawDiff: harmless, repoRoot: work, mainBranch: 'master' });
    assert.equal(ok.status, 'inconclusive', JSON.stringify(ok));
    assert.deepEqual(ok.tests.preexisting, ['needs the real HOME state dir']);
    // regression diff: breaks add(); the env test fails on the base too, but 'adds' is NEW
    fs.writeFileSync(path.join(work, 'src', 'add.js'), 'module.exports = (a, b) => a - b;\n');
    const broken = git(['diff', '--full-index', '--binary'], work); git(['checkout', '--', '.'], work);
    const bad = verifyDiff({ taskId: 'int-diff-reg', rawDiff: broken, repoRoot: work, mainBranch: 'master' });
    assert.equal(bad.status, 'failed', JSON.stringify(bad));
    assert.deepEqual(bad.tests.failures, ['adds']);
    assert.deepEqual(bad.tests.preexisting, ['needs the real HOME state dir']);
    assert.equal(fs.existsSync(worktreePaths('int-diff-reg').worktreeDir), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- a claimed command whose target is not found from the repo root is skipped, not contradicted (HUB0068-02's redraft, 2026-09-30) -------------
test('a claimed command whose target does not exist from the repo root even WITH the diff is skipped: no run, no contradiction, no block', () => {
  const run = scriptedRun([{ exitCode: 1 }]);
  const f = fakeDeps({ run });
  const r = verifyDiff({ ...base, acceptanceResults: AR('`node --test src/elsewhere.test.js`'), deps: f.deps });
  assert.equal(run.calls.length, 0, 'never executed');
  assert.equal(r.commands[0].outcome, 'skipped');
  assert.match(r.commands[0].detail, /target not found from the repo root even with the diff applied \(src\/elsewhere\.test\.js\)/);
  assert.notEqual(r.status, 'failed');
});

test('a bare python module name claimed from another directory (python3 -m unittest test_x, file at dash/test_x.py) is skipped, while the dotted path from the root still runs', () => {
  const tree = () => worktreePaths('t1').worktreeDir;
  const run = scriptedRun([passing]);
  const f = fakeDeps({ prepare: baseTree(['dash/test_x.py']), run });
  let r = verifyDiff({ ...base, acceptanceResults: AR('`python3 -m unittest test_x -v`'), deps: f.deps });
  assert.equal(r.commands[0].outcome, 'skipped');
  assert.equal(run.calls.length, 0);
  const run2 = scriptedRun([passing]);
  const f2 = fakeDeps({ prepare: baseTree(['dash/test_x.py']), run: run2 });
  r = verifyDiff({ ...base, acceptanceResults: AR('`python3 -m unittest dash.test_x`'), deps: f2.deps });
  assert.equal(r.commands[0].outcome, 'confirmed');
  assert.equal(run2.calls.length, 1);
  void tree;
});

test('integration: the HUB0068-02 shape -- a real passing draft that claims a cwd-relative python command is not contradicted', { skip: !HAVE_BWRAP || !PY3 }, () => {
  const { root, work, changeTo } = makePyRepo();
  try {
    const r = verifyDiff({ taskId: 'int-cwd', rawDiff: changeTo('1  # same value, new comment'), repoRoot: work, mainBranch: 'master', pythonBin: PY3,
      acceptanceResults: [{ criterion: 'tests pass', check: '`python3 -m unittest test_feature -v` -> Ran 1 test OK (run from dash/)', result: 'PASS', pass: true }] });
    assert.notEqual(r.status, 'failed', JSON.stringify(r));
    assert.equal(r.commands[0].outcome, 'skipped');
    assert.equal(r.tests.passed, true, 'the covering test was still found by symbol and passed');
    assert.equal(r.status, 'passed');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


// --- unpinned changes: a hunk the covering tests do not pin (brain dump #1664, slice 1) ---------------------------------------------------
const { parseModifiedHunks, isTrivialHunk, isTestFile, MAX_UNPINNED_HUNKS } = require('./review-verify.js');

const TWO_HUNKS = [
  'diff --git a/src/a.js b/src/a.js', '--- a/src/a.js', '+++ b/src/a.js',
  '@@ -1,2 +1,2 @@', '-const one = 1;', '+const one = 11;', ' keep',
  '@@ -20,2 +20,2 @@', '-const two = 2;', '+const two = 22;', ' keep',
  'diff --git a/src/new.js b/src/new.js', 'new file mode 100644', '--- /dev/null', '+++ b/src/new.js', '@@ -0,0 +1 @@', '+x',
  'diff --git a/src/a.test.js b/src/a.test.js', '--- a/src/a.test.js', '+++ b/src/a.test.js', '@@ -1 +1 @@', '-t', '+u',
  'diff --git a/src/old.js b/src/new2.js', 'similarity index 90%', 'rename from src/old.js', 'rename to src/new2.js', '@@ -1 +1 @@', '-q', '+r',
  '',
].join('\n');

test('parseModifiedHunks returns each hunk of a MODIFIED source file as a standalone patch, and skips new, renamed and test files', () => {
  const hunks = parseModifiedHunks(TWO_HUNKS);
  assert.deepEqual(hunks.map((h) => [h.file, h.start, h.end]), [['src/a.js', 1, 1], ['src/a.js', 20, 20]]);
  for (const h of hunks) {
    assert.match(h.patch, /^diff --git a\/src\/a\.js b\/src\/a\.js\n--- a\/src\/a\.js\n\+\+\+ b\/src\/a\.js\n@@ /);
    assert.equal((h.patch.match(/^@@ /gm) || []).length, 1, 'exactly one hunk per patch');
    assert.ok(h.patch.endsWith('\n'));
  }
  assert.deepEqual(hunks[1].changed, ['-const two = 2;', '+const two = 22;']);
  assert.deepEqual(parseModifiedHunks(''), []);
});

test('isTestFile and isTrivialHunk: tests, comments, imports and exports cannot be mutated into a behavior change', () => {
  for (const f of ['src/a.test.js', 'src/a.spec.mjs', 'python/dashboard/test_x.py', 'pkg/x_test.py', 'tests/helper.py', 'src/__tests__/a.js']) assert.equal(isTestFile(f), true, f);
  for (const f of ['src/a.js', 'python/dashboard/app.py', 'src/testing.js']) assert.equal(isTestFile(f), false, f);
  assert.equal(isTrivialHunk(['+// note', '-  ', "+const x = require('./x.js');", '+import os', '+from a import b', '+module.exports = { a };', '+# py comment', '+ * doc']), true);
  assert.equal(isTrivialHunk(['+// note', '+const y = 2;']), false);
  assert.equal(isTrivialHunk(['+if (a) return null;']), false);
});

// Scripted order for TWO_HUNKS with one covering js suite: [main suite, h1 syntax, h1 suite, h2 syntax, h2 suite]
const unpinnedBase = { ...base, rawDiff: TWO_HUNKS, checkUnpinned: true };

test('unpinned: a hunk whose revert leaves every covering test green is reported, a hunk whose revert fails a test is not, and every hunk is put back', () => {
  const restored = [];
  const reverted = [];
  const run = scriptedRun([passing, passing, passing, passing, { exitCode: 1, output: 'not ok 1 - pins two\n' }]);
  const f = diffDeps({ run, unapplyDiff: (_d, patch) => { reverted.push(patch); return { applied: true }; }, applyDiff: (_d, patch) => { restored.push(patch); return { applied: true }; } });
  const r = verifyDiff({ ...unpinnedBase, deps: f.deps });
  assert.equal(r.status, 'passed', 'advisory only: the verdict is unchanged');
  assert.deepEqual(r.unpinned, { total: 2, checked: 2, skipped: 0, hunks: [{ file: 'src/a.js', start: 1, end: 1 }] });
  assert.equal(reverted.length, 2);
  assert.deepEqual(restored.slice(1), reverted, 'each reverted hunk is re-applied (restored[0] is the initial diff apply)');
  assert.deepEqual(run.calls[1].args, ['--check', 'src/a.js'], 'the reverted file is syntax-checked before the tests are trusted');
  assert.equal(run.calls.length, 5);
});

test('unpinned: off by default -- a plain verifyDiff never reverses a hunk', () => {
  let reversed = 0;
  const f = diffDeps({ run: scriptedRun([passing]), unapplyDiff: () => { reversed += 1; return { applied: true }; } });
  const r = verifyDiff({ ...base, rawDiff: TWO_HUNKS, deps: f.deps });
  assert.equal(r.status, 'passed');
  assert.equal(r.unpinned, undefined);
  assert.equal(reversed, 0);
});

test('unpinned: a diff whose only source hunks are comments or imports reports nothing', () => {
  const trivial = 'diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1,2 @@\n+// explain\n keep\n';
  const f = diffDeps({ run: scriptedRun([passing]) });
  const r = verifyDiff({ ...unpinnedBase, rawDiff: trivial, deps: f.deps });
  assert.equal(r.status, 'passed');
  assert.equal(r.unpinned, undefined);
});

test('unpinned: a revert that leaves the file unparseable is skipped, not counted as pinned; a suite timeout is skipped too', () => {
  const run = scriptedRun([passing, { exitCode: 1, output: 'SyntaxError' }, passing, { exitCode: null, timedOut: true }]);
  const f = diffDeps({ run });
  const r = verifyDiff({ ...unpinnedBase, deps: f.deps });
  assert.equal(r.status, 'passed');
  assert.deepEqual(r.unpinned, { total: 2, checked: 0, skipped: 2, hunks: [] });
});

test('unpinned: a hunk that cannot be reverted on its own is skipped and the rest are still checked', () => {
  let n = 0;
  const f = diffDeps({ run: scriptedRun([passing]), unapplyDiff: () => { n += 1; return n === 1 ? { applied: false, reason: 'overlap' } : { applied: true }; } });
  const r = verifyDiff({ ...unpinnedBase, deps: f.deps });
  assert.equal(r.unpinned.skipped, 1);
  assert.equal(r.unpinned.checked, 1);
  assert.deepEqual(r.unpinned.hunks.map((h) => h.start), [20]);
});

test('unpinned: if a hunk cannot be put back nothing is concluded, and the settled verdict is untouched', () => {
  let applies = 0;
  const f = diffDeps({ run: scriptedRun([passing]), applyDiff: () => { applies += 1; return applies === 1 ? { applied: true } : { applied: false, reason: 'restore failed' }; } });
  const r = verifyDiff({ ...unpinnedBase, deps: f.deps });
  assert.equal(r.status, 'passed');
  assert.equal(r.unpinned, undefined);
});

test('unpinned: it does not run when the covering tests failed, and a thrown error in it cannot change the verdict', () => {
  let reversed = 0;
  let f = diffDeps({ run: scriptedRun([failing('x'), passing]), unapplyDiff: () => { reversed += 1; return { applied: true }; } });
  const failed = verifyDiff({ ...unpinnedBase, deps: f.deps });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.unpinned, undefined);
  f = diffDeps({ run: scriptedRun([passing]), unapplyDiff: (_d, patch) => { if (patch.includes('@@ -1,2')) throw new Error('boom'); return { applied: true }; } });
  const r = verifyDiff({ ...unpinnedBase, deps: f.deps });
  assert.equal(r.status, 'passed');
});

test('unpinned: at most MAX_UNPINNED_HUNKS hunks are tried, the rest are counted as skipped; a nearly-spent budget tries none', () => {
  const many = ['diff --git a/src/a.js b/src/a.js', '--- a/src/a.js', '+++ b/src/a.js'];
  for (let i = 0; i < 9; i += 1) many.push(`@@ -${i * 20 + 1},2 +${i * 20 + 1},2 @@`, `-const v${i} = 1;`, `+const v${i} = 2;`, ' keep');
  const bigDiff = `${many.join('\n')}\n`;
  const run = scriptedRun([passing]);
  const f = diffDeps({ run });
  const r = verifyDiff({ ...unpinnedBase, rawDiff: bigDiff, deps: f.deps });
  assert.equal(r.unpinned.total, 9);
  assert.equal(r.unpinned.checked, MAX_UNPINNED_HUNKS);
  assert.equal(r.unpinned.skipped, 9 - MAX_UNPINNED_HUNKS);
  const f2 = diffDeps({ run: scriptedRun([passing]) });
  const r2 = verifyDiff({ ...unpinnedBase, rawDiff: bigDiff, budgetMs: 15000, deps: f2.deps });
  assert.equal(r2.status, 'passed');
  assert.equal(r2.unpinned.checked, 0, 'under 20s left: no hunk is attempted');
});

test('integration: in a real worktree and sandbox, the hunk the new test does not exercise is reported unpinned and the covered one is not', { skip: !HAVE_BWRAP }, () => {
  const { root, work, git } = makeRepo();
  try {
    const filler = Array.from({ length: 12 }, (_, i) => `// filler ${i}`).join('\n');
    fs.writeFileSync(path.join(work, 'src', 'add.js'), `function add(a, b) { return a + b; }\n${filler}\nfunction twice(a) { return a * 2; }\nmodule.exports = add;\nmodule.exports.twice = twice;\n`);
    git(['add', '-A'], work); git(['commit', '-m', 'two functions'], work); git(['push', 'origin', 'master'], work);
    // The diff coerces add()'s inputs (pinned by the new test) and changes twice() (which no test exercises).
    const src = fs.readFileSync(path.join(work, 'src', 'add.js'), 'utf8');
    fs.writeFileSync(path.join(work, 'src', 'add.js'), src.replace('return a + b;', 'return Number(a) + Number(b);').replace('return a * 2;', 'return a * 3;'));
    fs.writeFileSync(path.join(work, 'src', 'add.test.js'), "const test = require('node:test'); const assert = require('node:assert/strict'); const add = require('./add.js');\ntest('coerces', () => assert.equal(add('1', 2), 3));\n");
    git(['add', '-A'], work);
    const diff = git(['diff', '--cached', '--full-index', '--binary'], work);
    git(['reset', '-q', '--hard'], work);
    const r = verifyDiff({ taskId: 'unpinned-int', rawDiff: diff, repoRoot: work, mainBranch: 'master', checkUnpinned: true });
    assert.equal(r.status, 'passed', JSON.stringify(r.reasons));
    assert.equal(r.unpinned.total, 2);
    assert.equal(r.unpinned.checked, 2);
    assert.deepEqual(r.unpinned.hunks.map((h) => h.file), ['src/add.js']);
    assert.ok(r.unpinned.hunks[0].start > 10, 'it is the twice() hunk, not the add() hunk');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- gate replay hook (brain dump 7/8) ----------------------------------------------------------------
const REPLAY_RESULT = { candidates: [{ name: 'checkX', file: 'src/a.js', family: 'draft-text' }], skipped: [] };

test('verifyDiff attaches the gate replay result while the diff is applied, and the replay never changes the status', () => {
  let seen = null;
  const f = fakeDeps({ replay: (a) => { seen = a; return REPLAY_RESULT; } });
  const r = verifyDiff({ ...base, pipelineDir: '/pipe', checkReplay: true, deps: f.deps });
  assert.deepEqual(r.replay, REPLAY_RESULT);
  assert.equal(seen.rawDiff, DIFF);
  assert.equal(seen.pipelineDir, '/pipe');
  assert.equal(seen.mainBranch, 'master');
  assert.equal(typeof seen.run, 'function');
  assert.equal(r.status, 'inconclusive', 'no covering tests found: the replay does not turn that into a pass or a fail');
  const g = verifyDiff({ ...base, pipelineDir: '/pipe', checkReplay: true, deps: fakeDeps({ replay: () => REPLAY_RESULT, findTests: () => ({ js: ['src/a.test.js'], py: [] }) }).deps });
  assert.equal(g.status, 'passed');
  assert.deepEqual(g.replay, REPLAY_RESULT);
});

test('verifyDiff does not replay without the flag or a pipeline dir, and a replay that throws is swallowed', () => {
  let calls = 0;
  const counting = fakeDeps({ replay: () => { calls += 1; return REPLAY_RESULT; } });
  assert.equal(verifyDiff({ ...base, pipelineDir: '/pipe', deps: counting.deps }).replay, undefined, 'checkReplay defaults off');
  assert.equal(verifyDiff({ ...base, checkReplay: true, deps: counting.deps }).replay, undefined, 'no pipeline dir -> no corpus');
  assert.equal(calls, 0);
  const boom = fakeDeps({ replay: () => { throw new Error('replay exploded'); }, findTests: () => ({ js: ['src/a.test.js'], py: [] }) });
  const r = verifyDiff({ ...base, pipelineDir: '/pipe', checkReplay: true, deps: boom.deps });
  assert.equal(r.status, 'passed', 'the verdict is untouched');
  assert.equal(r.replay, undefined);
});

test('the replay runs inside the sandbox runner with the remaining budget, never past the deadline', () => {
  const f = fakeDeps({ replay: (a) => { a.run({ worktreeDir: '/w', bin: 'node', args: ['x'], timeoutMs: 999999 }); return REPLAY_RESULT; } });
  verifyDiff({ ...base, pipelineDir: '/pipe', checkReplay: true, budgetMs: 60000, deps: f.deps });
  const call = f.calls.run.find((c) => c.args && c.args[0] === 'x');
  assert.ok(call, 'the replay went through deps.run (the bwrap runner)');
  assert.ok(call.timeoutMs <= 60000, `timeout ${call.timeoutMs} is capped by the total budget`);
  const starved = fakeDeps({ replay: () => { throw new Error('must not run with <8s left'); } });
  assert.doesNotThrow(() => verifyDiff({ ...base, pipelineDir: '/pipe', checkReplay: true, budgetMs: 5000, deps: starved.deps }));
});

// --- brain-dump #1745: a dependency that is a link to a sibling checkout (agent-manager-hygiene -> ../agent-manager) ------------

// <root>/work (a git repo with an installed node_modules whose `dep` is a RELATIVE link to <root>/sibling-dep) and the sibling itself: code (src/x.js,
// package.json) plus things a test must never see (dep.env, queue/data.txt).
function makeRepoWithSiblingDep() {
  const r = makeRepo();
  const sibling = path.join(r.root, 'sibling-dep');
  fs.mkdirSync(path.join(sibling, 'src'), { recursive: true }); fs.mkdirSync(path.join(sibling, 'queue'));
  fs.writeFileSync(path.join(sibling, 'package.json'), '{"name":"dep","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(sibling, 'src', 'x.js'), "module.exports = { answer: 42 };\n");
  fs.writeFileSync(path.join(sibling, 'dep.env'), 'TOKEN=super-secret\n');
  fs.writeFileSync(path.join(sibling, 'queue', 'data.txt'), 'task data\n');
  fs.writeFileSync(path.join(r.work, 'package.json'), '{"name":"host"}\n');
  fs.mkdirSync(path.join(r.work, 'node_modules'));
  fs.symlinkSync('../../sibling-dep', path.join(r.work, 'node_modules', 'dep'));   // relative, like hygiene's agent-manager link
  r.git(['add', '-A'], r.work); r.git(['commit', '-m', 'package.json'], r.work); r.git(['push', 'origin', 'master'], r.work);
  return { ...r, sibling };
}

test('relinkExternalDependencies: a dangling relative link in the worktree COPY becomes an absolute link that resolves; the host and plain dirs are untouched', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relink-'));
  const host = path.join(root, 'host'); const sibling = path.join(root, 'sib');
  for (const d of [path.join(host, 'node_modules'), sibling]) fs.mkdirSync(d, { recursive: true });
  fs.symlinkSync('../../sib', path.join(host, 'node_modules', 'dep'));
  fs.writeFileSync(path.join(sibling, 'f.txt'), 'hello');
  const copyParent = fs.mkdtempSync(path.join(os.tmpdir(), 'relink-wt-'));
  const copyWt = path.join(copyParent, 'wt'); fs.mkdirSync(path.join(copyWt, 'node_modules'), { recursive: true });
  fs.symlinkSync('../../sib', path.join(copyWt, 'node_modules', 'dep'));  // dangling: <copyParent>/sib does not exist
  fs.mkdirSync(path.join(copyWt, 'node_modules', 'plain'));
  assert.equal(fs.existsSync(path.join(copyWt, 'node_modules', 'dep', 'f.txt')), false, 'dangling before');
  assert.deepEqual(relinkExternalDependencies(host, copyWt), ['dep']);
  assert.equal(fs.readFileSync(path.join(copyWt, 'node_modules', 'dep', 'f.txt'), 'utf8'), 'hello', 'resolves after');
  assert.equal(path.isAbsolute(fs.readlinkSync(path.join(copyWt, 'node_modules', 'dep'))), true);
  assert.equal(fs.readlinkSync(path.join(host, 'node_modules', 'dep')), '../../sib', 'the host link is untouched');
  assert.equal(fs.lstatSync(path.join(copyWt, 'node_modules', 'plain')).isDirectory(), true);
});

test('relinkExternalDependencies: never touches anything when the worktree\'s node_modules is itself a link out of the worktree', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relink-out-'));
  const host = path.join(root, 'host'); const sibling = path.join(root, 'sib'); const wt = path.join(root, 'wt');
  fs.mkdirSync(path.join(host, 'node_modules'), { recursive: true }); fs.mkdirSync(sibling); fs.mkdirSync(wt);
  fs.symlinkSync('../../sib', path.join(host, 'node_modules', 'dep'));
  fs.symlinkSync(path.join(host, 'node_modules'), path.join(wt, 'node_modules'));   // shared tree: unlinking inside it would damage the host
  assert.deepEqual(relinkExternalDependencies(host, wt), []);
  assert.equal(fs.readlinkSync(path.join(host, 'node_modules', 'dep')), '../../sib');
  assert.deepEqual(relinkExternalDependencies(path.join(root, 'none'), path.join(root, 'none-wt')), [], 'advisory: errors are swallowed');
});

test('sandboxUnresolvedDependency: only a bare specifier that RESOLVES on the host counts as the sandbox\'s fault', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unresolved-'));
  fs.mkdirSync(path.join(root, 'node_modules', 'dep', 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"host"}');
  fs.writeFileSync(path.join(root, 'node_modules', 'dep', 'package.json'), '{"name":"dep","main":"src/x.js"}');
  fs.writeFileSync(path.join(root, 'node_modules', 'dep', 'src', 'x.js'), 'module.exports = 1;');
  assert.equal(sandboxUnresolvedDependency(['dep/src/x.js'], root), 'dep/src/x.js');
  assert.equal(sandboxUnresolvedDependency(['./local.js', 'dep/src/x.js'], root), 'dep/src/x.js', 'relative ones are skipped');
  assert.equal(sandboxUnresolvedDependency(['not-installed-anywhere'], root), null, 'missing on the host too: the diff\'s fault');
  assert.equal(sandboxUnresolvedDependency(['dep/src/nope.js'], root), null, 'the package exists but this file does not: the diff\'s fault');
  assert.equal(sandboxUnresolvedDependency(['./x', '../y', '/abs/z', 'node:fs'], root), null);
  assert.equal(sandboxUnresolvedDependency([], root), null);
});

function missingModuleRun(spec) {
  return scriptedRun([{ exitCode: 1, output: `not ok 1 - needs the dep\nError: Cannot find module '${spec}'\n`, missingModules: [spec] }, { exitCode: 1, output: 'not ok 1 - other old failure\n' }]);
}

test('classification: a suite that died on a host-resolvable module is inconclusive and names the dependency, never a block', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cls-'));
  fs.mkdirSync(path.join(root, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"h"}'); fs.writeFileSync(path.join(root, 'node_modules', 'dep', 'package.json'), '{"name":"dep","main":"i.js"}'); fs.writeFileSync(path.join(root, 'node_modules', 'dep', 'i.js'), '');
  const f = diffDeps({ prepare: baseTree(['src/a.js']), run: missingModuleRun('dep') });   // a.test.js only in the diff: without this rule the failure would stand
  const r = verifyDiff({ ...base, repoRoot: root, deps: f.deps });
  assert.equal(r.status, 'inconclusive');
  assert.match(r.reasons.join(' '), /sandbox cannot resolve dep \(present on the host, missing in the review sandbox\)/);
});

test('classification: a module missing on the host as well, and a relative-path module-not-found, are still failures', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cls2-'));
  fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true }); fs.writeFileSync(path.join(root, 'package.json'), '{"name":"h"}');
  for (const spec of ['uninstalled-package', './not-there.js']) {
    const f = diffDeps({ prepare: baseTree(['src/a.js']), run: missingModuleRun(spec) });
    const r = verifyDiff({ ...base, repoRoot: root, deps: f.deps });
    assert.equal(r.status, 'failed', spec);
  }
});

test('integration: a hygiene-style repo (node_modules/dep is a RELATIVE link to a sibling checkout) verifies as passed inside the real sandbox', { skip: !HAVE_BWRAP }, () => {
  const { root, work, git } = makeRepoWithSiblingDep();
  try {
    const body = "const test = require('node:test'); const assert = require('node:assert/strict');\ntest('loads the sibling dependency', () => assert.equal(require('dep/src/x.js').answer, 42));\n";
    const r = verifyDiff({ taskId: 'int-dep', rawDiff: diffAddingTest(work, git, body), repoRoot: work, mainBranch: 'master', acceptanceResults: AR('`node --test src/add.test.js`') });
    assert.equal(r.status, 'passed', JSON.stringify(r));
    assert.equal(r.tests.passed, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('integration: the sibling\'s secret-looking file and queue data are NOT readable from inside the sandbox, though its code is', { skip: !HAVE_BWRAP }, () => {
  const { root, work, git, sibling } = makeRepoWithSiblingDep();
  try {
    const secret = JSON.stringify(path.join(fs.realpathSync(sibling), 'dep.env')); const queued = JSON.stringify(path.join(fs.realpathSync(sibling), 'queue', 'data.txt'));
    const body = "const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('fs');\n"
      + "test('code is loadable', () => assert.equal(require('dep/src/x.js').answer, 42));\n"
      + `test('env file is invisible', () => assert.throws(() => fs.readFileSync(${secret}, 'utf8'), { code: 'ENOENT' }));\n`
      + `test('queue data is invisible', () => assert.throws(() => fs.readFileSync(${queued}, 'utf8'), { code: 'ENOENT' }));\n`;
    const r = verifyDiff({ taskId: 'int-dep-secret', rawDiff: diffAddingTest(work, git, body), repoRoot: work, mainBranch: 'master', acceptanceResults: AR('`node --test src/add.test.js`') });
    assert.equal(r.status, 'passed', JSON.stringify(r));
    assert.equal(r.tests.passed, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- two evidence tiers: primary (changed + co-located tests) gate the verdict; dependents (mere importers) only report -------------------
test('splitCoveringTiers: changed and co-located tests are primary, mere importers are dependents; no primary keeps everything primary', () => {
  const affected = { js: ['src/x.test.js', 'src/y.test.js', 'src/z.test.js'], py: ['python/d/test_m.py', 'python/d/test_other.py'] };
  let t = splitCoveringTiers(['src/x.js', 'src/x.test.js', 'python/d/m.py'], affected);
  assert.deepEqual(t.primary, { js: ['src/x.test.js'], py: ['python/d/test_m.py'] });
  assert.deepEqual(t.dependents, { js: ['src/y.test.js', 'src/z.test.js'], py: ['python/d/test_other.py'] });
  t = splitCoveringTiers(['src/x.js'], affected);                       // co-located x.test.js, no changed test file
  assert.deepEqual(t.primary.js, ['src/x.test.js']);
  t = splitCoveringTiers(['src/lib/util.js'], { js: ['src/a.test.js', 'src/b.test.js'], py: [] });   // no name-matched test: all stay primary
  assert.deepEqual(t.primary.js, ['src/a.test.js', 'src/b.test.js']);
  assert.deepEqual(t.dependents.js, []);
});

const TIER_FILES = ['src/a.js', 'src/a.test.js', 'src/dep.test.js'];
test('a dependent test file that times out is reported unverified and does NOT make the result inconclusive', () => {
  const run = scriptedRun([passing, { exitCode: null, timedOut: true }]);   // primary passes, dependents time out
  const f = fakeDeps({ findTests: () => ({ js: ['src/a.test.js', 'src/dep.test.js'], py: [] }), prepare: baseTree(TIER_FILES), run });
  const r = verifyDiff({ ...base, deps: f.deps });
  assert.equal(r.status, 'passed');
  assert.equal(r.tests.passed, true);
  assert.deepEqual(r.tests.dependentsUnverified, ['src/dep.test.js']);
  assert.deepEqual(run.calls.map((c) => c.args.filter((a) => a.endsWith('.test.js'))), [['src/a.test.js'], ['src/dep.test.js']], 'primary and dependents run as separate suites');
});

test('a dependent test file that FAILS with the diff but passes on the base still fails the result', () => {
  const run = scriptedRun([passing, failing('dep breaks'), passing]);   // primary ok, dependent fails, dependent passes on the base
  const f = fakeDeps({ findTests: () => ({ js: ['src/a.test.js', 'src/dep.test.js'], py: [] }), prepare: baseTree(TIER_FILES), run });
  const r = verifyDiff({ ...base, deps: f.deps });
  assert.equal(r.status, 'failed');
  assert.equal(r.tests.passed, false);
  assert.deepEqual(r.tests.failures, ['dep breaks']);
});

test('a PRIMARY timeout is still inconclusive even when the dependents pass', () => {
  const run = scriptedRun([{ exitCode: null, timedOut: true }, passing]);
  const f = fakeDeps({ findTests: () => ({ js: ['src/a.test.js', 'src/dep.test.js'], py: [] }), prepare: baseTree(TIER_FILES), run });
  const r = verifyDiff({ ...base, deps: f.deps });
  assert.equal(r.status, 'inconclusive');
  assert.deepEqual(r.tests.timedOutFiles, ['src/a.test.js']);
});

test('a dependent file that also fails on the base in the sandbox is unverified, not a reason to void a passing primary tier', () => {
  const run = scriptedRun([passing, failing('env only'), failing('env only')]);   // primary ok; dependent fails with the diff AND on the base
  const f = fakeDeps({ findTests: () => ({ js: ['src/a.test.js', 'src/dep.test.js'], py: [] }), prepare: baseTree(TIER_FILES), run });
  const r = verifyDiff({ ...base, deps: f.deps });
  assert.equal(r.status, 'passed');
  assert.equal(r.tests.passed, true);
  assert.deepEqual(r.tests.dependentsUnverified, ['src/dep.test.js']);
});

test('a primary file that also fails on the base in the sandbox still makes the result inconclusive', () => {
  const run = scriptedRun([failing('env only'), failing('env only')]);
  const f = fakeDeps({ findTests: () => ({ js: ['src/a.test.js'], py: [] }), prepare: baseTree(TIER_FILES), run });
  const r = verifyDiff({ ...base, deps: f.deps });
  assert.equal(r.status, 'inconclusive');
});

// --- changed-file syntax gate (2026-10-07: AC-271's split import reached pending-merge, then the redraft repeated it) ----------------------
// A stateful stub: `applied` follows applyDiff/unapplyDiff so a check can behave differently with the diff and on the base. Files named in
// `newFiles` exist only while the diff is applied; the others exist throughout.
function synDeps({ tree = ['src/a.js', 'src/a.test.js'], contents = {}, appliedContents = {}, newFiles = [], failWith = () => false, unapplyOk = true, reapplyOk = true, over = {} } = {}) {
  const st = { applied: false, applyCalls: 0, unapplyCalls: 0, synRuns: [] };
  const dir = () => worktreePaths('t1').worktreeDir;
  const f = fakeDeps({
    prepare: () => {
      fs.rmSync(dir(), { recursive: true, force: true });
      for (const t of tree) { fs.mkdirSync(path.dirname(path.join(dir(), t)), { recursive: true }); fs.writeFileSync(path.join(dir(), t), contents[t] != null ? contents[t] : '// base\n'); }
      return { ok: true };
    },
    applyDiff: () => {
      st.applyCalls += 1;
      if (st.applyCalls > 1 && !reapplyOk) return { applied: false, reason: 'conflict' };
      st.applied = true;
      for (const n of newFiles) { fs.mkdirSync(path.dirname(path.join(dir(), n)), { recursive: true }); fs.writeFileSync(path.join(dir(), n), '// new\n'); }
      for (const [n, c] of Object.entries(appliedContents)) fs.writeFileSync(path.join(dir(), n), c);
      return { applied: true };
    },
    unapplyDiff: () => {
      st.unapplyCalls += 1;
      if (!unapplyOk) return { applied: false, reason: 'cannot reverse' };
      st.applied = false;
      for (const n of newFiles) fs.rmSync(path.join(dir(), n), { force: true });
      for (const n of Object.keys(appliedContents)) fs.writeFileSync(path.join(dir(), n), contents[n] != null ? contents[n] : '// base\n');
      return { applied: true };
    },
    syntaxRun: (a) => {
      st.synRuns.push({ bin: a.bin, file: a.args[a.args.length - 1], applied: st.applied });
      const file = a.args[a.args.length - 1];
      const fail = failWith({ file, applied: st.applied });
      return fail ? { ran: true, exitCode: 1, timedOut: false, output: typeof fail === 'string' ? fail : `${file}:12\n  x = ;\n\nSyntaxError: Unexpected token ';'` } : { ran: true, exitCode: 0, timedOut: false, output: '' };
    },
    findTests: () => ({ js: ['src/a.test.js'], py: [] }),
    ...over,
  });
  return { f, st };
}

test('syntax gate: a changed file that parses on the base but not with the diff FAILS the result before any test is run, naming the file and line', () => {
  const { f, st } = synDeps({ failWith: ({ file, applied }) => applied && file === 'src/a.js' });
  const r = verifyDiff({ ...base, deps: f.deps });
  assert.equal(r.status, 'failed');
  assert.match(r.reasons[0], /syntax error in a file the diff changes -- src\/a\.js:12 SyntaxError: Unexpected token/);
  assert.deepEqual(r.syntax.failed, ['src/a.js']);
  assert.equal(f.calls.run.length, 0, 'no covering test is spent on a file that does not parse');
  assert.equal(r.tests, null);
  assert.equal(st.unapplyCalls, 1);
  assert.equal(st.applied, true, 'the diff was put back');
  assert.equal(f.calls.cleanup, 1);
});

test('syntax gate: a file that already fails on the base is pre-existing and does not fail the result', () => {
  const { f } = synDeps({ failWith: ({ file }) => file === 'src/a.js' });
  const r = verifyDiff({ ...base, deps: f.deps });
  assert.notEqual(r.status, 'failed');
  assert.deepEqual(r.syntax.preexisting, ['src/a.js']);
  assert.deepEqual(r.syntax.failed, []);
  assert.ok(f.calls.run.length > 0, 'the tests still ran');
});

test('syntax gate: a NEW file that does not parse has no base to compare with, so the failure stands', () => {
  const { f } = synDeps({ tree: ['src/a.test.js'], newFiles: ['src/a.js'], failWith: ({ file, applied }) => applied && file === 'src/a.js' });
  const r = verifyDiff({ ...base, deps: f.deps });
  assert.equal(r.status, 'failed');
  assert.deepEqual(r.syntax.failed, ['src/a.js']);
});

test('syntax gate: a file the diff removed, a TypeScript file and an unknown extension are skipped with a reason and never fail the result', () => {
  const diff = DIFF + 'diff --git a/src/gone.js b/src/gone.js\n--- a/src/gone.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\ndiff --git a/web/App.tsx b/web/App.tsx\n--- a/web/App.tsx\n+++ b/web/App.tsx\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/run.sh b/run.sh\n--- a/run.sh\n+++ b/run.sh\n@@ -1 +1 @@\n-a\n+b\n';
  const { f } = synDeps({ tree: ['src/a.js', 'src/a.test.js', 'web/App.tsx', 'run.sh'] });
  const r = verifyDiff({ ...base, rawDiff: diff, deps: f.deps });
  assert.notEqual(r.status, 'failed');
  const why = Object.fromEntries(r.syntax.skipped.map((x) => [x.file, x.reason]));
  assert.match(why['src/gone.js'], /absent/);
  assert.match(why['web/App.tsx'], /no \.tsx parser/);
  assert.match(why['run.sh'], /no syntax checker/);
  assert.deepEqual(r.syntax.checked.sort(), ['src/a.js', 'src/a.test.js']);
});

test('syntax gate: python files are skipped (not failed) when no interpreter can be found, and checked with the resolved one otherwise', () => {
  const diff = 'diff --git a/svc/x.py b/svc/x.py\n--- a/svc/x.py\n+++ b/svc/x.py\n@@ -1 +1 @@\n-a\n+b\n';
  let a = synDeps({ tree: ['svc/x.py'], over: { resolvePy: () => null, findTests: () => ({ js: [], py: [] }) } });
  let r = verifyDiff({ ...base, rawDiff: diff, deps: a.f.deps });
  assert.notEqual(r.status, 'failed');
  assert.match(r.syntax.skipped[0].reason, /no python interpreter/);
  assert.equal(a.st.synRuns.length, 0);
  a = synDeps({ tree: ['svc/x.py'], failWith: ({ applied }) => applied && 'File "svc/x.py", line 3\nSyntaxError: invalid syntax', over: { resolvePy: () => '/usr/bin/python3', findTests: () => ({ js: [], py: [] }) } });
  r = verifyDiff({ ...base, rawDiff: diff, deps: a.f.deps });
  assert.equal(r.status, 'failed');
  assert.equal(a.st.synRuns[0].bin, 'python');
  assert.match(r.reasons[0], /svc\/x\.py:3 SyntaxError: invalid syntax/);
});

test('syntax gate: node module-format messages are skipped, not failures', () => {
  const { f } = synDeps({ failWith: ({ applied }) => applied && 'SyntaxError: Cannot use import statement outside a module' });
  const r = verifyDiff({ ...base, deps: f.deps });
  assert.notEqual(r.status, 'failed');
  assert.ok(r.syntax.skipped.some((x) => /module-format/.test(x.reason)));
});

test('syntax gate: when the diff cannot be reversed, or cannot be put back, the result is inconclusive and nothing else runs', () => {
  let x = synDeps({ failWith: ({ applied }) => applied, unapplyOk: false });
  let r = verifyDiff({ ...base, deps: x.f.deps });
  assert.equal(r.status, 'inconclusive');
  assert.match(r.reasons[0], /could not be un-applied/);
  assert.equal(x.f.calls.run.length, 0);
  x = synDeps({ failWith: ({ file, applied }) => applied && file === 'src/a.js', reapplyOk: false });
  r = verifyDiff({ ...base, deps: x.f.deps });
  assert.equal(r.status, 'inconclusive');
  assert.match(r.reasons[0], /could not be re-applied/);
  assert.equal(x.f.calls.run.length, 0);
});

test('syntax gate: a clean diff never reverses the diff, and a .json file is parsed in process', () => {
  const diff = DIFF + 'diff --git a/cfg/x.json b/cfg/x.json\n--- a/cfg/x.json\n+++ b/cfg/x.json\n@@ -1 +1 @@\n-{}\n+{"a":1}\n';
  const tree = ['src/a.js', 'src/a.test.js', 'cfg/x.json'];
  let x = synDeps({ tree, contents: { 'cfg/x.json': '{"a":1}' } });
  let r = verifyDiff({ ...base, rawDiff: diff, deps: x.f.deps });
  assert.notEqual(r.status, 'failed');
  assert.equal(x.st.unapplyCalls, 0, 'an all-clean run never touches the worktree');
  assert.ok(r.syntax.checked.includes('cfg/x.json'));
  x = synDeps({ tree, contents: { 'cfg/x.json': '{"a":1}' }, appliedContents: { 'cfg/x.json': '{"a":' } });
  r = verifyDiff({ ...base, rawDiff: diff, deps: x.f.deps });
  assert.equal(r.status, 'failed');
  assert.deepEqual(r.syntax.failed, ['cfg/x.json']);
  assert.match(r.reasons[0], /cfg\/x\.json/);
});

test('an unresolved python interpreter is reported as such, not as an unavailable sandbox', () => {
  const diff = 'diff --git a/svc/x.py b/svc/x.py\n--- a/svc/x.py\n+++ b/svc/x.py\n@@ -1 +1 @@\n-a\n+b\n';
  const f = fakeDeps({ prepare: baseTree(['svc/x.py', 'svc/test_x.py']), resolvePy: () => null, findTests: () => ({ js: [], py: ['svc/test_x.py'] }), run: () => ({ ran: false, reason: 'no python interpreter available' }) });
  const r = verifyDiff({ ...base, rawDiff: diff, deps: f.deps });
  assert.equal(r.status, 'inconclusive');
  assert.match(r.reasons.join(' '), /no python interpreter available/);
  assert.doesNotMatch(r.reasons.join(' '), /bwrap/);
});

// --- per-file covering runs (2026-10-08) ------------------------------------------------------------------------------------------------
// src/local-draft.test.js alone takes ~9 minutes, past the review's 210s cap. All covering files used to run in ONE `node --test a b c d`, so its timeout
// discarded the three fast files' passes too and the reviewers rejected on "unverified". Each file now runs in its own process.

const OTHER = 'diff --git a/src/other.js b/src/other.js\n--- a/src/other.js\n+++ b/src/other.js\n@@ -1 +1 @@\n-x\n+y\n';
const filesOf = (a) => a.args.filter((x) => /\.test\.js$/.test(x));

test('per-file: a slow file times out ALONE -- the other covering file still reports a real pass, and each run gets exactly one file', () => {
  const calls = [];
  const f = fakeDeps({
    findTests: () => ({ js: ['src/a.test.js', 'src/b.test.js'], py: [] }),
    prepare: baseTree(['src/a.js', 'src/a.test.js', 'src/b.test.js']),
    run: (a) => { calls.push(a); return /b\.test\.js/.test(a.args.join(' ')) ? { ran: true, exitCode: null, timedOut: true, output: '' } : { ran: true, exitCode: 0, timedOut: false, output: '' }; },
  });
  const r = verifyDiff({ ...base, rawDiff: OTHER, deps: f.deps });
  assert.equal(r.status, 'inconclusive');
  assert.deepEqual(r.tests.passedFiles, ['src/a.test.js']);
  assert.deepEqual(r.tests.timedOutFiles, ['src/b.test.js']);
  assert.ok(calls.every((c) => filesOf(c).length === 1), 'one file per process');
  assert.match(r.reasons.join(' '), /1 file\(s\) unverified.*src\/b\.test\.js/);
});

test('per-file: the cheapest (smallest) covering file runs first, so a huge one cannot starve the rest of the budget', () => {
  const order = [];
  const f = fakeDeps({
    findTests: () => ({ js: ['src/huge.test.js', 'src/tiny.test.js'], py: [] }),
    prepare: () => {
      const dir = worktreePaths('t1').worktreeDir;
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src/huge.test.js'), '// big\n'.repeat(500));
      fs.writeFileSync(path.join(dir, 'src/tiny.test.js'), '// t\n');
      return { ok: true };
    },
    run: (a) => { order.push(filesOf(a)[0]); return { ran: true, exitCode: 0, timedOut: false, output: '' }; },
  });
  const r = verifyDiff({ ...base, rawDiff: OTHER, deps: f.deps });
  assert.deepEqual(order, ['src/tiny.test.js', 'src/huge.test.js']);
  assert.equal(r.status, 'passed');
  assert.deepEqual(r.tests.passedFiles, ['src/tiny.test.js', 'src/huge.test.js']);
});

test('addedTestNames: the test()/it()/describe() cases a diff adds to ONE file, unescaped and de-duplicated', () => {
  const diff = [
    'diff --git a/src/x.test.js b/src/x.test.js', '--- a/src/x.test.js', '+++ b/src/x.test.js', '@@ -1 +1,4 @@',
    "+test('first one: it\\'s fine', () => {});", '+  it("second", () => {});', '+test(`third`, () => {});', "+test('first one: it\\'s fine', () => {});",
    " test('untouched context', () => {});",
    'diff --git a/src/y.test.js b/src/y.test.js', '--- a/src/y.test.js', '+++ b/src/y.test.js', '@@ -1 +1 @@', "+test('belongs to y', () => {});",
  ].join('\n');
  assert.deepEqual(addedTestNames(diff, 'src/x.test.js'), ["first one: it's fine", 'second', 'third']);
  assert.deepEqual(addedTestNames(diff, 'src/y.test.js'), ['belongs to y']);
  assert.deepEqual(addedTestNames(diff, 'src/none.test.js'), []);
});

const ADDS = 'diff --git a/src/b.js b/src/b.js\n--- a/src/b.js\n+++ b/src/b.js\n@@ -1 +1 @@\n-x\n+y\ndiff --git a/src/b.test.js b/src/b.test.js\n--- a/src/b.test.js\n+++ b/src/b.test.js\n@@ -1 +1,2 @@\n+test(\'the gate blocks (a.b)\', () => {});\n';

test('narrowed-first: the tests a diff adds to a file run on their own first; if the whole file then cannot finish, they remain as PARTIAL evidence', () => {
  const calls = [];
  const f = fakeDeps({
    findTests: () => ({ js: ['src/b.test.js'], py: [] }),
    prepare: baseTree(['src/b.js', 'src/b.test.js']),
    run: (a) => { calls.push(a); return a.args.includes('--test-name-pattern') ? { ran: true, exitCode: 0, timedOut: false, output: '' } : { ran: true, exitCode: null, timedOut: true, output: '' }; },
  });
  const r = verifyDiff({ ...base, rawDiff: ADDS, deps: f.deps });
  const narrowed = calls.find((c) => c.args.includes('--test-name-pattern'));
  assert.ok(narrowed, 'a narrowed run happened');
  assert.equal(narrowed.args[narrowed.args.indexOf('--test-name-pattern') + 1], 'the gate blocks \\(a\\.b\\)', 'the pattern is regex-escaped');
  assert.equal(calls.indexOf(narrowed), 0, 'and it ran BEFORE the whole file');
  assert.equal(r.status, 'inconclusive');
  assert.deepEqual(r.tests.timedOutFiles, ['src/b.test.js']);
  assert.deepEqual(r.tests.partial, [{ file: 'src/b.test.js', tests: ['the gate blocks (a.b)'], count: 1, passed: true }]);
  assert.deepEqual(r.tests.passedFiles, []);
});

test('narrowed-first: a diff-added test that FAILS is a real failure (the base has no such test, so the control run cannot excuse it)', () => {
  let onBase = false;   // the control run happens after the diff is reversed; there the added test does not exist, so the pattern matches nothing and exits 0
  const f = fakeDeps({
    findTests: () => ({ js: ['src/b.test.js'], py: [] }),
    prepare: baseTree(['src/b.js', 'src/b.test.js']),
    unapplyDiff: () => { onBase = true; return { applied: true }; },
    run: (a) => (a.args.includes('--test-name-pattern') && !onBase ? { ran: true, exitCode: 1, timedOut: false, output: 'not ok 1 - the gate blocks (a.b)\n' } : { ran: true, exitCode: 0, timedOut: false, output: '' }),
  });
  const r = verifyDiff({ ...base, rawDiff: ADDS, deps: f.deps });
  assert.equal(r.status, 'failed');
  assert.equal(r.tests.partial[0].passed, false);
});

test('differential: a failure whose base run TIMED OUT says so -- it is not reported as "already fails on master"', () => {
  const f = diffDeps({ run: scriptedRun([failing('x'), { exitCode: null, timedOut: true }]) });
  const r = verifyDiff({ ...base, deps: f.deps });
  assert.equal(r.status, 'inconclusive');
  const text = r.reasons.join(' ');
  assert.match(text, /could not finish on master either \(timed out\)/);
  assert.doesNotMatch(text, /already fail on/);
});

test('differential: a failure that really also fails on the base keeps the "already fail" wording', () => {
  const f = diffDeps({ run: scriptedRun([failing('x'), failing('x')]) });
  const r = verifyDiff({ ...base, deps: f.deps });
  assert.match(r.reasons.join(' '), /already fail on master in the review sandbox/);
});

test('differential: a file whose only failures also fail on the base is reported as such (status stays inconclusive), while a clean sibling file still reports its pass', () => {
  const f = fakeDeps({
    findTests: () => ({ js: ['src/a.test.js', 'src/b.test.js'], py: [] }),
    prepare: baseTree(['src/a.js', 'src/a.test.js', 'src/b.test.js']),
    run: (a) => (/b\.test\.js/.test(a.args.join(' ')) ? { ran: true, exitCode: 1, timedOut: false, output: 'not ok 1 - greps the live repo\n' } : { ran: true, exitCode: 0, timedOut: false, output: '' }),
  });
  const r = verifyDiff({ ...base, rawDiff: OTHER, deps: f.deps });
  assert.equal(r.status, 'inconclusive');
  assert.deepEqual(r.tests.preexistingOnlyFiles, ['src/b.test.js']);
  assert.deepEqual(r.tests.passedFiles, ['src/a.test.js']);
  assert.deepEqual(r.tests.preexisting, ['greps the live repo']);
});

test('per-file: a real failure in one file is not erased by another file timing out -- the result is failed and tests.passed stays false', () => {
  let onBase = false;
  const f = fakeDeps({
    findTests: () => ({ js: ['src/a.test.js', 'src/b.test.js'], py: [] }),
    prepare: baseTree(['src/a.js', 'src/a.test.js', 'src/b.test.js']),
    unapplyDiff: () => { onBase = true; return { applied: true }; },
    run: (a) => {
      const text = a.args.join(' ');
      if (/b\.test\.js/.test(text)) return { ran: true, exitCode: null, timedOut: true, output: '' };
      return onBase ? { ran: true, exitCode: 0, timedOut: false, output: '' } : { ran: true, exitCode: 1, timedOut: false, output: 'not ok 1 - the new regression\n' };
    },
  });
  const r = verifyDiff({ ...base, rawDiff: OTHER, deps: f.deps });
  assert.equal(r.status, 'failed');
  assert.equal(r.tests.passed, false);
  assert.deepEqual(r.tests.timedOutFiles, ['src/b.test.js']);
});
