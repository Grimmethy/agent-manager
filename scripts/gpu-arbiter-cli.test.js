'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, 'gpu-arbiter-cli.js');

function runCli(args, pipelineDir) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      AGENT_MANAGER_REPO_ROOT: pipelineDir,
      AGENT_MANAGER_PIPELINE_DIR: pipelineDir,
      LOCAL_MODEL: 'test-model',
    },
  });
}

function tmpPipeline() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'arb-cli-'));
  fs.mkdirSync(path.join(d, 'instances'), { recursive: true });
  return d;
}

function writeTicket(pipelineDir, model, name, obj) {
  const dir = path.join(pipelineDir, 'instances', '.gpu-tickets.' + model.replace(/[^A-Za-z0-9._-]+/g, '_'));
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, name);
  fs.writeFileSync(fp, JSON.stringify(obj));
  return fp;
}

test('cancel-below marks a lower-class ticket cancelRequested', () => {
  const pd = tmpPipeline();
  // a live-pid draft ticket (this test process, so pidAlive() is true and it won't be swept)
  const fp = writeTicket(pd, 'test-model', '0000000000000001.' + process.pid + '.a.json',
    { pid: process.pid, cls: 'draft', taskId: 't1', holding: false });

  const r = runCli(['cancel-below', '--cls', 'interactive'], pd);
  assert.equal(r.status, 0, r.stderr);
  const rows = JSON.parse(r.stdout);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cls, 'draft');
  assert.equal(rows[0].action, 'cancel-marked');
  assert.equal(JSON.parse(fs.readFileSync(fp, 'utf8')).cancelRequested, true);
});

test('cancel-below leaves an equal/higher class alone', () => {
  const pd = tmpPipeline();
  writeTicket(pd, 'test-model', '0000000000000001.' + process.pid + '.b.json',
    { pid: process.pid, cls: 'interactive', taskId: 'chat', holding: false });
  const r = runCli(['cancel-below', '--cls', 'interactive'], pd);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), []);
});

test('status reports the holder and waiters', () => {
  const pd = tmpPipeline();
  writeTicket(pd, 'test-model', '0000000000000001.' + process.pid + '.h.json',
    { pid: process.pid, cls: 'review', taskId: 'rv', holding: true });
  writeTicket(pd, 'test-model', '0000000000000002.' + process.pid + '.w.json',
    { pid: process.pid, cls: 'draft', taskId: 'w1', holding: false });
  const r = runCli(['status'], pd);
  assert.equal(r.status, 0, r.stderr);
  const st = JSON.parse(r.stdout);
  assert.equal(st.holder.cls, 'review');
  assert.ok(st.waiting.some((w) => w.cls === 'draft' && w.taskId === 'w1'));
});

test('unknown subcommand exits non-zero with a usage line', () => {
  const pd = tmpPipeline();
  const r = runCli(['frobnicate'], pd);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /usage:/);
});
