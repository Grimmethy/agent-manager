'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { outcomesFromLedger } = require('./farm-trial-ledger.js');
const { scoreTrial } = require('./farm-trial.js');

const row = (taskId, extra) => ({ taskId, nodeId: 'grimm', leasedAt: '2026-11-15T00:00:00.000Z', expiresAt: '2026-11-15T01:00:00.000Z', state: 'lent', ...extra });

test('state or lastEvent merged maps to merged', () => {
  const r = outcomesFromLedger({ nodeId: 'grimm', taskIds: ['a', 'b'], leases: [row('a', { state: 'merged', mergedAt: 'x' }), row('b', { state: 'returned', lastEvent: 'merged' })] });
  assert.deepEqual(r.outcomes, [{ taskId: 'a', node: 'grimm', result: 'merged' }, { taskId: 'b', node: 'grimm', result: 'merged' }]);
  assert.deepEqual(r.pending, []);
  assert.deepEqual(r.missing, []);
});

test('lastEvent failed or blocked maps to failed, even while the lease is still lent', () => {
  const r = outcomesFromLedger({ nodeId: 'grimm', taskIds: ['a', 'b', 'c'], leases: [row('a', { lastEvent: 'failed' }), row('b', { lastEvent: 'blocked', state: 'returned' }), row('c', { lastEvent: 'failed', state: 'lent' })] });
  assert.deepEqual(r.outcomes.map((o) => o.result), ['failed', 'failed', 'failed']);
});

test('returned or expired without merged maps to abandoned', () => {
  const r = outcomesFromLedger({ nodeId: 'grimm', taskIds: ['a', 'b'], leases: [row('a', { state: 'returned', lastEvent: 'drafted' }), row('b', { state: 'expired' })] });
  assert.deepEqual(r.outcomes.map((o) => o.result), ['abandoned', 'abandoned']);
});

test('a lent row with no final event, or only a non-final event, is pending and left out of outcomes', () => {
  const r = outcomesFromLedger({ nodeId: 'grimm', taskIds: ['a', 'b'], leases: [row('a'), row('b', { lastEvent: 'drafted' })] });
  assert.deepEqual(r.outcomes, []);
  assert.deepEqual(r.pending, ['a', 'b']);
  assert.deepEqual(r.missing, []);
});

test('rows for another node are ignored, so their tasks are reported missing for this node', () => {
  const r = outcomesFromLedger({ nodeId: 'grimm', taskIds: ['a', 'x'], leases: [row('a', { state: 'merged' }), row('x', { nodeId: 'wok', state: 'merged' })] });
  assert.deepEqual(r.outcomes, [{ taskId: 'a', node: 'grimm', result: 'merged' }]);
  assert.deepEqual(r.missing, ['x']);
  assert.deepEqual(r.pending, []);
});

test('a taskId with no row at all is reported in missing', () => {
  const r = outcomesFromLedger({ nodeId: 'grimm', taskIds: ['nope'], leases: [] });
  assert.deepEqual(r, { outcomes: [], pending: [], missing: ['nope'] });
});

test('the outcomes pass scoreTrial without throwing', () => {
  const r = outcomesFromLedger({ nodeId: 'grimm', taskIds: ['a', 'b', 'c'], leases: [row('a', { state: 'merged' }), row('b', { lastEvent: 'failed' }), row('c', { state: 'expired' })] });
  const s = scoreTrial(r.outcomes);
  assert.equal(s.total, 3);
  assert.equal(s.clean, 1);
});

function ledgerDir(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-trial-ledger-'));
  const byTask = {};
  for (const r of rows) byTask[r.taskId] = r;
  fs.writeFileSync(path.join(dir, 'leases.json'), JSON.stringify(byTask));
  return dir;
}

function cli(args, dir) {
  return spawnSync(process.execPath, [path.join(__dirname, 'farm-trial-ledger.js'), ...args], { encoding: 'utf8', env: { ...process.env, AGENT_MANAGER_NODES_DIR: dir } });
}

test('the CLI exits 0 and writes the --out array when every task resolves', () => {
  const dir = ledgerDir([row('a', { state: 'merged' }), row('b', { lastEvent: 'failed' })]);
  try {
    const out = path.join(dir, 'out.json');
    const res = cli(['--node', 'grimm', '--tasks', 'a,b', '--out', out], dir);
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), [{ taskId: 'a', node: 'grimm', result: 'merged' }, { taskId: 'b', node: 'grimm', result: 'failed' }]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the CLI exits 3 when a task is pending or missing', () => {
  const dir = ledgerDir([row('a', { state: 'merged' }), row('c')]);
  try {
    assert.equal(cli(['--node', 'grimm', '--tasks', 'a,c'], dir).status, 3);
    assert.equal(cli(['--node', 'grimm', '--tasks', 'a,zzz'], dir).status, 3);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the CLI exits 2 on usage errors', () => {
  const dir = ledgerDir([row('a', { state: 'merged' })]);
  try {
    assert.equal(cli([], dir).status, 2);
    assert.equal(cli(['--node', 'grimm'], dir).status, 2);
    assert.equal(cli(['--tasks', 'a'], dir).status, 2);
    assert.equal(cli(['--node', 'grimm', '--tasks', 'a', '--bogus', 'x'], dir).status, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
