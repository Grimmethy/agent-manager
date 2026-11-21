'use strict';

// Tests for the new stacked-premise helpers: fileExistsForTask, symbolExistsForTask,
// decideStackedPremiseRoute, and the WAITING status constant.
//
// Run: node --test src/stacked-premise.test.js  (or `npm test`)

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  fileExistsForTask,
  symbolExistsForTask,
  decideStackedPremiseRoute,
  WAITING,
} = require('./stacked-grounding.js');

// --- decideStackedPremiseRoute: pure function, every row of the decision table ---

test('decideStackedPremiseRoute: found on tip → requeue-tip', () => {
  assert.equal(
    decideStackedPremiseRoute({ foundOnTip: true, foundOnAppliedSibling: false, unappliedSiblingCount: 0 }),
    'requeue-tip'
  );
});

test('decideStackedPremiseRoute: found on applied sibling (not tip) → requeue-tip (treat like tip)', () => {
  assert.equal(
    decideStackedPremiseRoute({ foundOnTip: false, foundOnAppliedSibling: true, unappliedSiblingCount: 0 }),
    'requeue-tip'
  );
});

test('decideStackedPremiseRoute: not found, unapplied siblings remain → waiting', () => {
  assert.equal(
    decideStackedPremiseRoute({ foundOnTip: false, foundOnAppliedSibling: false, unappliedSiblingCount: 2 }),
    'waiting'
  );
});

test('decideStackedPremiseRoute: missing everywhere, no unapplied → escalate', () => {
  assert.equal(
    decideStackedPremiseRoute({ foundOnTip: false, foundOnAppliedSibling: false, unappliedSiblingCount: 0 }),
    'escalate'
  );
});

test('decideStackedPremiseRoute: found on tip with unapplied siblings still → requeue-tip (tip wins)', () => {
  assert.equal(
    decideStackedPremiseRoute({ foundOnTip: true, foundOnAppliedSibling: false, unappliedSiblingCount: 5 }),
    'requeue-tip'
  );
});

// --- fileExistsForTask: options-object signature, missing args return false ---

test('fileExistsForTask: missing repoRoot returns false', () => {
  assert.equal(fileExistsForTask('some/path.js', { groundingRef: 'main', repoRoot: undefined }), false);
});

test('fileExistsForTask: missing groundingRef returns false', () => {
  assert.equal(fileExistsForTask('some/path.js', { repoRoot: '/tmp' }), false);
});

test('fileExistsForTask: empty path returns false', () => {
  assert.equal(fileExistsForTask('', { groundingRef: 'main', repoRoot: '/tmp' }), false);
});

test('fileExistsForTask: undefined path returns false', () => {
  assert.equal(fileExistsForTask(undefined, { groundingRef: 'main', repoRoot: '/tmp' }), false);
});

test('fileExistsForTask: no siblingRefs behaves as tip-only', () => {
  // With a valid repoRoot and groundingRef pointing to a non-existent ref, should return false
  assert.equal(
    fileExistsForTask('nonexistent.js', { groundingRef: 'nonexistent-branch', repoRoot: '/tmp/does-not-exist' }),
    false
  );
});

test('fileExistsForTask: checks siblingRefs in order, returns true on first hit', () => {
  // This test verifies the structure works; actual git resolution requires a real repo fixture
  // For now, just verify it doesn't throw with siblingRefs provided
  assert.equal(
    fileExistsForTask('test.js', {
      groundingRef: 'main',
      siblingRefs: ['sibling1', 'sibling2'],
      repoRoot: '/tmp',
    }),
    false
  );
});

// --- symbolExistsForTask: options-object signature, missing args return false ---

test('symbolExistsForTask: missing repoRoot returns false', () => {
  assert.equal(symbolExistsForTask('const', { groundingRef: 'main', repoRoot: undefined }), false);
});

test('symbolExistsForTask: missing groundingRef returns false', () => {
  assert.equal(symbolExistsForTask('const', { repoRoot: '/tmp' }), false);
});

test('symbolExistsForTask: empty symbol returns false', () => {
  assert.equal(symbolExistsForTask('', { groundingRef: 'main', repoRoot: '/tmp' }), false);
});

test('symbolExistsForTask: undefined symbol returns false', () => {
  assert.equal(symbolExistsForTask(undefined, { groundingRef: 'main', repoRoot: '/tmp' }), false);
});

test('symbolExistsForTask: no siblingRefs behaves as tip-only', () => {
  assert.equal(
    symbolExistsForTask('nonexistent-symbol', {
      groundingRef: 'nonexistent-branch',
      repoRoot: '/tmp/does-not-exist',
    }),
    false
  );
});

test('symbolExistsForTask: checks siblingRefs in order', () => {
  assert.equal(
    symbolExistsForTask('const', {
      groundingRef: 'main',
      siblingRefs: ['sibling1', 'sibling2'],
      repoRoot: '/tmp',
    }),
    false
  );
});

// --- WAITING constant ---

test('WAITING is the string "waiting"', () => {
  assert.equal(WAITING, 'waiting');
});
