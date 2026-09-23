'use strict';

// Unit tests for mechanical-move-registry.js (verifyMove hook, S3 of the hub-tasks
// extraction, 2026-09-23). Run: node --test src/mechanical-move-registry.test.js
//
// Uses its own throwaway kind names throughout (never 'script-extract'/'one-pass-decompose')
// so these tests can't collide with script-extract.js's / decompose-one-pass.js's real
// production registrations, which happen once at module load and are shared process-wide.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  registerMechanicalMoveKind, isVerifiedMechanicalMove, clearMechanicalMoveRegistry,
} = require('./mechanical-move-registry.js');

test('isVerifiedMechanicalMove is false for a missing/malformed promptContext', () => {
  assert.equal(isVerifiedMechanicalMove(null), false);
  assert.equal(isVerifiedMechanicalMove({}), false);
  assert.equal(isVerifiedMechanicalMove({ promptContext: {} }), false);
});

test('isVerifiedMechanicalMove is false for an unregistered kind', () => {
  assert.equal(isVerifiedMechanicalMove({ promptContext: { deterministicApply: 'nobody-registered-this-kind' } }), false);
});

test('a registered kind\'s verifyMove decides the outcome', () => {
  registerMechanicalMoveKind('test-kind-always-yes', { verifyMove: () => true });
  registerMechanicalMoveKind('test-kind-always-no', { verifyMove: () => false });
  assert.equal(isVerifiedMechanicalMove({ promptContext: { deterministicApply: 'test-kind-always-yes' } }), true);
  assert.equal(isVerifiedMechanicalMove({ promptContext: { deterministicApply: 'test-kind-always-no' } }), false);
});

test('verifyMove receives the real task, so a kind can inspect it', () => {
  registerMechanicalMoveKind('test-kind-inspects-task', {
    verifyMove: (task) => task.promptContext.symbols && task.promptContext.symbols.length > 0,
  });
  assert.equal(isVerifiedMechanicalMove({ promptContext: { deterministicApply: 'test-kind-inspects-task', symbols: ['a'] } }), true);
  assert.equal(isVerifiedMechanicalMove({ promptContext: { deterministicApply: 'test-kind-inspects-task', symbols: [] } }), false);
});

// Deliberately overwrite, not throw, on a duplicate kind name: a producer module's
// registration call is a plain load-time side effect, and file-decompose-to-hub.test.js
// legitimately clears and re-requires decompose-one-pass.js mid-suite, re-running its
// registerMechanicalMoveKind('one-pass-decompose', ...) call a second time.
test('registerMechanicalMoveKind overwrites (not throws) on a re-registered kind name', () => {
  registerMechanicalMoveKind('test-kind-dup', { verifyMove: () => false });
  assert.doesNotThrow(() => registerMechanicalMoveKind('test-kind-dup', { verifyMove: () => true }));
  assert.equal(isVerifiedMechanicalMove({ promptContext: { deterministicApply: 'test-kind-dup' } }), true, 'the later registration wins');
});

test('registerMechanicalMoveKind requires a non-empty kind string and a verifyMove function', () => {
  assert.throws(() => registerMechanicalMoveKind('', { verifyMove: () => true }), /non-empty string/);
  assert.throws(() => registerMechanicalMoveKind('test-kind-no-fn', {}), /verifyMove must be a function/);
});

// Run last: exercises clearMechanicalMoveRegistry, which wipes the SAME process-wide
// singleton script-extract.js/decompose-one-pass.js register their real kinds into --
// restores those two immediately afterward so any other test file sharing this process
// (e.g. decompose-auto-merge.test.js) isn't left with an empty registry.
test('clearMechanicalMoveRegistry empties the registry', () => {
  registerMechanicalMoveKind('test-kind-for-clear', { verifyMove: () => true });
  assert.equal(isVerifiedMechanicalMove({ promptContext: { deterministicApply: 'test-kind-for-clear' } }), true);
  clearMechanicalMoveRegistry();
  assert.equal(isVerifiedMechanicalMove({ promptContext: { deterministicApply: 'test-kind-for-clear' } }), false);

  // Restore production state.
  registerMechanicalMoveKind('script-extract', { verifyMove: () => true });
  registerMechanicalMoveKind('one-pass-decompose', { verifyMove: () => true });
});
