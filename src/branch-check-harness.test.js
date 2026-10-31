'use strict';

// Tests for branch-check-harness.js: which tests cover a change, and the command that runs them. The planning is checked on real temporary directories; the
// end-to-end cases run a real `node --test` and a real `python3 -m unittest` through runBranchCheck on real temporary git repositories.
// Run: node --test src/branch-check-harness.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { DEFAULT_HARNESSES, HARNESSES, coveringTestFiles, SMALL_SUITE_FILES } = require('./branch-check-harness.js');
const { runBranchCheck } = require('./branch-check-runner.js');

const GIT_IDENTITY = ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid'];
const git = (cwd, ...args) => execFileSync('git', [...GIT_IDENTITY, ...args], { cwd, encoding: 'utf8' }).trim();

function writeFiles(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    if (content === null) { fs.rmSync(full, { force: true }); continue; }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

function tempDir(t, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-check-harness-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeFiles(dir, files);
  return dir;
}

function makeRepo(t, baseFiles) {
  const root = tempDir(t, baseFiles);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  return root;
}

function branchWith(root, changes) {
  git(root, 'checkout', '-q', '-b', 'feature');
  writeFiles(root, changes);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'feature');
  const sha = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-q', 'main');
  return sha;
}

const check = (root, sha, extra = {}) => runBranchCheck({ repoRoot: root, branch: 'feature', headSha: sha, base: 'main', ...extra });
const pick = (dir, ctx) => { const h = DEFAULT_HARNESSES.find((x) => x.detect(dir, fs, ctx)); return h && h.id; };

const NODE_TEST = "const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst f = require('./a.js');\ntest('a', () => { assert.equal(f(), 1); });\n";
const PY_TEST = 'import unittest\nfrom pkg import f\n\n\nclass T(unittest.TestCase):\n    def test_f(self):\n        self.assertEqual(f(), 1)\n';

test('each harness is recognised by its marker files and by the branch changing files it can test, and the first match wins in the documented order', (t) => {
  const tokenfold = tempDir(t, { 'core/tests/test_core.py': '', 'core/tokenfold/__init__.py': '', 'package.json': '{}', 'src/x.js': '' });
  assert.equal(pick(tokenfold, { changedFiles: ['core/tokenfold/x.py'] }), 'tokenfold-core', 'tokenfold wins over the package.json it also has');
  assert.equal(pick(tokenfold, { changedFiles: ['src/x.js'] }), 'node-test');
  assert.equal(pick(tokenfold, { changedFiles: ['src/x.js', 'core/tokenfold/x.py'] }), 'tokenfold-core', 'when both detect, tokenfold (the more specific marker) comes first');
  assert.equal(pick(tokenfold, { changedFiles: ['README.md'] }), undefined);

  const node = tempDir(t, { 'package.json': '{}', 'src/a.js': '' });
  assert.equal(pick(node, { changedFiles: ['src/a.js'] }), 'node-test');
  assert.equal(pick(node, { changedFiles: ['tools/x.py'] }), undefined, 'a Python-only change is not the JavaScript harness business');
  const nodeNoPackage = tempDir(t, { 'scripts/a.test.js': '', 'scripts/a.js': '' });
  assert.equal(pick(nodeNoPackage, { changedFiles: ['scripts/a.js'] }), 'node-test', 'a test file under scripts/ is a marker too');

  const srcTests = tempDir(t, { 'src/pkg/__init__.py': '', 'tests/test_a.py': '' });
  assert.equal(pick(srcTests, { changedFiles: ['src/pkg/__init__.py'] }), 'python-src-tests');
  assert.equal(pick(srcTests, { changedFiles: ['src/pkg/data.json'] }), undefined);

  const venvRoot = tempDir(t, { '.venv/bin/python': '#!/bin/sh\n' });
  const flat = tempDir(t, { 'test_x.py': '', 'x.py': '' });
  assert.equal(pick(flat, { repoRoot: venvRoot, changedFiles: ['x.py'] }), 'python-venv-flat');
  assert.equal(pick(flat, { repoRoot: flat, changedFiles: ['x.py'] }), undefined, 'no virtualenv in the project checkout, no venv harness');
  const nested = tempDir(t, { 'python/dashboard/test_y.py': '', 'python/dashboard/y.py': '' });
  assert.equal(pick(nested, { repoRoot: venvRoot, changedFiles: ['python/dashboard/y.py'] }), 'python-venv-flat');
  const elsewhere = tempDir(t, { 'docs/test_z.py': '', 'z.py': '' });
  assert.equal(pick(elsewhere, { repoRoot: venvRoot, changedFiles: ['z.py'] }), undefined, 'test files outside the root and python/ do not count');

  assert.equal(pick(tempDir(t, { 'notes.txt': 'x' }), { changedFiles: ['notes.txt'] }), undefined);
});

