'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('./carry-task.js');

const CLI = path.join(__dirname, 'carry-task.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'carry-task-test-'));
}

function writeJson(dir, name, obj) {
  const fp = path.join(dir, name);
  fs.writeFileSync(fp, JSON.stringify(obj, null, 2));
  return fp;
}

function writeScript(dir, name, body) {
  const fp = path.join(dir, name);
  fs.writeFileSync(fp, body);
  return fp;
}

function runCli(args, { cwd, env } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    cwd: cwd || process.cwd(),
    env: { ...process.env, ...(env || {}) },
  });
}

const CLEAN_SUMMARY = 'RESOLUTION: implemented\nAcceptance:\n- tests pass -- ran node --test -- PASS 0 fail\n';

test('prepare: stale failure grounding is refused, record untouched (through the CLI)', () => {
  const dir = tmpDir();
  const rec = writeJson(dir, 'r.json', { id: 'X1', status: 'drafting', draftAttempts: 2, history: [] });
  const before = fs.readFileSync(rec, 'utf8');
  const stale = writeScript(dir, 'stale.js',
    "process.stdout.write('ls: cannot access accounts.py: No such file');\n");
  const r = runCli(['prepare', rec], { env: { CARRY_TASK_GROUNDING_SCRIPT: stale } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /cannot access/);
  assert.equal(fs.readFileSync(rec, 'utf8'), before);
});

test('prepare: clean grounding strips stale fields, truncates details, appends draft-started', () => {
  const dir = tmpDir();
  const big = 'x'.repeat(5000);
  const rec = writeJson(dir, 'r.json', {
    id: 'X2', status: 'drafting', draftAttempts: 3, claimedAt: 'now', localVotes: [], blockedReason: 'old',
    history: [{ stage: 'drafted', at: '2026-10-31T00:00:00Z', details: big }],
  });
  const clean = writeScript(dir, 'clean.js', "process.stdout.write('grounding ok');\n");
  const r = runCli(['prepare', rec], { env: { CARRY_TASK_GROUNDING_SCRIPT: clean } });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(fs.readFileSync(rec, 'utf8'));
  for (const f of ['draftAttempts', 'claimedAt', 'localVotes', 'blockedReason']) assert.equal(f in out, false);
  assert.ok(out.history[0].details.length < big.length);
  assert.equal(out.history[out.history.length - 1].stage, 'draft-started');
});

test('check: "0 fail" result line warns and exits nonzero (CLI)', () => {
  const dir = tmpDir();
  const rec = writeJson(dir, 'r.json', { id: 'X3', implementResponse: CLEAN_SUMMARY.replace('PASS 0 fail', '0 fail') });
  const r = runCli(['check', rec]);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /WARNING/);
});

test('check: PASS with "0 fail" does not warn', () => {
  const { warnings } = lib.checkRecord({ implementResponse: 'Acceptance:\n- x -- ran -- PASS 0 fail\n' });
  assert.deepEqual(warnings.filter((w) => /fail/.test(w)), []);
});

test('check: stated count with no backing number warns', () => {
  const { warnings } = lib.checkRecord({ implementResponse: 'Acceptance:\n- mutations -- ran -- PASS\nwe killed 7 mutations\n' });
  assert.ok(warnings.some((w) => /7 mutations/.test(w)));
});

test('review: reviewer called once with lane; fallback to unleased lane on failure', async () => {
  const dir = tmpDir();
  const rec = writeJson(dir, 'r.json', { id: 'X4' });
  const calls = [];
  const reviewer = async (task, opts) => {
    calls.push(opts.lane);
    return calls.length === 1 ? { succeeded: false } : { succeeded: true, verdict: 'approved' };
  };
  const res = await lib.reviewRecord(rec, { lane: 'auto', reviewer });
  assert.deepEqual(calls, ['auto', null]);
  assert.equal(res.verdict, 'approved');
});

test('place: non-approved record refused (CLI)', () => {
  const dir = tmpDir();
  const rec = writeJson(dir, 'r.json', { id: 'X5', status: 'review' });
  const r = runCli(['place', rec], { cwd: dir });
  assert.notEqual(r.status, 0);
  assert.equal(fs.existsSync(path.join(dir, 'queue', 'approved', 'X5.json')), false);
});

test('place: approved record copied and live adhoc copy removed', () => {
  const dir = tmpDir();
  const rec = writeJson(dir, 'r.json', { id: 'X6', status: 'approved' });
  fs.mkdirSync(path.join(dir, 'queue', 'adhoc'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'queue', 'adhoc', 'X6.json'), '{}');
  const res = lib.placeRecord(rec, { root: dir });
  assert.equal(res.ok, true);
  assert.equal(fs.existsSync(path.join(dir, 'queue', 'approved', 'X6.json')), true);
  assert.equal(fs.existsSync(path.join(dir, 'queue', 'adhoc', 'X6.json')), false);
});
