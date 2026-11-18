'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { retentionVerdict } = require('../src/branch-retention-gate.js');

test('missing branch gives unknown', () => {
  assert.equal(retentionVerdict({ branch: '', isOnMaster: () => true }), 'unknown');
  assert.equal(retentionVerdict({ branch: undefined, isOnMaster: () => false }), 'unknown');
});

test('branch on master gives merged', () => {
  assert.equal(retentionVerdict({ branch: 'agent/x', isOnMaster: () => true }), 'merged');
});

test('branch not on master gives unmerged', () => {
  assert.equal(retentionVerdict({ branch: 'agent/x', isOnMaster: () => false }), 'unmerged');
});

test('throwing predicate gives unknown without raising', () => {
  const boom = () => { throw new Error('git unavailable'); };
  assert.equal(retentionVerdict({ branch: 'agent/x', isOnMaster: boom }), 'unknown');
});
