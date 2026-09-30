'use strict';

// Tests for review-verify.js (executed verification for the review step). Run: node --test src/review-verify.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { verifyDiff, extractChangedFiles, extractRunnableCommands, classifyCommand, tokenize, worktreePaths, extractChangedSymbols, findSymbolCoveringTests, findTestsWithSymbolFallback } = require('./review-verify.js');
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
      prepare: () => ({ ok: true }),
      applyDiff: () => ({ applied: true }),
      unapplyDiff: () => ({ applied: true }),
      cleanup: () => { calls.cleanup += 1; },
      findTests: () => ({ js: [], py: [] }),
      run: (a) => { calls.run.push(a); return { ran: true, exitCode: 0, timedOut: false, output: '' }; },
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
  const f = fakeDeps({ run: () => ({ ran: true, exitCode: 1, timedOut: false, output: 'AssertionError' }) });
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

test('covering tests that fail make the result failed and carry the parsed failure names', () => {
  const f = fakeDeps({
    findTests: () => ({ js: ['src/a.test.js'], py: [] }),
    run: () => ({ ran: true, exitCode: 1, timedOut: false, output: 'not ok 1 - the thing breaks\n' }),
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
  f = diffDeps({ findTests: () => ({ js: [], py: [] }), prepare: baseTree(['src/a.js']), run });   // the claimed test file only exists in the diff
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