test('coveringTestFiles: changed tests run, a changed source pulls in tests that mention its basename, duplicates collapse, the list is sorted', async (t) => {
  const dir = tempDir(t, { 'src/a.js': '', 'src/a.test.js': '', 'src/b.test.js': '', 'test/c.test.mjs': '', 'test/d.test.mjs': '', 'src/gone.js': '' });
  const searched = [];
  const grep = async (pattern, glob) => {
    searched.push([pattern, glob]);
    if (pattern === 'a' && glob === '*.test.js') return ['src/b.test.js', 'src/a.test.js', 'node_modules/pkg/x.test.js'];
    if (pattern === 'a' && glob === '*.test.mjs') return ['test/d.test.mjs', 'test/c.test.mjs'];
    return [];
  };
  // the changed test file sorts LAST and is found FIRST, so the result is only in order if it is sorted
  const r = await coveringTestFiles({ worktreeDir: dir, changedFiles: ['src/a.js', 'test/d.test.mjs', 'src/deleted.test.js', 'README.md'], grep });
  assert.deepEqual(r.files, ['src/a.test.js', 'src/b.test.js', 'test/c.test.mjs', 'test/d.test.mjs']);
  assert.deepEqual(r.notRun, []);
  assert.deepEqual(searched.map((s) => s[0]), ['a', 'a', 'a'], 'only the changed non-test source that exists is searched for, with all three test globs');
});

test('coveringTestFiles: the cap puts the rest in notRun by name, and no covering test says so and plans nothing', async (t) => {
  const dir = tempDir(t, { 'src/a.js': '' });
  const many = Array.from({ length: 15 }, (_, i) => `src/t${String(i).padStart(2, '0')}.test.js`);
  const capped = await coveringTestFiles({ worktreeDir: dir, changedFiles: ['src/a.js'], maxTestFiles: 12, grep: async () => many });
  assert.equal(capped.files.length, 12);
  assert.equal(capped.notRun.length, 1);
  assert.match(capped.notRun[0], /^3 more covering test files not run: src\/t12\.test\.js, src\/t13\.test\.js, src\/t14\.test\.js$/);
  const none = await coveringTestFiles({ worktreeDir: dir, changedFiles: ['src/a.js'], grep: async () => [] });
  assert.deepEqual(none, { files: [], notRun: ['no test file covers the changed files'] });
  const noGrep = await coveringTestFiles({ worktreeDir: dir, changedFiles: ['src/a.js'] });
  assert.deepEqual(noGrep.files, []);
});

