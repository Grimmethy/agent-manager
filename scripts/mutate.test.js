'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { main } = require('./mutate.js');

const ORIGINAL = 'const value = 1;\nmodule.exports = value;\n';
const created = [];

after(() => {
  for (const d of created) fs.rmSync(d, { recursive: true, force: true });
});

// Fresh temp tree: <base>/fixture holds target.js and the spec; <base>/outside.js is a sibling.
function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mutate-test-'));
  created.push(base);
  const dir = path.join(base, 'fixture');
  fs.mkdirSync(dir);
  const target = path.join(dir, 'target.js');
  fs.writeFileSync(target, ORIGINAL);
  return { base, dir, target };
}

function writeSpec(dir, spec) {
  const p = path.join(dir, 'spec.json');
  fs.writeFileSync(p, JSON.stringify(spec));
  return p;
}

function captureIO() {
  const out = [];
  const err = [];
  return { out, err, stdout: (s) => out.push(s), stderr: (s) => err.push(s) };
}

function mutation(name, find, replace, file = 'target.js') {
  return { name, file, find, replace };
}

test('a mutation that makes the test fail is reported killed and the file is restored', async () => {
  const { dir, target } = setup();
  const spec = writeSpec(dir, { test: 'noop', mutations: [mutation('m1', 'value = 1', 'value = 2')] });
  const io = captureIO();
  const runTest = async () => ({
    code: fs.readFileSync(target, 'utf8').includes('value = 2') ? 1 : 0,
    timedOut: false,
  });
  const r = await main(spec, { runTest, stdout: io.stdout, stderr: io.stderr });
  assert.equal(r.exitCode, 0);
  assert.equal(r.summary.error, null);
  assert.equal(r.summary.counts.killed, 1);
  assert.equal(r.summary.results[0].status, 'killed');
  assert.equal(fs.readFileSync(target, 'utf8'), ORIGINAL);
});

test('a mutation that leaves the test passing is reported survived and the file is restored', async () => {
  const { dir, target } = setup();
  const spec = writeSpec(dir, { test: 'noop', mutations: [mutation('m1', 'value = 1', 'value = 2')] });
  const io = captureIO();
  const runTest = async () => ({ code: 0, timedOut: false });
  const r = await main(spec, { runTest, stdout: io.stdout, stderr: io.stderr });
  assert.equal(r.exitCode, 0);
  assert.equal(r.summary.counts.survived, 1);
  assert.equal(r.summary.results[0].status, 'survived');
  assert.equal(fs.readFileSync(target, 'utf8'), ORIGINAL);
});

async function runInapplicable(find) {
  const { dir, target } = setup();
  const marker = path.join(dir, 'mutant-ran');
  const spec = writeSpec(dir, { test: 'noop', mutations: [mutation('m1', find, 'REPLACED')] });
  const io = captureIO();
  let calls = 0;
  // Marker is created only if a mutated copy of target.js is ever under test.
  const runTest = async () => {
    calls++;
    if (fs.readFileSync(target, 'utf8') !== ORIGINAL) fs.writeFileSync(marker, 'x');
    return { code: 0, timedOut: false };
  };
  const r = await main(spec, { runTest, stdout: io.stdout, stderr: io.stderr });
  assert.equal(r.exitCode, 0);
  assert.equal(r.summary.counts.inapplicable, 1);
  assert.equal(r.summary.results[0].status, 'inapplicable');
  assert.equal(fs.existsSync(marker), false, 'mutant test command must never run');
  assert.equal(calls, 1, 'only the baseline run may execute');
  assert.equal(fs.readFileSync(target, 'utf8'), ORIGINAL);
  return r;
}

test('a find that occurs twice is inapplicable and the test command never runs', async () => {
  // ORIGINAL contains 'value' exactly twice.
  const r = await runInapplicable('value');
  assert.equal(r.summary.results[0].occurrences, 2);
});

test('a find that occurs zero times is inapplicable and the test command never runs', async () => {
  const r = await runInapplicable('nowhere-in-file');
  assert.equal(r.summary.results[0].occurrences, 0);
});

