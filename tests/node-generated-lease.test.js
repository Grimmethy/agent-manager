'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { shouldLeaseOrSkip, canClaim } = require('../src/node-generated-lease.js');
const { LEDGER_OWNER } = require('../src/node-affinity.js');

describe('shouldLeaseOrSkip', () => {
  it('returns "skip" for node grimm, no leasedTo, core scope, canClaim false', () => {
    const result = shouldLeaseOrSkip({
      nodeId: 'grimm',
      task: {},
      sourceScope: 'core',
      canClaim: () => false,
    });
    assert.equal(result, 'skip');
  });

  it('returns "lease" with leasedTo grimm for node grimm, no leasedTo, core scope, canClaim true', () => {
    const result = shouldLeaseOrSkip({
      nodeId: 'grimm',
      task: {},
      sourceScope: 'core',
      canClaim: () => true,
    });
    assert.equal(result, 'lease');
  });

  it('returns "leave" for ledger owner node (wok)', () => {
    const result = shouldLeaseOrSkip({
      nodeId: LEDGER_OWNER,
      task: {},
      sourceScope: 'core',
      canClaim: () => true,
    });
    assert.equal(result, 'leave');
  });

  it('returns "leave" for undefined nodeId', () => {
    const result = shouldLeaseOrSkip({
      nodeId: undefined,
      task: {},
      sourceScope: 'core',
      canClaim: () => true,
    });
    assert.equal(result, 'leave');
  });

  it('returns "leave" when task already has leasedTo', () => {
    const result = shouldLeaseOrSkip({
      nodeId: 'grimm',
      task: { leasedTo: 'other-node' },
      sourceScope: 'core',
      canClaim: () => true,
    });
    assert.equal(result, 'leave');
  });

  it('returns "leave" when scope is not core', () => {
    const result = shouldLeaseOrSkip({
      nodeId: 'grimm',
      task: {},
      sourceScope: 'plugins',
      canClaim: () => true,
    });
    assert.equal(result, 'leave');
  });
});

describe('canClaim', () => {
  it('returns false for blank nodeId', () => {
    assert.equal(canClaim({ nodeId: '', sourceScope: 'core' }), false);
  });

  it('returns false for non-core scope', () => {
    assert.equal(canClaim({ nodeId: 'grimm', sourceScope: 'plugins' }), false);
  });

  it('returns true for grimm with core scope', () => {
    assert.equal(canClaim({ nodeId: 'grimm', sourceScope: 'core' }), true);
  });
});