test('node-test plan: one node --test command over the covering files, node_modules borrowed from the project checkout only when the worktree has none', async (t) => {
  const repo = tempDir(t, { 'node_modules/pkg/index.js': 'module.exports = 1;' });
  const wt = tempDir(t, { 'src/a.js': '', 'src/a.test.js': '' });
  const plan = await HARNESSES.nodeTest.plan({ worktreeDir: wt, changedFiles: ['src/a.js', 'tools/helper.py'], grep: async () => ['src/a.test.js'], repoRoot: repo });
  assert.deepEqual(plan.commands, [{ what: 'node tests (1 covering file)', file: 'node', args: ['--test', 'src/a.test.js'], cwd: wt }]);
  assert.ok(fs.lstatSync(path.join(wt, 'node_modules')).isSymbolicLink());
  assert.equal(fs.realpathSync(path.join(wt, 'node_modules')), fs.realpathSync(path.join(repo, 'node_modules')));
  assert.ok(plan.notRun.some((l) => /does not run tests for: tools\/helper\.py/.test(l)), 'a changed Python file next to the JavaScript one is named, not silently skipped');

  const own = tempDir(t, { 'src/a.js': '', 'src/a.test.js': '', 'node_modules/mine/index.js': '' });
  await HARNESSES.nodeTest.plan({ worktreeDir: own, changedFiles: ['src/a.js'], grep: async () => ['src/a.test.js'], repoRoot: repo });
  assert.equal(fs.lstatSync(path.join(own, 'node_modules')).isSymbolicLink(), false, 'a worktree that has its own node_modules keeps it');

  const noCoverage = await HARNESSES.nodeTest.plan({ worktreeDir: wt, changedFiles: ['src/a.js'], grep: async () => [], repoRoot: repo });
  assert.deepEqual(noCoverage.commands, []);
  assert.ok(noCoverage.notRun.includes('no test file covers the changed files'));
});

test('tokenfold plan: the script-style suite run from core/ with PYTHONPATH set to .', async (t) => {
  const wt = tempDir(t, {});
  const plan = await HARNESSES.tokenfoldCore.plan({ worktreeDir: wt, changedFiles: ['core/tokenfold/adapters/proxy.py', 'web/app.js'] });
  assert.deepEqual(plan.commands, [{ what: 'tokenfold core tests', file: 'python3', args: ['tests/test_core.py'], cwd: path.join(wt, 'core'), env: { PYTHONPATH: '.' } }]);
  assert.ok(plan.notRun.some((l) => /web\/app\.js/.test(l)));
});

test('python-src-tests plan: unittest discover over tests/ with PYTHONPATH set to src', async (t) => {
  const wt = tempDir(t, {});
  const plan = await HARNESSES.pythonSrcTests.plan({ worktreeDir: wt, changedFiles: ['src/pkg/a.py'] });
  assert.deepEqual(plan.commands, [{ what: 'python tests (unittest discover -s tests)', file: 'python3', args: ['-m', 'unittest', 'discover', '-s', 'tests'], cwd: wt, env: { PYTHONPATH: 'src' } }]);
  assert.deepEqual(plan.notRun, []);
});

test('python-venv-flat plan: the project interpreter, changed tests and test_<module>.py named for a changed module, grouped by directory', async (t) => {
  const repo = tempDir(t, {});
  const wt = tempDir(t, {
    'python/dashboard/test_routes.py': '', 'python/dashboard/test_cache.py': '', 'python/dashboard/test_other.py': '', 'python/dashboard/routes.py': '', 'python/dashboard/cache.py': '',
    'test_top.py': '', 'top.py': '',
  });
  const plan = await HARNESSES.pythonVenvFlat.plan({ worktreeDir: wt, changedFiles: ['python/dashboard/routes.py', 'python/dashboard/test_cache.py', 'top.py'], repoRoot: repo });
  const py = path.join(repo, '.venv', 'bin', 'python');
  assert.deepEqual(plan.commands.map((c) => [c.file, c.args, c.cwd]), [
    [py, ['-m', 'unittest', 'test_cache', 'test_routes'], path.join(wt, 'python/dashboard')],
    [py, ['-m', 'unittest', 'test_top'], wt],
  ].sort((a, b) => plan.commands.findIndex((c) => c.cwd === a[2]) - plan.commands.findIndex((c) => c.cwd === b[2])));
  assert.equal(plan.commands.length, 2);
  assert.ok(!plan.commands.some((c) => c.args.includes('test_other')), 'a test nobody changed or named for a changed module is not run');
});

