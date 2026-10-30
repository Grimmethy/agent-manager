'use strict';

// Tests for branch-check-runner.js. Every repository here is a real temporary git repository built in the test, so the worktree lifecycle, the diff
// parsing and the static scans run against real git, and only the test harness (which would run a project's suite) is faked.
// Run: node --test src/branch-check-runner.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { runBranchCheck, defaultExec, docsOnlyPaths, addedLines, pythonNameIsBound } = require('./branch-check-runner.js');

// Git needs an identity to commit; passed as -c flags so nothing depends on the machine's git configuration.
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

function makeRepo(t, baseFiles) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-check-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  writeFiles(root, baseFiles);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  return root;
}

// A branch off main with the given changes (null deletes a file); main is checked out again afterwards, so the project's own tree is what a user would have.
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
const worktreeCount = (root) => git(root, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length;

// An exec that records every call and delegates to the real one, except for commands a test wants to fake.
function spyExec(fake = () => null) {
  const calls = [];
  const exec = async (file, args, o) => {
    calls.push({ file, args, cwd: o && o.cwd, env: o && o.env, timeoutMs: o && o.timeoutMs });
    const faked = fake(file, args, o);
    return faked || defaultExec(file, args, o);
  };
  return { exec, calls, scratchDir: () => { const add = calls.find((c) => c.file === 'git' && c.args.includes('worktree') && c.args.includes('add')); return add && add.args[add.args.length - 2]; } };
}

const fakeHarness = (commands, extra = {}) => ({ id: 'fake', detect: () => true, plan: async () => ({ commands, notRun: [] }), ...extra });
const oneCommand = [{ what: 'fake tests', file: 'fake-test-runner', args: ['--all'] }];

test('a branch that changes only docs and markdown is docsOnly and lists every changed file', async (t) => {
  const root = makeRepo(t, { 'README.md': 'a', 'docs/x.md': 'a', 'src/a.js': 'module.exports = 1;' });
  const sha = branchWith(root, { 'docs/x.md': 'b', 'README.md': 'b', 'Docs/new.txt': 'c' });
  const r = await check(root, sha);
  assert.equal(r.docsOnly, true);
  assert.deepEqual(r.changedFiles.slice().sort(), ['Docs/new.txt', 'README.md', 'docs/x.md']);
});

test('a branch that changes source is not docsOnly, and an empty change list is not docsOnly either', async (t) => {
  const root = makeRepo(t, { 'docs/x.md': 'a', 'src/a.js': 'module.exports = 1;' });
  const sha = branchWith(root, { 'src/a.js': 'module.exports = 2;', 'docs/x.md': 'b' });
  assert.equal((await check(root, sha)).docsOnly, false);
  assert.equal(docsOnlyPaths([]), false);
  assert.equal(docsOnlyPaths(['Docs/a.txt', 'x.MD']), true);
  assert.equal(docsOnlyPaths(['docs/a.md', 'src/b.js']), false);
});

test('the scratch worktree is gone afterwards: on success, when a harness throws and when a command times out', async (t) => {
  const root = makeRepo(t, { 'src/a.js': 'module.exports = 1;' });
  const sha = branchWith(root, { 'src/a.js': 'module.exports = 2;' });

  const ok = spyExec();
  await check(root, sha, { exec: ok.exec });
  assert.ok(ok.scratchDir(), 'the scratch directory was recorded');
  assert.equal(fs.existsSync(ok.scratchDir()), false);
  assert.equal(worktreeCount(root), 1);

  const threw = spyExec();
  const r1 = await check(root, sha, { exec: threw.exec, harnesses: [{ id: 'boom', detect: () => true, plan: async () => { throw new Error('plan exploded'); } }] });
  assert.match(r1.notRun.join(' | '), /plan exploded/);
  assert.equal(fs.existsSync(threw.scratchDir()), false);
  assert.equal(worktreeCount(root), 1);

  const slow = spyExec((file) => (file === 'fake-test-runner' ? { code: -1, stdout: '', stderr: '', timedOut: true } : null));
  const r2 = await check(root, sha, { exec: slow.exec, harnesses: [fakeHarness(oneCommand)] });
  assert.equal(r2.checked.find((c) => c.kind === 'tests').ok, false);
  assert.equal(fs.existsSync(slow.scratchDir()), false);
  assert.equal(worktreeCount(root), 1);
});

test('the project working tree and its HEAD are untouched', async (t) => {
  const root = makeRepo(t, { 'src/a.js': 'module.exports = 1;' });
  const sha = branchWith(root, { 'src/a.js': 'module.exports = 2;' });
  const before = { status: git(root, 'status', '--porcelain'), head: git(root, 'rev-parse', 'HEAD'), branch: git(root, 'branch', '--show-current'), file: fs.readFileSync(path.join(root, 'src/a.js'), 'utf8') };
  await check(root, sha);
  assert.deepEqual({ status: git(root, 'status', '--porcelain'), head: git(root, 'rev-parse', 'HEAD'), branch: git(root, 'branch', '--show-current'), file: fs.readFileSync(path.join(root, 'src/a.js'), 'utf8') }, before);
  assert.equal(before.status, '');
});

test('static scan: a Python module that now calls logger without binding it is red, naming file and line', async (t) => {
  const root = makeRepo(t, { 'pkg/proxy.py': 'def run(line):\n    try:\n        return int(line)\n    except Exception:\n        pass\n' });
  const sha = branchWith(root, { 'pkg/proxy.py': 'def run(line):\n    try:\n        return int(line)\n    except Exception as exc:\n        logger.error("bad line %r: %s", line, exc, exc_info=True)\n' });
  const r = await check(root, sha);
  const entry = r.checked.find((c) => c.what.startsWith('undefined logger'));
  assert.equal(entry.kind, 'static');
  assert.equal(entry.ok, false);
  assert.match(entry.summary, /pkg\/proxy\.py:5 uses logger/);
});

test('static scan: binding the name, or importing it, makes the same change green; import logging alone does not bind logger', async (t) => {
  const base = { 'pkg/proxy.py': 'def run(line):\n    return line\n' };
  const body = 'def run(line):\n    try:\n        return int(line)\n    except Exception as exc:\n        logger.error("bad %r", line)\n';
  const rootA = makeRepo(t, base);
  const shaA = branchWith(rootA, { 'pkg/proxy.py': `import logging\nlogger = logging.getLogger(__name__)\n\n${body}` });
  assert.equal((await check(rootA, shaA)).checked.find((c) => c.what.startsWith('undefined logger')).ok, true);
  const rootB = makeRepo(t, base);
  const shaB = branchWith(rootB, { 'pkg/proxy.py': `import logging\n\n${body}` });
  assert.equal((await check(rootB, shaB)).checked.find((c) => c.what.startsWith('undefined logger')).ok, false, 'import logging alone leaves logger unbound');
  const rootC = makeRepo(t, base);
  const shaC = branchWith(rootC, { 'pkg/proxy.py': `from pkg.log import logger\n\n${body}` });
  assert.equal((await check(rootC, shaC)).checked.find((c) => c.what.startsWith('undefined logger')).ok, true);
});

test('static scan: only lines the branch ADDS count, an older undefined use that the branch did not touch is not blamed on it', async (t) => {
  const root = makeRepo(t, { 'pkg/a.py': 'def f():\n    logger.warning("old and already broken")\n\ndef g():\n    return 1\n' });
  const sha = branchWith(root, { 'pkg/a.py': 'def f():\n    logger.warning("old and already broken")\n\ndef g():\n    return 2\n' });
  assert.equal((await check(root, sha)).checked.find((c) => c.what.startsWith('undefined logger')).ok, true);
});

test('static scan: a JavaScript file that adds a require of a file that does not exist is red; an existing one is green; a comment is ignored', async (t) => {
  const root = makeRepo(t, { 'src/a.js': 'module.exports = 1;\n', 'src/b.js': 'module.exports = 2;\n' });
  const bad = branchWith(root, { 'src/a.js': "const x = require('./missing');\nmodule.exports = x;\n" });
  const r = await check(root, bad);
  const e = r.checked.find((c) => c.what.startsWith('missing local require'));
  assert.equal(e.ok, false);
  assert.match(e.summary, /src\/a\.js:1 requires \.\/missing/);

  const rootB = makeRepo(t, { 'src/a.js': 'module.exports = 1;\n', 'src/b.js': 'module.exports = 2;\n', 'src/dir/index.js': 'module.exports = 3;\n' });
  const good = branchWith(rootB, { 'src/a.js': "// const y = require('./commented-out');\nconst x = require('./b.js');\nconst z = require('./dir');\nmodule.exports = [x, z];\n" });
  assert.equal((await check(rootB, good)).checked.find((c) => c.what.startsWith('missing local require')).ok, true);
});

test('a change to files that are neither Python nor JavaScript adds no static entry', async (t) => {
  const root = makeRepo(t, { 'notes.txt': 'a', 'data.json': '{}' });
  const sha = branchWith(root, { 'notes.txt': 'b', 'data.json': '{"a":1}' });
  assert.deepEqual((await check(root, sha)).checked, []);
});

test('with no harness the result says so and testsRun stays false, even when static scans ran', async (t) => {
  const root = makeRepo(t, { 'src/a.js': 'module.exports = 1;\n' });
  const sha = branchWith(root, { 'src/a.js': 'module.exports = 2;\n' });
  const r = await check(root, sha);
  assert.equal(r.testsRun, false);
  assert.equal(r.harness, null);
  assert.ok(r.checked.length >= 1 && r.checked.every((c) => c.kind === 'static'));
  assert.ok(r.notRun.includes('no test harness recognised for this repo'));
  assert.equal(r.headSha, sha);
  assert.match(r.checkedAt, /^\d{4}-\d\d-\d\dT/);
});

test('a harness command becomes a tests entry whose ok follows the exit code, with the output tail, and the harness notRun lines are kept', async (t) => {
  const root = makeRepo(t, { 'src/a.js': 'module.exports = 1;\n' });
  const sha = branchWith(root, { 'src/a.js': 'module.exports = 2;\n' });
  const harness = { id: 'fake', detect: () => true, plan: async () => ({ commands: oneCommand, notRun: ['3 more covering test files not run: a.test.js'] }) };

  const green = spyExec((file) => (file === 'fake-test-runner' ? { code: 0, stdout: 'pass 4\n', stderr: '', timedOut: false } : null));
  const rg = await check(root, sha, { exec: green.exec, harnesses: [harness] });
  const tg = rg.checked.find((c) => c.kind === 'tests');
  assert.equal(tg.ok, true);
  assert.equal(tg.command, 'fake-test-runner --all');
  assert.equal(rg.testsRun, true);
  assert.equal(rg.harness, 'fake');
  assert.ok(rg.notRun.includes('3 more covering test files not run: a.test.js'));

  const red = spyExec((file) => (file === 'fake-test-runner' ? { code: 1, stdout: 'not ok 2 - something broke', stderr: '', timedOut: false } : null));
  const tr = (await check(root, sha, { exec: red.exec, harnesses: [harness] })).checked.find((c) => c.kind === 'tests');
  assert.equal(tr.ok, false);
  assert.match(tr.summary, /exit 1: not ok 2 - something broke/);

  const slow = spyExec((file) => (file === 'fake-test-runner' ? { code: 0, stdout: 'looked fine', stderr: '', timedOut: true } : null));
  const ts = (await check(root, sha, { exec: slow.exec, harnesses: [harness], timeoutMs: 5000 })).checked.find((c) => c.kind === 'tests');
  assert.equal(ts.ok, false);
  assert.match(ts.summary, /timed out after 5 s/);
});

test('the first harness whose detect returns true is used, and one whose detect throws is skipped', async (t) => {
  const root = makeRepo(t, { 'src/a.js': 'module.exports = 1;\n' });
  const sha = branchWith(root, { 'src/a.js': 'module.exports = 2;\n' });
  const calls = [];
  const spy = spyExec((file) => { calls.push(file); return file === 'second-runner' ? { code: 0, stdout: '', stderr: '', timedOut: false } : null; });
  const r = await check(root, sha, {
    exec: spy.exec,
    harnesses: [
      { id: 'broken', detect: () => { throw new Error('cannot tell'); }, plan: async () => ({ commands: [], notRun: [] }) },
      { id: 'no', detect: () => false, plan: async () => ({ commands: [], notRun: [] }) },
      { id: 'second', detect: () => true, plan: async () => ({ commands: [{ what: 's', file: 'second-runner', args: [] }], notRun: [] }) },
      { id: 'third', detect: () => true, plan: async () => ({ commands: [{ what: 't', file: 'third-runner', args: [] }], notRun: [] }) },
    ],
  });
  assert.equal(r.harness, 'second');
  assert.ok(calls.includes('second-runner') && !calls.includes('third-runner'));
});

test('child processes get exactly PATH, LANG, TMPDIR and HOME, HOME and TMPDIR being the scratch directory the command runs in', async (t) => {
  const root = makeRepo(t, { 'src/a.js': 'module.exports = 1;\n' });
  const sha = branchWith(root, { 'src/a.js': 'module.exports = 2;\n' });
  const spy = spyExec((file) => (file === 'fake-test-runner' ? { code: 0, stdout: '', stderr: '', timedOut: false } : null));
  await check(root, sha, { exec: spy.exec, harnesses: [fakeHarness(oneCommand)] });
  const run = spy.calls.find((c) => c.file === 'fake-test-runner');
  assert.deepEqual(Object.keys(run.env).sort(), ['HOME', 'LANG', 'PATH', 'TMPDIR']);
  assert.equal(run.env.HOME, spy.scratchDir());
  assert.equal(run.env.TMPDIR, spy.scratchDir());
  assert.equal(run.cwd, spy.scratchDir());
  assert.notEqual(run.env.HOME, process.env.HOME);
});

test('a command-specific env is added on top of the minimal one, and the budget skips commands once it is used up', async (t) => {
  const root = makeRepo(t, { 'src/a.js': 'module.exports = 1;\n' });
  const sha = branchWith(root, { 'src/a.js': 'module.exports = 2;\n' });
  const spy = spyExec((file) => (file.endsWith('-runner') ? { code: 0, stdout: '', stderr: '', timedOut: false } : null));
  const commands = [
    { what: 'one', file: 'one-runner', args: [], env: { PYTHONPATH: '.' } },
    { what: 'two', file: 'two-runner', args: [] },
    { what: 'three', file: 'three-runner', args: [] },
  ];
  let tick = -100;
  const r = await check(root, sha, { exec: spy.exec, harnesses: [fakeHarness(commands)], budgetMs: 250, now: () => { tick += 100; return tick; } });
  assert.deepEqual(r.checked.filter((c) => c.kind === 'tests').map((c) => c.what), ['one', 'two']);
  assert.ok(r.notRun.some((l) => /budget/.test(l) && /three/.test(l)));
  assert.equal(spy.calls.find((c) => c.file === 'one-runner').env.PYTHONPATH, '.');
  assert.deepEqual(['one-runner', 'two-runner'].map((f) => spy.calls.find((c) => c.file === f).timeoutMs), [150, 50], 'each command gets the smaller of the timeout and what is left of the budget');
});

test('a head sha git does not know gives a result, not a rejection, and nothing is left behind', async (t) => {
  const root = makeRepo(t, { 'src/a.js': 'module.exports = 1;\n' });
  const spy = spyExec();
  const r = await check(root, 'f'.repeat(40), { exec: spy.exec });
  assert.deepEqual(r.checked, []);
  assert.equal(r.testsRun, false);
  assert.match(r.notRun[0], /scratch worktree/);
  assert.equal(worktreeCount(root), 1);
  const dir = spy.scratchDir();
  assert.equal(dir && fs.existsSync(dir), false);
  const missing = await runBranchCheck({});
  assert.match(missing.notRun[0], /required/);
});

test('helpers: addedLines reads line numbers from a -U0 diff; pythonNameIsBound tells assigned, imported and parameter names from a bare import', () => {
  const diff = ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -3,0 +4,2 @@', '+first', '+second', '@@ -9 +11 @@', '-gone', '+third'].join('\n');
  assert.deepEqual(addedLines(diff), [{ line: 4, text: 'first' }, { line: 5, text: 'second' }, { line: 11, text: 'third' }]);
  assert.equal(pythonNameIsBound('import logging\n', 'logger'), false);
  assert.equal(pythonNameIsBound('logger = logging.getLogger(__name__)\n', 'logger'), true);
  assert.equal(pythonNameIsBound('LOGGER = 1\n', 'logger'), false);
  assert.equal(pythonNameIsBound('from a.b import logger\n', 'logger'), true);
  assert.equal(pythonNameIsBound('def f(x, logger):\n    pass\n', 'logger'), true);
  assert.equal(pythonNameIsBound('self.logger = 1\n', 'logger'), false);
});

test('static scan: attribute access such as self.logger or app.log is not a use of the bare name', async (t) => {
  const root = makeRepo(t, { 'pkg/a.py': 'class A:\n    def f(self):\n        return 1\n' });
  const sha = branchWith(root, { 'pkg/a.py': 'class A:\n    def f(self):\n        self.logger.error("x")\n        app.log.info("y")\n        return 1\n' });
  assert.equal((await check(root, sha)).checked.find((c) => c.what.startsWith('undefined logger')).ok, true);
});

test('the changed files are what the BRANCH changed (three-dot diff), not what main gained after the branch left it', async (t) => {
  const root = makeRepo(t, { 'src/a.js': 'module.exports = 1;\n', 'src/other.js': 'module.exports = 1;\n' });
  const sha = branchWith(root, { 'src/a.js': 'module.exports = 2;\n' });
  writeFiles(root, { 'src/other.js': 'module.exports = 99;\n' });
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'main moved on');
  assert.deepEqual((await check(root, sha)).changedFiles, ['src/a.js']);
});

