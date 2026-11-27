'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ownerGateFor } = require('./owner-gates.js');

test('ownerGateFor matches owner approval, owner-approval, needs the owner and design decision, case-insensitively, and reports the phrase', () => {
  assert.deepEqual(ownerGateFor({ id: 'p1', title: 'Vendor dockview (Owner Approval gate)', rawText: 'x' }), { id: 'p1', title: 'Vendor dockview (Owner Approval gate)', why: 'owner approval' });
  assert.equal(ownerGateFor({ id: 'p2', title: 't', rawText: 'This needs owner-approval first.' }).why, 'owner-approval');
  assert.equal(ownerGateFor({ id: 'p3', title: 't', rawText: 'Step 2 NEEDS THE OWNER to authorize the account.' }).why, 'needs the owner');
  assert.equal(ownerGateFor({ id: 'p4', title: 'Design decision: pick the layout', rawText: '' }).why, 'design decision');
});

test('ownerGateFor returns null for an ordinary piece, including a mere mention of an owner', () => {
  assert.equal(ownerGateFor({ id: 'p5', title: 'Add a route', rawText: 'The owner of the session is the host.' }), null);
  assert.equal(ownerGateFor({ id: 'p6' }), null);
});

test('ownerGateFor does not dismiss protected case: blocked + escalated from needs-clarification', () => {
  const piece = {
    id: 'p7',
    title: 'Blocked task',
    rawText: 'No trigger phrases here',
    status: 'blocked',
    promptContext: { raisedFrom: 'needs-clarification' }
  };
  assert.equal(ownerGateFor(piece), null);
});

test('ownerGateFor records dismissal via history event for non-protected case', () => {
  const piece = {
    id: 'p8',
    title: 'Ordinary task',
    rawText: 'No trigger phrases here',
    status: 'pending'
  };
  const result = ownerGateFor(piece);
  assert.equal(result, null);
  assert.ok(Array.isArray(piece.history), 'history should be an array');
  assert.ok(piece.history.length > 0, 'history should have at least one entry');
  const lastEntry = piece.history[piece.history.length - 1];
  assert.equal(lastEntry.stage, 'advisory');
  assert.ok(lastEntry.detail.includes('dismissed'));
});
