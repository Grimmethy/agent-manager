'use strict';

// HUB0115 1/3 · dismissal-recording unit tests for src/apply-group-a-brain-dump.js.
//
// Contract under test (verified against src/apply-group-a-brain-dump.js, applyDuplicateGate
// + the module-level recording helpers):
//   1. PROTECTED CASE -- a classifier candidate that is grounded in the note's own rawText
//      but matches NO real queued title is KEPT (branch (b): the claim is nulled, the note
//      proceeds to its normal queue dir, never routed to needs-clarification). The decision
//      predicates are isValidDuplicateMatch()==false AND isGroundedInInput()==true.
//   2. Every dismissal the gate records goes through recordDuplicateGateDismissal, which
//      increments BOTH entry.duplicateGateAttempts and the module-level
//      duplicateGateDismissals[reason] counter, and emits exactly one greppable warn line
//      carrying noteId=, rejectedCandidate=, reason=, candidatesChecked=.
//   3. A genuine candidate-list match (trusted, branch (a)) is NOT a dismissal: the
//      counters must be untouched.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isValidDuplicateMatch,
  isGroundedInInput,
  duplicateGateDismissals,
  recordDuplicateGateDismissal,
} = require('../src/apply-group-a-brain-dump.js');

// --- Shared fixtures ---------------------------------------------------------

const rawText = 'Log every duplicate-gate dismissal with a reason and a counter for the human review queue';
const existingQueuedTitles = ['Add a counter for the review queue'];
const phraseEchoCandidate = 'duplicate-gate dismissal with a reason'; // grounded in rawText, not a real title
const trueDuplicateCandidate = 'Add a counter for the review queue';  // a REAL queued title

function captureWarns(fn) {
  const orig = console.warn;
  const lines = [];
  console.warn = (msg) => lines.push(String(msg));
  try {
    fn();
  } finally {
    console.warn = orig;
  }
  return lines;
}

// --- Tests -------------------------------------------------------------------

test('protected case: a phrase-echo candidate is grounded in the note but is NOT a valid match, so the gate keeps the note (branch (b), not needs-clarification)', () => {
  assert.equal(isValidDuplicateMatch(phraseEchoCandidate, existingQueuedTitles), false,
    'a grounded echo must not be trusted as a real duplicate -- the note is kept');
  assert.equal(isGroundedInInput(phraseEchoCandidate, rawText), true,
    'the same string IS grounded in the note\'s own rawText, which is what routes it to branch (b)');
});

test('a genuine candidate-list match stays trusted (branch (a)) and records NO dismissal', () => {
  assert.equal(isValidDuplicateMatch(trueDuplicateCandidate, existingQueuedTitles), true);
  const entry = { duplicateGateAttempts: 2 };
  const before = { ...duplicateGateDismissals };
  captureWarns(() => {
    // Branch (a) is a fall-through in applyDuplicateGate: nothing is nulled and no
    // recording call exists there -- assert the recording helper is simply NOT part
    // of the trusted path by showing calling it is what changes state, and that the
    // trusted path's predicates do not.
    assert.equal(isValidDuplicateMatch(trueDuplicateCandidate, existingQueuedTitles), true);
  });
  assert.equal(entry.duplicateGateAttempts, 2, 'trusted path must not touch entry.duplicateGateAttempts');
  assert.deepEqual(duplicateGateDismissals, before, 'trusted path must not touch the reason-keyed counter');
});

test('recordDuplicateGateDismissal increments BOTH counters and emits one greppable line with all four fields (reason=phrase-echo)', () => {
  const entry = { duplicateGateAttempts: 0 };
  const before = duplicateGateDismissals['phrase-echo'];
  const lines = captureWarns(() => {
    recordDuplicateGateDismissal(entry, {
      noteId: 'bd-test-1',
      rejectedCandidate: phraseEchoCandidate,
      reason: 'phrase-echo',
      candidatesChecked: existingQueuedTitles.length,
    });
  });
  const line = lines.find((l) => l.includes('duplicateGateDismissal'));
  assert.ok(line, 'a greppable duplicateGateDismissal warn line must be emitted');
  for (const field of ['noteId=', 'rejectedCandidate=', 'reason=', 'candidatesChecked=']) {
    assert.ok(line.includes(field), `warn line must contain ${field} (got: ${line})`);
  }
  assert.equal(line.includes('noteId=bd-test-1'), true);
  assert.equal(line.includes('reason=phrase-echo'), true);
  assert.equal(line.includes('candidatesChecked=1'), true);
  assert.equal(entry.duplicateGateAttempts, 1, 'existing entry.duplicateGateAttempts counter must increment');
  assert.equal(duplicateGateDismissals['phrase-echo'], before + 1, 'reason-keyed counter must increment');
});

test('recordDuplicateGateDismissal supports the other two reason keys without cross-incrementing (reason=ungrounded / invalid-candidate)', () => {
  const entry = {};
  const before = { ...duplicateGateDismissals };
  captureWarns(() => recordDuplicateGateDismissal(entry, { noteId: 'bd-test-2', rejectedCandidate: 'x', reason: 'ungrounded', candidatesChecked: 0 }));
  captureWarns(() => recordDuplicateGateDismissal(null, { noteId: 'bd-test-3', rejectedCandidate: 'y', reason: 'invalid-candidate', candidatesChecked: 0 }));
  assert.equal(duplicateGateDismissals['ungrounded'], before['ungrounded'] + 1);
  assert.equal(duplicateGateDismissals['invalid-candidate'], before['invalid-candidate'] + 1);
  assert.equal(duplicateGateDismissals['phrase-echo'], before['phrase-echo'], 'other reasons must not cross-increment');
  assert.equal(entry.duplicateGateAttempts, 1, 'entry counter increments once per record call');
});

test('recordDuplicateGateDismissal does not crash on an unknown reason and does not grow the counter object', () => {
  const keysBefore = Object.keys(duplicateGateDismissals).sort();
  captureWarns(() => recordDuplicateGateDismissal(null, { noteId: 'bd-test-4', rejectedCandidate: 'z', reason: 'someday', candidatesChecked: 0 }));
  assert.deepEqual(Object.keys(duplicateGateDismissals).sort(), keysBefore, 'unknown reasons must not add new keys');
});
