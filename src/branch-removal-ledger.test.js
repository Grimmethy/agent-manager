'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { recordBranchRemoval, readLedger, lastRemoval, ledgerPath } = require('./branch-removal-ledger.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'brl-'));

test('records a removal and reads it back, normalising the branch spelling', () => {
  const d = tmp();
  assert.equal(recordBranchRemoval(d, { branch: 'origin/agent/x-1', taskId: 'x-1', cause: 'discarded', detail: 'nope', actor: 'dashboard-discard' }), true);
  const e = lastRemoval(d, 'agent/x-1');
  assert.equal(e.branch, 'agent/x-1');
  assert.equal(e.cause, 'discarded');
  assert.equal(e.actor, 'dashboard-discard');
  assert.equal(lastRemoval(d, 'refs/remotes/origin/agent/x-1').cause, 'discarded');
});

test('the LAST removal of a branch wins; other branches are untouched', () => {
  const d = tmp();
  recordBranchRemoval(d, { branch: 'agent/a', cause: 'discarded' });
  recordBranchRemoval(d, { branch: 'agent/b', cause: 'merged' });
  recordBranchRemoval(d, { branch: 'agent/a', cause: 'superseded-by-requeue' });
  assert.equal(lastRemoval(d, 'agent/a').cause, 'superseded-by-requeue');
  assert.equal(lastRemoval(d, 'agent/b').cause, 'merged');
  assert.equal(lastRemoval(d, 'agent/never'), null);
});

test('an unknown cause, a missing branch or a missing pipelineDir records nothing and does not throw', () => {
  const d = tmp();
  assert.equal(recordBranchRemoval(d, { branch: 'agent/a', cause: 'because' }), false);
  assert.equal(recordBranchRemoval(d, { cause: 'merged' }), false);
  assert.equal(recordBranchRemoval(null, { branch: 'agent/a', cause: 'merged' }), false);
  assert.deepEqual(readLedger(d), []);
});

test('a corrupt line is skipped and does not hide the entries around it', () => {
  const d = tmp();
  recordBranchRemoval(d, { branch: 'agent/a', cause: 'merged' });
  fs.appendFileSync(ledgerPath(d), '{"branch": "agent/z", "cau\n');
  recordBranchRemoval(d, { branch: 'agent/b', cause: 'discarded' });
  assert.deepEqual(readLedger(d).map((e) => e.branch), ['agent/a', 'agent/b']);
});

test('a write failure is swallowed and reported as false (never fails the caller)', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'queue'), 'a file where the queue dir should be');
  assert.equal(recordBranchRemoval(d, { branch: 'agent/a', cause: 'merged' }), false);
});
