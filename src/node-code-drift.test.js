'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { codeDrift, describeDrift } = require('./node-code-drift.js');

const MASTER = 'a'.repeat(40);
const SHA_A = 'b'.repeat(40);
const SHA_B = 'c'.repeat(40);
const SHA_C = 'd'.repeat(40);

test('codeDrift: current when codeSha equals masterSha', () => {
  const nodes = [{ id: 'grimm', codeSha: MASTER }];
  const behind = (nodeSha, ms) => { assert.fail('should not be called'); return -1; };
  const result = codeDrift(nodes, MASTER, behind);
  assert.deepEqual(result, [{ id: 'grimm', codeSha: MASTER, state: 'current', behind: 0 }]);
});

test('codeDrift: behind by 1 commit', () => {
  const nodes = [{ id: 'grimm', codeSha: SHA_A }];
  const behind = () => 1;
  const result = codeDrift(nodes, MASTER, behind);
  assert.deepEqual(result, [{ id: 'grimm', codeSha: SHA_A, state: 'behind', behind: 1 }]);
});

test('codeDrift: behind by many commits', () => {
  const nodes = [{ id: 'grimm', codeSha: SHA_A }];
  const behind = () => 42;
  const result = codeDrift(nodes, MASTER, behind);
  assert.deepEqual(result, [{ id: 'grimm', codeSha: SHA_A, state: 'behind', behind: 42 }]);
});

test('codeDrift: 0 for differing sha is treated as current', () => {
  const nodes = [{ id: 'grimm', codeSha: SHA_A }];
  const behind = () => 0;
  const result = codeDrift(nodes, MASTER, behind);
  assert.deepEqual(result, [{ id: 'grimm', codeSha: SHA_A, state: 'current', behind: 0 }]);
});

test('codeDrift: unknown when codeSha is null', () => {
  const nodes = [{ id: 'grimm', codeSha: null }];
  const behind = () => { assert.fail('should not be called'); return -1; };
  const result = codeDrift(nodes, MASTER, behind);
  assert.deepEqual(result, [{ id: 'grimm', codeSha: null, state: 'unknown', behind: null }]);
});

test('codeDrift: unknown when codeSha is missing', () => {
  const nodes = [{ id: 'grimm' }];
  const behind = () => { assert.fail('should not be called'); return -1; };
  const result = codeDrift(nodes, MASTER, behind);
  assert.deepEqual(result, [{ id: 'grimm', codeSha: null, state: 'unknown', behind: null }]);
});

test('codeDrift: unknown when countBehind returns null', () => {
  const nodes = [{ id: 'grimm', codeSha: SHA_A }];
  const behind = () => null;
  const result = codeDrift(nodes, MASTER, behind);
  assert.deepEqual(result, [{ id: 'grimm', codeSha: SHA_A, state: 'unknown', behind: null }]);
});

test('codeDrift: unknown when countBehind throws', () => {
  const nodes = [{ id: 'grimm', codeSha: SHA_A }];
  const behind = () => { throw new Error('git not available'); };
  const result = codeDrift(nodes, MASTER, behind);
  assert.deepEqual(result, [{ id: 'grimm', codeSha: SHA_A, state: 'unknown', behind: null }]);
});

test('codeDrift: unknown when countBehind returns a non-integer', () => {
  const nodes = [{ id: 'grimm', codeSha: SHA_A }];
  const behind = () => 1.5;
  const result = codeDrift(nodes, MASTER, behind);
  assert.deepEqual(result, [{ id: 'grimm', codeSha: SHA_A, state: 'unknown', behind: null }]);
});

test('codeDrift: unknown when countBehind returns a negative', () => {
  const nodes = [{ id: 'grimm', codeSha: SHA_A }];
  const behind = () => -1;
  const result = codeDrift(nodes, MASTER, behind);
  assert.deepEqual(result, [{ id: 'grimm', codeSha: SHA_A, state: 'unknown', behind: null }]);
});

