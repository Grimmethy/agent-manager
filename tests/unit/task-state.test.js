'use strict';

// Tests for src/lib/task-state.js (HUB0316 · 3/4).
//
// Sets HOME and state paths to temp dirs so no real filesystem state is
// touched. Uses node:test (the repo's test runner).
//
// Run: node --test tests/unit/task-state.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Set HOME to a temp dir before requiring the module so any state paths
// resolved internally point at the temp directory.
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'task-state-test-'));
const originalHome = process.env.HOME;
process.env.HOME = tempHome;

const {
  TASK_STATES,
  PLANNER_FAILURE_REASON,
  getPlannerFailureSourceStates,
  canTransitionToPlannerFailure,
} = require('../../src/lib/task-state');

test.after(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

test('exports TASK_STATES as an array', () => {
  assert.ok(Array.isArray(TASK_STATES));
});

test('exports PLANNER_FAILURE_REASON as a string', () => {
  assert.equal(typeof PLANNER_FAILURE_REASON, 'string');
});

test('exports getPlannerFailureSourceStates as a function', () => {
  assert.equal(typeof getPlannerFailureSourceStates, 'function');
});

test('exports canTransitionToPlannerFailure as a function', () => {
  assert.equal(typeof canTransitionToPlannerFailure, 'function');
});

// ---------------------------------------------------------------------------
// TASK_STATES enum
// ---------------------------------------------------------------------------

test('TASK_STATES includes "planner-failure"', () => {
  assert.ok(TASK_STATES.includes('planner-failure'));
});

test('TASK_STATES includes all prior states plus planner-failure', () => {
  const expected = [
    'pending',
    'review',
    'approved',
    'blocked',
    'done',
    'needs-clarification',
    'awaiting-confirm',
    'coordinating',
    'planning',
    'planner-failure',
  ];
  assert.deepEqual(TASK_STATES, expected);
});

test('TASK_STATES has 10 entries (9 prior + planner-failure)', () => {
  assert.equal(TASK_STATES.length, 10);
});

// ---------------------------------------------------------------------------
// PLANNER_FAILURE_REASON
// ---------------------------------------------------------------------------

test('PLANNER_FAILURE_REASON is "degenerate-plan-exhausted-retries"', () => {
  assert.equal(PLANNER_FAILURE_REASON, 'degenerate-plan-exhausted-retries');
});

// ---------------------------------------------------------------------------
// getPlannerFailureSourceStates
// ---------------------------------------------------------------------------

test('getPlannerFailureSourceStates returns ["planning", "needs-clarification"]', () => {
  assert.deepEqual(getPlannerFailureSourceStates(), ['planning', 'needs-clarification']);
});

// ---------------------------------------------------------------------------
// canTransitionToPlannerFailure — from 'planning'
// ---------------------------------------------------------------------------

test('canTransitionToPlannerFailure: from "planning" returns true', () => {
  assert.equal(canTransitionToPlannerFailure('planning'), true);
});

test('canTransitionToPlannerFailure: from "planning" ignores opts', () => {
  assert.equal(canTransitionToPlannerFailure('planning', { lastTransitionReason: 'anything' }), true);
});

// ---------------------------------------------------------------------------
// canTransitionToPlannerFailure — from 'needs-clarification' with degenerate-plan reason
// ---------------------------------------------------------------------------

test('canTransitionToPlannerFailure: from "needs-clarification" with degenerate-plan reason returns true', () => {
  assert.equal(
    canTransitionToPlannerFailure('needs-clarification', { lastTransitionReason: PLANNER_FAILURE_REASON }),
    true,
  );
});

test('canTransitionToPlannerFailure: from "needs-clarification" with exact reason string returns true', () => {
  assert.equal(
    canTransitionToPlannerFailure('needs-clarification', { lastTransitionReason: 'degenerate-plan-exhausted-retries' }),
    true,
  );
});

// ---------------------------------------------------------------------------
// canTransitionToPlannerFailure — from 'needs-clarification' WITHOUT degenerate-plan reason
//   (genuine unmet-prerequisite cases must NOT transition)
// ---------------------------------------------------------------------------

test('canTransitionToPlannerFailure: from "needs-clarification" with no reason returns false', () => {
  assert.equal(canTransitionToPlannerFailure('needs-clarification'), false);
});

test('canTransitionToPlannerFailure: from "needs-clarification" with empty reason returns false', () => {
  assert.equal(
    canTransitionToPlannerFailure('needs-clarification', { lastTransitionReason: '' }),
    false,
  );
});

test('canTransitionToPlannerFailure: from "needs-clarification" with genuine unmet-prereq reason returns false', () => {
  assert.equal(
    canTransitionToPlannerFailure('needs-clarification', { lastTransitionReason: 'missing-dependency' }),
    false,
  );
});

test('canTransitionToPlannerFailure: from "needs-clarification" with "awaiting-human" reason returns false', () => {
  assert.equal(
    canTransitionToPlannerFailure('needs-clarification', { lastTransitionReason: 'awaiting-human' }),
    false,
  );
});

test('canTransitionToPlannerFailure: from "needs-clarification" with "review-failed" reason returns false', () => {
  assert.equal(
    canTransitionToPlannerFailure('needs-clarification', { lastTransitionReason: 'review-failed' }),
    false,
  );
});

// ---------------------------------------------------------------------------
// canTransitionToPlannerFailure — from disallowed states
// ---------------------------------------------------------------------------

test('canTransitionToPlannerFailure: from "done" returns false', () => {
  assert.equal(canTransitionToPlannerFailure('done'), false);
});

test('canTransitionToPlannerFailure: from "blocked" returns false', () => {
  assert.equal(canTransitionToPlannerFailure('blocked'), false);
});

test('canTransitionToPlannerFailure: from "review" returns false', () => {
  assert.equal(canTransitionToPlannerFailure('review'), false);
});

test('canTransitionToPlannerFailure: from "approved" returns false', () => {
  assert.equal(canTransitionToPlannerFailure('approved'), false);
});

test('canTransitionToPlannerFailure: from "pending" returns false', () => {
  assert.equal(canTransitionToPlannerFailure('pending'), false);
});

test('canTransitionToPlannerFailure: from "awaiting-confirm" returns false', () => {
  assert.equal(canTransitionToPlannerFailure('awaiting-confirm'), false);
});

test('canTransitionToPlannerFailure: from "coordinating" returns false', () => {
  assert.equal(canTransitionToPlannerFailure('coordinating'), false);
});

test('canTransitionToPlannerFailure: from "planner-failure" (already there) returns false', () => {
  assert.equal(canTransitionToPlannerFailure('planner-failure'), false);
});

// ---------------------------------------------------------------------------
// canTransitionToPlannerFailure — invalid inputs
// ---------------------------------------------------------------------------

test('canTransitionToPlannerFailure: null returns false', () => {
  assert.equal(canTransitionToPlannerFailure(null), false);
});

test('canTransitionToPlannerFailure: undefined returns false', () => {
  assert.equal(canTransitionToPlannerFailure(undefined), false);
});

test('canTransitionToPlannerFailure: number returns false', () => {
  assert.equal(canTransitionToPlannerFailure(42), false);
});

test('canTransitionToPlannerFailure: object returns false', () => {
  assert.equal(canTransitionToPlannerFailure({}), false);
});
