'use strict';

// scripts/sweep-idle-cost.js measures one idle pass of each watchdog sweep with the queue-events journal off and on (ADR-0024, HUB0330 piece 7).
// Run: node --test scripts/sweep-idle-cost.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const { measure, buildFixture } = require('./sweep-idle-cost.js');
const fs = require('fs');

const SWEEPS = ['redo-supersede', 'branch-defect-readmit', 'branch-conflict-readmit'];

test('six rows: each of the three sweeps in both modes, with the documented fields', async () => {
  const r = await measure({ count: 40 });
  assert.equal(r.count, 40);
  assert.equal(r.sweeps.length, 6);
  for (const sweep of SWEEPS) for (const mode of ['off', 'journal']) {
    const row = r.sweeps.find((x) => x.sweep === sweep && x.mode === mode);
    assert.ok(row, `${sweep} ${mode}`);
    assert.deepEqual(Object.keys(row).sort(), ['mode', 'ms', 'readFile', 'readdir', 'sweep']);
    assert.ok(Number.isFinite(row.ms) && row.ms >= 0);
  }
});

test('journal mode: an idle pass lists done/ zero times for all three sweeps, and the off mode lists it at least once and reads every task', async () => {
  const r = await measure({ count: 40 });
  for (const sweep of SWEEPS) {
    const off = r.sweeps.find((x) => x.sweep === sweep && x.mode === 'off');
    const on = r.sweeps.find((x) => x.sweep === sweep && x.mode === 'journal');
    assert.equal(on.readdir, 0, `${sweep}: the idle journal pass made no directory listing`);
    assert.ok(off.readdir >= 1, `${sweep}: the old full scan lists done/`);
    assert.ok(off.readFile >= 40, `${sweep}: the old full scan reads every task (${off.readFile})`);
    assert.ok(on.readFile < 10, `${sweep}: the idle journal pass reads almost nothing (${on.readFile})`);
  }
});

test('the fixture is a realistic mix and is removed afterwards', async () => {
  const fx = buildFixture(30);
  try {
    const names = fs.readdirSync(path.join(fx.root, 'queue', 'done'));
    assert.equal(names.length, 30);
    const tasks = names.map((n) => JSON.parse(fs.readFileSync(path.join(fx.root, 'queue', 'done', n), 'utf8')));
    assert.equal(tasks.filter((t) => t.terminalDisposition === 'pending-merge' && t.history[0].stage === 'applied').length, 10);
    assert.equal(tasks.filter((t) => t.promptContext && t.promptContext.redoOf).length, 10);
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }); }
  const before = fs.readdirSync(require('os').tmpdir()).filter((n) => n.startsWith('sweep-idle-cost-')).length;
  await measure({ count: 12 });
  const after = fs.readdirSync(require('os').tmpdir()).filter((n) => n.startsWith('sweep-idle-cost-')).length;
  assert.equal(after, before, 'measure() leaves no temp directory behind');
});

test('CLI: --count N prints one JSON object with that count and six rows', () => {
  const r = spawnSync('node', [path.join(__dirname, 'sweep-idle-cost.js'), '--count', '12'], { encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.count, 12);
  assert.equal(out.sweeps.length, 6);
});
