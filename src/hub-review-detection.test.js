'use strict';

// Unit tests for hub-review-detection.js (S3-a of the hub-tasks extraction, 2026-09-23).
// Run: node --test src/hub-review-detection.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isDecomposeOrSplitProposal, DEFAULT_DECOMPOSE_PROPOSAL_DETECTION,
  getDecomposeProposalDetection, setDecomposeProposalDetection,
} = require('./hub-review-detection.js');

test('getDecomposeProposalDetection returns the default bundle when nothing has overridden it', () => {
  setDecomposeProposalDetection(null);
  assert.equal(getDecomposeProposalDetection(), DEFAULT_DECOMPOSE_PROPOSAL_DETECTION);
});

test('isDecomposeOrSplitProposal is true for a candidateSplitProposals task regardless of source', () => {
  assert.equal(isDecomposeOrSplitProposal({ source: 'function_length_fix', candidateSplitProposals: [{}] }), true);
});

test('isDecomposeOrSplitProposal is true for a manual/adhoc task with adhocResolution:"decompose"', () => {
  assert.equal(isDecomposeOrSplitProposal({ source: 'manual', adhocResolution: 'decompose' }), true);
});

test('isDecomposeOrSplitProposal is false for adhocResolution:"decompose" on a non-manual source (the manual gate matters)', () => {
  assert.equal(isDecomposeOrSplitProposal({ source: 'trouble_log', adhocResolution: 'decompose' }), false);
});

test('isDecomposeOrSplitProposal is false for an ordinary task', () => {
  assert.equal(isDecomposeOrSplitProposal({ source: 'manual' }), false);
  assert.equal(isDecomposeOrSplitProposal(null), false);
});

test('setDecomposeProposalDetection swaps the live implementation; a falsy argument restores the default', () => {
  const custom = { isDecomposeOrSplitProposal: () => true };
  setDecomposeProposalDetection(custom);
  assert.equal(getDecomposeProposalDetection(), custom);
  setDecomposeProposalDetection(null);
  assert.equal(getDecomposeProposalDetection(), DEFAULT_DECOMPOSE_PROPOSAL_DETECTION);
});