test('python-venv-flat plan: with no test named for the change a small suite runs whole, a large one is reported and not run, and the cap names the rest', async (t) => {
  const repo = tempDir(t, {});
  const small = tempDir(t, { 'test_a.py': '', 'test_b.py': '', 'lib.py': '' });
  const ps = await HARNESSES.pythonVenvFlat.plan({ worktreeDir: small, changedFiles: ['lib.py'], repoRoot: repo });
  assert.equal(ps.commands.length, 1);
  assert.deepEqual(ps.commands[0].args, ['-m', 'unittest', 'discover', '-p', 'test_*.py']);

  const spread = { 'lib.py': '', 'test_7.py': '' };
  for (let i = 1; i <= 6; i++) spread[`python/d${i}/test_${i}.py`] = '';
  const spreadDir = tempDir(t, spread);
  // a filesystem whose listings come back in reverse order: the answer must not depend on the order a directory happens to list
  const reversed = { ...fs, readdirSync: (d, o) => fs.readdirSync(d, o).slice().reverse() };
  const pp = await HARNESSES.pythonVenvFlat.plan({ worktreeDir: spreadDir, changedFiles: ['lib.py'], repoRoot: repo, fsLike: reversed });
  assert.equal(pp.commands[0].cwd, path.join(spreadDir, 'python/d1'), 'the whole-suite run is rooted at the first test file in sorted order, whatever order the directory lists');
  assert.ok(ps.notRun.includes('no test file is named for the changed files: ran the whole suite'));

  const bigFiles = { 'lib.py': '' };
  for (let i = 0; i <= SMALL_SUITE_FILES; i++) bigFiles[`test_${i}.py`] = '';
  const big = tempDir(t, bigFiles);
  const pb = await HARNESSES.pythonVenvFlat.plan({ worktreeDir: big, changedFiles: ['lib.py'], repoRoot: repo });
  assert.deepEqual(pb.commands, []);
  assert.match(pb.notRun[0], /too large to run whole/);

  const capFiles = {};
  const changed = [];
  for (let i = 0; i < 14; i++) { capFiles[`test_m${String(i).padStart(2, '0')}.py`] = ''; changed.push(`test_m${String(i).padStart(2, '0')}.py`); }
  const capped = tempDir(t, capFiles);
  const pc = await HARNESSES.pythonVenvFlat.plan({ worktreeDir: capped, changedFiles: changed, maxTestFiles: 12, repoRoot: repo });
  assert.equal(pc.commands[0].args.length, 2 + 12);
  assert.match(pc.notRun[0], /^2 more covering test files not run: test_m12\.py, test_m13\.py$/);
});

test('end to end: a real node test that passes gives testsRun true and a green tests entry; the same change that breaks it gives a red one with the output tail', async (t) => {
  const root = makeRepo(t, { 'package.json': '{"name":"t","version":"1.0.0"}', 'src/a.js': 'module.exports = () => 1;\n', 'src/a.test.js': NODE_TEST });
  const good = await check(root, branchWith(root, { 'src/a.js': 'module.exports = () => 1;\n// touched\n' }));
  assert.equal(good.harness, 'node-test');
  assert.equal(good.testsRun, true);
  const ge = good.checked.find((c) => c.kind === 'tests');
  assert.equal(ge.ok, true, ge.summary);
  assert.match(ge.command, /^node --test src\/a\.test\.js$/);

  const root2 = makeRepo(t, { 'package.json': '{"name":"t","version":"1.0.0"}', 'src/a.js': 'module.exports = () => 1;\n', 'src/a.test.js': NODE_TEST });
  const bad = await check(root2, branchWith(root2, { 'src/a.js': 'module.exports = () => 2;\n' }));
  const be = bad.checked.find((c) => c.kind === 'tests');
  assert.equal(be.ok, false);
  assert.match(be.summary, /^exit 1: not ok 1 - a/, 'the broken test is named first, not buried under the stack trace tail');
  assert.equal(bad.testsRun, true);
});

