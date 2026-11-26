'use strict';

// Tests for the protected case in owner-gate dismissal logic.
// Contract: tasks with status 'blocked' that were escalated from 'needs-clarification'
// MUST NOT be dismissed, even without recent history events. The protected case is
// checked by the caller (not inside ownerGateFor itself), and it must be checked
// BEFORE the gate/dismissal logic.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ownerGateFor } = require('../src/owner-gates.js');

// Simulates the caller that decides whether to dismiss a piece.
// Returns { dismissed: boolean, reason: string }
// The protected case check happens FIRST, before any gate/dismissal logic.
function evaluateDismissal(piece) {
  // PROTECTED CASE: checked first, before gate logic
  if (piece.status === 'blocked' && hasEscalationFromNeedsClarification(piece)) {
    return { dismissed: false, reason: 'protected: blocked and escalated from needs-clarification' };
  }

  // Gate check (simplified for test purposes)
  const gate = ownerGateFor(piece);
  if (gate) {
    return { dismissed: false, reason: 'gate hit: requires owner approval' };
  }

  // Dismissal logic (would normally check for recent history events)
  if (!hasRecentHistory(piece)) {
    return { dismissed: true, reason: 'no recent history events' };
  }

  return { dismissed: false, reason: 'has recent history' };
}

function hasEscalationFromNeedsClarification(piece) {
  if (!piece.history || !Array.isArray(piece.history)) return false;
  return piece.history.some(entry =>
    entry.from === 'needs-clarification' && entry.to === 'blocked'
  );
}

function hasRecentHistory(piece) {
  if (!piece.history || !Array.isArray(piece.history)) return false;
  const oneDayAgo = Date.now() - 86400000;
  return piece.history.some(entry => entry.at > oneDayAgo);
}

test('should not dismiss blocked task escalated from needs-clarification even without recent history', () => {
  const piece = {
    id: 'HUB0924-protected',
    title: 'Test protected case',
    status: 'blocked',
    history: [
      { from: 'needs-clarification', to: 'blocked', at: Date.now() - 86400000 } // 1 day ago
    ]
  };

  const result = evaluateDismissal(piece);

  // The protected case MUST prevent dismissal
  assert.equal(result.dismissed, false, 'Protected task should not be dismissed');
  assert.equal(result.reason, 'protected: blocked and escalated from needs-clarification',
    'Reason should be the protected case');
});

test('protected case check happens before gate logic', () => {
  // A piece that would trigger the gate but is protected
  const piece = {
    id: 'HUB0924-protected-gate',
    title: 'Design decision: protected case',
    status: 'blocked',
    history: [
      { from: 'needs-clarification', to: 'blocked', at: Date.now() - 86400000 }
    ]
  };

  // ownerGateFor would return a gate hit
  const gate = ownerGateFor(piece);
  assert.notEqual(gate, null, 'Gate should trigger for this piece');

  // But the protected case prevents dismissal
  const result = evaluateDismissal(piece);
  assert.equal(result.dismissed, false, 'Protected task should not be dismissed even with gate hit');
  assert.equal(result.reason, 'protected: blocked and escalated from needs-clarification',
    'Protected case takes precedence over gate logic');
});

test('protected case only applies when status is blocked and history shows escalation', () => {
  // Case 1: blocked but not escalated from needs-clarification
  const piece1 = {
    id: 'HUB0924-not-protected-1',
    title: 'Test',
    status: 'blocked',
    history: [
      { from: 'pending', to: 'blocked', at: Date.now() - 86400000 }
    ]
  };
  const result1 = evaluateDismissal(piece1);
  assert.equal(result1.dismissed, true, 'Should be dismissed: blocked but not from needs-clarification');

  // Case 2: escalated from needs-clarification but not blocked
  const piece2 = {
    id: 'HUB0924-not-protected-2',
    title: 'Test',
    status: 'pending',
    history: [
      { from: 'needs-clarification', to: 'pending', at: Date.now() - 86400000 }
    ]
  };
  const result2 = evaluateDismissal(piece2);
  assert.equal(result2.dismissed, true, 'Should be dismissed: from needs-clarification but not blocked');

  // Case 3: blocked and from needs-clarification but no history
  const piece3 = {
    id: 'HUB0924-not-protected-3',
    title: 'Test',
    status: 'blocked',
    history: []
  };
  const result3 = evaluateDismissal(piece3);
  assert.equal(result3.dismissed, true, 'Should be dismissed: blocked but no escalation history');
});

test('protected case does not apply to ownerGateFor itself (it is pure)', () => {
  // ownerGateFor has no access to status or history; it only checks trigger phrases
  const piece = {
    id: 'HUB0924-pure',
    title: 'Test',
    status: 'blocked',
    history: [
      { from: 'needs-clarification', to: 'blocked', at: Date.now() - 86400000 }
    ]
  };

  // ownerGateFor should return null (no trigger phrases)
  const gate = ownerGateFor(piece);
  assert.equal(gate, null, 'ownerGateFor is pure and does not check status/history');

  // The protection comes from the caller, not the gate function
  const result = evaluateDismissal(piece);
  assert.equal(result.dismissed, false, 'Caller checks protected case and prevents dismissal');
});
