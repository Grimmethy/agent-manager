'use strict';
// Tests for scripts/mutation-spot-check.js. Each case builds a real temp git
// repo with a tiny module and test, so nothing leaves the machine.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'mutation-spot-check.js');
const { run } = require(SCRIPT);

// Line 4 is a real code line with a trailing comment; line 2 is a pure comment.
const LIB = [
  "'use strict';",
  '// boundary: n >= max is capped',
  'function classify(n, max) {',
  '  if (n >= max) { // cap',
  "    return 'capped';",
  '  }',
  "  return 'ok';",
  '}',
  'module.exports = { classify };',
  '',
].join('\n');

const STRONG_CHECK = [
  "'use strict';",
  "const assert = require('assert');",
  "const { classify } = require('../lib.js');",
  "assert.strictEqual(classify(3, 3), 'capped');",
  "assert.strictEqual(classify(2, 3), 'ok');",
  "assert.strictEqual(classify(4, 3), 'capped');",
  '',
].join('\n');

// Skips the boundary case classify(3, 3), so the >= -> > mutant survives.
const WEAK_CHECK = STRONG_CHECK.replace("assert.strictEqual(classify(3, 3), 'capped');\n", '');

const TEST_CMD = `"${process.execPath}" test/check.js`;

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

function realGit(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { status: r.status === null ? 1 : r.status, stdout: r.stdout || '' };
}

function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

function commitAll(dir, message) {
  git(dir, ['add', '-A']);
  git(dir, [
    '-c', 'user.name=test', '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message,
  ]);
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

// Base commit holds only a README; the branch commit adds the module and tests.
function makeFixture(t, { check = WEAK_CHECK, lib = LIB, extra = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mss-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, ['init', '-q']);
  writeFiles(dir, { 'README.md': 'base\n' });
  const base = commitAll(dir, 'base');
  writeFiles(dir, { 'lib.js': lib, 'test/check.js': check, ...extra });
  commitAll(dir, 'branch');
  return { dir, base };
}

function runCli(dir, base, extraArgs = []) {
  const r = spawnSync(
    process.execPath,
    [SCRIPT, '--repo', dir, '--base', base, '--tests', TEST_CMD, ...extraArgs],
    { encoding: 'utf8', timeout: 120000 },
  );
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function reportOf(res) {
  return JSON.parse(res.stdout.trim());
}

test('a strong test kills the boundary mutant (survived 0)', { timeout: 120000 }, (t) => {
  const { dir, base } = makeFixture(t, { check: STRONG_CHECK });
  const res = runCli(dir, base);
  assert.equal(res.status, 0, res.stderr);
  const report = reportOf(res);
  assert.equal(report.total, 1);
  assert.equal(report.killed, 1);
  assert.equal(report.survived, 0);
  assert.deepEqual(report.survivors, []);
});

test('a weak test that skips the boundary reports a >= survivor on that line', { timeout: 120000 }, (t) => {
  const { dir, base } = makeFixture(t);
  const res = runCli(dir, base);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(reportOf(res).survivors, [{ file: 'lib.js', line: 4, op: '>=->>' }]);
});

test('the trailing-comment code line is still mutated and reported as a survivor', { timeout: 120000 }, (t) => {
  const { dir, base } = makeFixture(t);
  const report = reportOf(runCli(dir, base));
  assert.equal(LIB.split('\n')[3], '  if (n >= max) { // cap');
  assert.equal(report.survivors.length, 1);
  assert.equal(report.survivors[0].file, 'lib.js');
  assert.equal(report.survivors[0].line, 4);
  assert.equal(report.survivors[0].op, '>=->>');
});

test('comment lines and test files are never mutated', { timeout: 120000 }, (t) => {
  const { dir, base } = makeFixture(t, { extra: { 'lib.test.js': 'if (a >= b) { return 1; }\n' } });
  const res = runCli(dir, base);
  assert.equal(res.status, 0, res.stderr);
  const report = reportOf(res);
  // Only lib.js line 4 is a mutable code line: line 2 is a comment, and
  // lib.test.js and test/check.js are test files.
  assert.equal(report.total, 1);
  for (const s of report.survivors) {
    assert.equal(s.file, 'lib.js');
    assert.notEqual(s.line, 2);
  }
});

test('a failing baseline exits 3 and leaves the module byte-identical', { timeout: 120000 }, (t) => {
  const { dir, base } = makeFixture(t, { check: 'process.exit(1);\n' });
  const before = fs.readFileSync(path.join(dir, 'lib.js'));
  const res = runCli(dir, base);
  assert.equal(res.status, 3);
  assert.match(res.stderr, /baseline tests fail/);
  assert.ok(fs.readFileSync(path.join(dir, 'lib.js')).equals(before));
});

test('--max caps the number of mutants', { timeout: 120000 }, (t) => {
  const more = [1, 2, 3, 4, 5].map((i) => `const f${i} = (x) => x >= ${i};`).join('\n') + '\n';
  const { dir, base } = makeFixture(t, { extra: { 'more.js': more } });
  const uncapped = reportOf(runCli(dir, base));
  assert.equal(uncapped.total, 6);
  const res = runCli(dir, base, ['--max', '2']);
  assert.equal(res.status, 0, res.stderr);
  const report = reportOf(res);
  assert.equal(report.total, 2);
  assert.equal(report.killed + report.survived, 2);
});

test('a normal run leaves every file byte-identical and the tree unchanged', { timeout: 120000 }, (t) => {
  const { dir, base } = makeFixture(t);
  const files = ['lib.js', 'test/check.js'];
  const before = files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));
  const statusBefore = git(dir, ['status', '--porcelain']);
  const res = runCli(dir, base);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')), before);
  assert.equal(git(dir, ['status', '--porcelain']), statusBefore);
});

test('a run that leaves a file rewritten exits 4 with TREE NOT RESTORED', { timeout: 120000 }, (t) => {
  const { dir, base } = makeFixture(t);
  let calls = 0;
  const deps = {
    git: realGit,
    run(cmd, cwd) {
      calls++;
      // Call 1 is the baseline; later mutant runs rewrite a file the tool never restores.
      if (calls > 1) fs.writeFileSync(path.join(cwd, 'README.md'), 'rewritten\n');
      return { status: 0, timedOut: false };
    },
  };
  const result = run({ repo: dir, base, tests: TEST_CMD, max: 12, timeoutMs: 60000 }, deps);
  assert.equal(result.exitCode, 4);
  assert.equal(result.message, 'TREE NOT RESTORED');
});

test('a timed-out mutant counts as killed', { timeout: 120000 }, (t) => {
  // Weak fixture: without the timeout the single mutant would survive.
  const { dir, base } = makeFixture(t);
  let calls = 0;
  const deps = {
    git: realGit,
    run() {
      calls++;
      return calls === 1 ? { status: 0, timedOut: false } : { status: 1, timedOut: true };
    },
  };
  const result = run({ repo: dir, base, tests: TEST_CMD, max: 12, timeoutMs: 1000 }, deps);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.report, { killed: 1, survived: 0, total: 1, survivors: [] });
});