test('end to end: a real python3 unittest run through the src and tests layout, green and red', async (t) => {
  const layout = { 'src/pkg/__init__.py': 'def f():\n    return 1\n', 'tests/test_a.py': PY_TEST };
  const root = makeRepo(t, layout);
  const good = await check(root, branchWith(root, { 'src/pkg/__init__.py': 'def f():\n    return 1\n\n\nX = 1\n' }));
  assert.equal(good.harness, 'python-src-tests');
  assert.equal(good.checked.find((c) => c.kind === 'tests').ok, true);

  const root2 = makeRepo(t, layout);
  const bad = await check(root2, branchWith(root2, { 'src/pkg/__init__.py': 'def f():\n    return 2\n' }));
  const be = bad.checked.find((c) => c.kind === 'tests');
  assert.equal(be.ok, false);
  assert.match(be.summary, /^exit 1: FAIL: test_f/);
  assert.match(be.summary, /FAILED \(failures=1\)/, 'and the unittest verdict line is still in the tail');
});

test('end to end: a mixed JavaScript and Python branch runs the JavaScript tests and names the Python files it did not test; an unrecognised repo is not a pass', async (t) => {
  const root = makeRepo(t, { 'package.json': '{}', 'src/a.js': 'module.exports = () => 1;\n', 'src/a.test.js': NODE_TEST, 'tools/x.py': 'X = 1\n' });
  const mixed = await check(root, branchWith(root, { 'src/a.js': 'module.exports = () => 1;\n// t\n', 'tools/x.py': 'X = 2\n' }));
  assert.equal(mixed.harness, 'node-test');
  assert.ok(mixed.notRun.some((l) => /does not run tests for: tools\/x\.py/.test(l)));

  const bare = makeRepo(t, { 'notes.txt': 'a', 'tool.sh': 'echo a\n' });
  const r = await check(bare, branchWith(bare, { 'tool.sh': 'echo b\n' }));
  assert.equal(r.testsRun, false);
  assert.equal(r.harness, null);
  assert.ok(r.notRun.includes('no test harness recognised for this repo'));

  const explicit = await check(root, mixed.headSha, { harnesses: [] });
  assert.equal(explicit.testsRun, false);
});

test('the engine hands every harness the project checkout and the branch\'s changed files, and runs the default harnesses when none are given', async (t) => {
  const root = makeRepo(t, { 'src/a.js': 'module.exports = 1;\n', 'notes.txt': 'a' });
  const sha = branchWith(root, { 'src/a.js': 'module.exports = 2;\n', 'notes.txt': 'b' });
  const seen = {};
  const spy = {
    id: 'spy',
    detect: (dir, fsl, ctx) => { seen.detect = { dir: typeof dir, fsHasReaddir: typeof fsl.readdirSync, ctx }; return true; },
    plan: async (args) => { seen.plan = args; return { commands: [], notRun: [] }; },
  };
  await check(root, sha, { harnesses: [spy] });
  assert.equal(seen.detect.ctx.repoRoot, root);
  assert.deepEqual(seen.detect.ctx.changedFiles.slice().sort(), ['notes.txt', 'src/a.js']);
  assert.equal(seen.detect.fsHasReaddir, 'function');
  assert.equal(seen.plan.repoRoot, root);
  assert.deepEqual(seen.plan.changedFiles.slice().sort(), ['notes.txt', 'src/a.js']);
  assert.equal(seen.plan.maxTestFiles, 12);
  assert.equal(typeof seen.plan.grep, 'function');
  assert.ok(fs.existsSync(path.dirname(seen.plan.worktreeDir)) && !fs.existsSync(seen.plan.worktreeDir), 'the worktree it was planned in is gone afterwards');
  const grepHits = await check(root, sha, { harnesses: [{ id: 'grep', detect: () => true, plan: async ({ grep }) => { seen.hits = await grep('module.exports', '*.js'); return { commands: [], notRun: [] }; } }] });
  assert.ok(grepHits);
  assert.deepEqual(seen.hits, ['src/a.js'], 'the grep given to a plan searches the branch worktree with git grep');
});

