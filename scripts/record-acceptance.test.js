'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseAcceptanceBlock } = require('../src/acceptance-criteria.js');

const CLI = path.join(__dirname, 'record-acceptance.js');

function runRecorder(args, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    cwd,
    env: process.env,
  });
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'record-acceptance-test-'));
}

function writeFile(dir, name, content) {
  const fp = path.join(dir, name);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, content);
  return fp;
}

function readLog(out) {
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}

// Fake test script whose TAP-style summary reports the given counts and exit code.
function writeFakeTests(dir, name, { pass, fail }) {
  const body = `console.log('# tests ${pass + fail}');\nconsole.log('# pass ${pass}');\nconsole.log('# fail ${fail}');\nprocess.exit(${fail > 0 ? 1 : 0});\n`;
  return writeFile(dir, name, body);
}

test('run records exit code and counts for passing and failing commands', () => {
  const dir = tmpDir();
  const out = path.join(dir, 'log.json');
  const passScript = writeFakeTests(dir, 'pass.js', { pass: 2, fail: 0 });
  const failScript = writeFakeTests(dir, 'fail.js', { pass: 1, fail: 1 });

  const r1 = runRecorder(['run', 'pass-check', '--out', out, '--', process.execPath, passScript], dir);
  assert.equal(r1.status, 0, `run pass exited ${r1.status}: ${r1.stderr}`);
  const r2 = runRecorder(['run', 'fail-check', '--out', out, '--', process.execPath, failScript], dir);
  assert.equal(r2.status, 1, `run fail exited ${r2.status}: ${r2.stderr}`);

  const log = readLog(out);
  assert.equal(log.length, 2);
  assert.equal(log[0].label, 'pass-check');
  assert.equal(log[0].exitCode, 0);
  assert.deepEqual(log[0].counts, { tests: 2, pass: 2, fail: 0 });
  assert.equal(log[0].timedOut, false);
  assert.equal(log[1].label, 'fail-check');
  assert.equal(log[1].exitCode, 1);
  assert.deepEqual(log[1].counts, { tests: 2, pass: 1, fail: 1 });
});

test('mutate kills a failing check and lets a passing check survive', () => {
  const dir = tmpDir();
  const out = path.join(dir, 'log.json');
  const target = writeFile(dir, 'app.js', 'function hello() { return "original"; }');

  // Fails once the mutation is applied, so the mutation is killed.
  const killer = writeFile(dir, 'killer.js',
    `const fs = require('fs');\nprocess.exit(fs.readFileSync(${JSON.stringify(target)}, 'utf8').includes('original') ? 0 : 1);\n`);
  // Always passes, so the mutation survives.
  const survivor = writeFile(dir, 'survivor.js', 'process.exit(0);\n');

  const r1 = runRecorder(['mutate', 'kill-check', '--file', target, '--sed', 's/original/mutated/', '--out', out, '--', process.execPath, killer], dir);
  assert.equal(r1.status, 0, `mutate killed exited ${r1.status}: ${r1.stderr}`);
  const r2 = runRecorder(['mutate', 'survive-check', '--file', target, '--sed', 's/original/mutated/', '--out', out, '--', process.execPath, survivor], dir);
  assert.equal(r2.status, 0, `mutate survived exited ${r2.status}: ${r2.stderr}`);

  const log = readLog(out);
  assert.equal(log[0].kind, 'mutation');
  assert.equal(log[0].result, 'killed');
  assert.equal(log[1].kind, 'mutation');
  assert.equal(log[1].result, 'survived');
});

test('file is restored byte-for-byte even when the test command fails', () => {
  const dir = tmpDir();
  const out = path.join(dir, 'log.json');
  const original = Buffer.from('const x = "original";\r\nno trailing newline');
  const target = path.join(dir, 'app.js');
  fs.writeFileSync(target, original);
  const failing = writeFile(dir, 'fail.js', 'process.exit(1);\n');

  const r = runRecorder(['mutate', 'restore-check', '--file', target, '--sed', 's/original/mutated/', '--out', out, '--', process.execPath, failing], dir);
  assert.equal(r.status, 0, `mutate exited ${r.status}: ${r.stderr}`);

  const after = fs.readFileSync(target);
  assert.ok(after.equals(original), 'file must be restored byte-for-byte');
  assert.equal(readLog(out)[0].result, 'killed');
});

test('NOT APPLIED is reported when the sed expression changes nothing', () => {
  const dir = tmpDir();
  const out = path.join(dir, 'log.json');
  const target = writeFile(dir, 'app.js', 'const x = 1;\n');
  const testScript = writeFile(dir, 'test.js', 'process.exit(0);\n');

  const r = runRecorder(['mutate', 'no-op', '--file', target, '--sed', 's/zzz-absent-zzz/y/', '--out', out, '--', process.execPath, testScript], dir);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /NOT APPLIED: sed expression left .* unchanged/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'const x = 1;\n');
  assert.equal(fs.existsSync(out), false, 'nothing should be logged for a NOT APPLIED mutation');
});

test('render output parses through parseAcceptanceBlock: killed gives pass true, survivor gives pass false', () => {
  const dir = tmpDir();
  const out = path.join(dir, 'log.json');
  const target = writeFile(dir, 'app.js', 'function hello() { return "original"; }');
  const killer = writeFile(dir, 'killer.js',
    `const fs = require('fs');\nprocess.exit(fs.readFileSync(${JSON.stringify(target)}, 'utf8').includes('original') ? 0 : 1);\n`);
  const survivor = writeFile(dir, 'survivor.js', 'process.exit(0);\n');

  runRecorder(['mutate', 'kill-check', '--file', target, '--sed', 's/original/mutated/', '--out', out, '--', process.execPath, killer], dir);
  runRecorder(['mutate', 'survive-check', '--file', target, '--sed', 's/original/mutated/', '--out', out, '--', process.execPath, survivor], dir);

  const r = runRecorder(['render', '--out', out], dir);
  assert.equal(r.status, 0, `render exited ${r.status}: ${r.stderr}`);

  const parsed = parseAcceptanceBlock(r.stdout);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].criterion, 'kill-check');
  assert.equal(parsed[0].pass, true);
  assert.equal(parsed[1].criterion, 'survive-check');
  assert.equal(parsed[1].pass, false);
});

test('a survivor renders as FAIL', () => {
  const dir = tmpDir();
  const out = path.join(dir, 'log.json');
  const target = writeFile(dir, 'app.js', 'const x = "original";\n');
  const survivor = writeFile(dir, 'survivor.js', 'process.exit(0);\n');

  runRecorder(['mutate', 'survive-check', '--file', target, '--sed', 's/original/mutated/', '--out', out, '--', process.execPath, survivor], dir);

  const r = runRecorder(['render', '--out', out], dir);
  assert.equal(r.status, 0);
  const line = r.stdout.split('\n').find((l) => l.includes('survive-check'));
  assert.ok(line, 'rendered line for survivor should exist');
  assert.match(line, /-- FAIL$/);
  assert.doesNotMatch(line, /PASS/);
});