test('codeDrift: preserves input order across mixed list', () => {
  const nodes = [
    { id: 'alpha', codeSha: MASTER },
    { id: 'beta', codeSha: SHA_A },
    { id: 'gamma', codeSha: null },
    { id: 'delta', codeSha: SHA_B },
  ];
  const behind = (nodeSha) => (nodeSha === SHA_A ? 3 : 7);
  const result = codeDrift(nodes, MASTER, behind);
  assert.equal(result.length, 4);
  assert.equal(result[0].id, 'alpha');
  assert.equal(result[0].state, 'current');
  assert.equal(result[0].behind, 0);
  assert.equal(result[1].id, 'beta');
  assert.equal(result[1].state, 'behind');
  assert.equal(result[1].behind, 3);
  assert.equal(result[2].id, 'gamma');
  assert.equal(result[2].state, 'unknown');
  assert.equal(result[2].behind, null);
  assert.equal(result[3].id, 'delta');
  assert.equal(result[3].state, 'behind');
  assert.equal(result[3].behind, 7);
});

test('codeDrift: stale/off nodes reported by sha with same rules', () => {
  const nodes = [
    { id: 'stale-node', status: 'stale', codeSha: SHA_A },
    { id: 'off-node', status: 'off', codeSha: MASTER },
    { id: 'unknown-node', status: 'off', codeSha: null },
  ];
  const behind = () => 5;
  const result = codeDrift(nodes, MASTER, behind);
  assert.equal(result[0].state, 'behind');
  assert.equal(result[0].behind, 5);
  assert.equal(result[1].state, 'current');
  assert.equal(result[1].behind, 0);
  assert.equal(result[2].state, 'unknown');
  assert.equal(result[2].behind, null);
});

test('codeDrift: throws TypeError for non-array nodes', () => {
  assert.throws(() => codeDrift('not-array', MASTER, () => 0), /nodes must be an array/);
  assert.throws(() => codeDrift(null, MASTER, () => 0), /nodes must be an array/);
  assert.throws(() => codeDrift({ id: 'x' }, MASTER, () => 0), /nodes must be an array/);
});

test('codeDrift: throws TypeError for invalid masterSha', () => {
  const nodes = [];
  const behind = () => 0;
  assert.throws(() => codeDrift(nodes, 'x'.repeat(40), behind), /masterSha must be a 40-character lowercase hex string/);
  assert.throws(() => codeDrift(nodes, 'A'.repeat(40), behind), /masterSha must be a 40-character lowercase hex string/);
  assert.throws(() => codeDrift(nodes, 'a'.repeat(39), behind), /masterSha must be a 40-character lowercase hex string/);
  assert.throws(() => codeDrift(nodes, 'a'.repeat(41), behind), /masterSha must be a 40-character lowercase hex string/);
  assert.throws(() => codeDrift(nodes, '', behind), /masterSha must be a 40-character lowercase hex string/);
  assert.throws(() => codeDrift(nodes, 123, behind), /masterSha must be a 40-character lowercase hex string/);
  assert.throws(() => codeDrift(nodes, null, behind), /masterSha must be a 40-character lowercase hex string/);
});

test('describeDrift: current state', () => {
  const entry = { id: 'grimm', codeSha: MASTER, state: 'current', behind: 0 };
  assert.equal(describeDrift(entry), `grimm: current (${MASTER.slice(0, 8)})`);
});

test('describeDrift: behind state with plural', () => {
  const entry = { id: 'grimm', codeSha: SHA_A, state: 'behind', behind: 3 };
  assert.equal(describeDrift(entry), 'grimm: behind by 3 commits (bbbbbbbb)');
});

test('describeDrift: behind state with singular 1 commit', () => {
  const entry = { id: 'grimm', codeSha: SHA_A, state: 'behind', behind: 1 };
  assert.equal(describeDrift(entry), 'grimm: behind by 1 commit (bbbbbbbb)');
});

test('describeDrift: unknown state', () => {
  const entry = { id: 'grimm', codeSha: null, state: 'unknown', behind: null };
  assert.equal(describeDrift(entry), 'grimm: code version unknown');
});