test('a thrown runner restores the file byte-for-byte and reports a fatal error', async () => {
  const { dir, target } = setup();
  const spec = writeSpec(dir, { test: 'noop', mutations: [mutation('m1', 'value = 1', 'value = 2')] });
  const io = captureIO();
  const runTest = async () => {
    if (fs.readFileSync(target, 'utf8') !== ORIGINAL) throw new Error('boom');
    return { code: 0, timedOut: false };
  };
  const r = await main(spec, { runTest, stdout: io.stdout, stderr: io.stderr });
  assert.equal(r.exitCode, 1);
  assert.match(r.summary.error, /boom/);
  assert.equal(fs.readFileSync(target, 'utf8'), ORIGINAL);
});

test('a real timeout kills the mutated run and the file is restored', async () => {
  const { dir, target } = setup();
  // Baseline (unmutated) exits immediately; the mutated copy hangs for 5s.
  fs.writeFileSync(path.join(dir, 'hang.js'),
    "const fs = require('fs');\n" +
    "const path = require('path');\n" +
    "if (fs.readFileSync(path.join(__dirname, 'target.js'), 'utf8').includes('value = 2')) {\n" +
    '  setTimeout(() => {}, 5000);\n' +
    '}\n');
  const cmd = `"${process.execPath}" hang.js`;
  const spec = writeSpec(dir, {
    test: cmd,
    timeoutMs: 300,
    mutations: [mutation('m1', 'value = 1', 'value = 2')],
  });
  const io = captureIO();
  const started = Date.now();
  const r = await main(spec, { stdout: io.stdout, stderr: io.stderr });
  const elapsed = Date.now() - started;
  assert.equal(r.exitCode, 0);
  assert.equal(r.summary.baseline.timedOut, false);
  assert.equal(r.summary.results[0].status, 'killed');
  assert.ok(elapsed < 4000, `timeout should cut the 5s hang short (took ${elapsed}ms)`);
  assert.equal(fs.readFileSync(target, 'utf8'), ORIGINAL);
});

test('a failing baseline aborts before any mutation and changes no files', async () => {
  const { dir, target } = setup();
  const spec = writeSpec(dir, { test: 'noop', mutations: [mutation('m1', 'value = 1', 'value = 2')] });
  const io = captureIO();
  let calls = 0;
  const runTest = async () => {
    calls++;
    return { code: 1, timedOut: false };
  };
  const r = await main(spec, { runTest, stdout: io.stdout, stderr: io.stderr });
  assert.equal(r.exitCode, 1);
  assert.match(r.summary.error, /baseline test failed/);
  assert.equal(r.summary.results.length, 0);
  assert.equal(calls, 1, 'only the baseline run may execute');
  assert.equal(fs.readFileSync(target, 'utf8'), ORIGINAL);
});

test('a spec with an empty find is rejected with no runs and no writes', async () => {
  const { dir, target } = setup();
  const spec = writeSpec(dir, { test: 'noop', mutations: [mutation('m1', '', 'x')] });
  const io = captureIO();
  let calls = 0;
  const runTest = async () => {
    calls++;
    return { code: 0, timedOut: false };
  };
  const r = await main(spec, { runTest, stdout: io.stdout, stderr: io.stderr });
  assert.equal(r.exitCode, 2);
  assert.equal(r.summary, null);
  assert.equal(calls, 0);
  assert.match(io.err.join(''), /find must be non-empty/);
  assert.equal(fs.readFileSync(target, 'utf8'), ORIGINAL);
});

test('a spec whose file escapes the cwd is rejected and nothing outside is written', async () => {
  const { base, dir, target } = setup();
  const outside = path.join(base, 'outside.js');
  fs.writeFileSync(outside, ORIGINAL);
  const spec = writeSpec(dir, { test: 'noop', mutations: [mutation('m1', 'value = 1', 'value = 2', '../outside.js')] });
  const io = captureIO();
  let calls = 0;
  const runTest = async () => {
    calls++;
    return { code: 0, timedOut: false };
  };
  const r = await main(spec, { runTest, stdout: io.stdout, stderr: io.stderr });
  assert.equal(r.exitCode, 2);
  assert.equal(r.summary, null);
  assert.equal(calls, 0);
  assert.match(io.err.join(''), /escapes cwd/);
  assert.equal(fs.readFileSync(outside, 'utf8'), ORIGINAL);
  assert.equal(fs.readFileSync(target, 'utf8'), ORIGINAL);
});
