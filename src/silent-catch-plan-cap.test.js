'use strict';

// Unit tests for silent-catch-plan-cap.js -- capPlanStageOutput's
// (ruleId, expectedDisposition) gating, the SILENT_CATCH_PLAN_MAX_CHARS
// bound, and the deriveExpectedDisposition / deriveRuleId helpers.
// Pure module, no I/O, no fixtures.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SILENT_CATCH_PLAN_MAX_CHARS,
  capPlanStageOutput,
  deriveExpectedDisposition,
  deriveRuleId,
} = require('./silent-catch-plan-cap.js');

const fixture = 'a'.repeat(3000);

test('SILENT_CATCH_PLAN_MAX_CHARS is 1500', () => {
  assert.strictEqual(SILENT_CATCH_PLAN_MAX_CHARS, 1500);
});

test('caps to 1500 for silent-catch-block + dismiss (3000-char input -> 1500)', () => {
  const out = capPlanStageOutput(fixture, 'silent-catch-block', 'dismiss');
  assert.strictEqual(out.length, 1500);
  assert.strictEqual(out, fixture.slice(0, 1500));
});

test('does not cap for silent-catch-block + fix (3000-char input -> 3000)', () => {
  const out = capPlanStageOutput(fixture, 'silent-catch-block', 'fix');
  assert.strictEqual(out.length, 3000);
  assert.strictEqual(out, fixture);
});

test('does not cap for other-rule + dismiss (3000-char input -> 3000)', () => {
  const out = capPlanStageOutput(fixture, 'other-rule', 'dismiss');
  assert.strictEqual(out.length, 3000);
  assert.strictEqual(out, fixture);
});

test('genuine silent-catch task (no observability dismissal) derives null and stays uncapped', () => {
  const task = { ruleId: 'silent-catch-block' };
  const disposition = deriveExpectedDisposition(task);
  assert.strictEqual(disposition, null);
  const out = capPlanStageOutput(fixture, 'silent-catch-block', disposition);
  assert.strictEqual(out, fixture);
});

test('observability_review + dismissed derives dismissed and caps for silent-catch-block', () => {
  const task = { source: 'observability_review', reviewDisposition: 'dismissed' };
  const disposition = deriveExpectedDisposition(task);
  assert.strictEqual(disposition, 'dismissed');
  const out = capPlanStageOutput(fixture, 'silent-catch-block', disposition);
  assert.strictEqual(out.length, 1500);
});

test('dismissed observability task with a different ruleId is not capped', () => {
  const task = { source: 'observability_review', reviewDisposition: 'dismissed' };
  const disposition = deriveExpectedDisposition(task);
  const out = capPlanStageOutput(fixture, 'other-rule', disposition);
  assert.strictEqual(out, fixture);
});

test('deriveRuleId precedence: originalRule beats rule beats unknown', () => {
  assert.strictEqual(deriveRuleId({ originalRule: 'a', rule: 'b' }), 'a');
  assert.strictEqual(deriveRuleId({ rule: 'b' }), 'b');
  assert.strictEqual(deriveRuleId({}), 'unknown');
  assert.strictEqual(deriveRuleId(undefined), 'unknown');
});

test('deriveExpectedDisposition returns null for null and undefined without throwing', () => {
  assert.strictEqual(deriveExpectedDisposition(null), null);
  assert.strictEqual(deriveExpectedDisposition(undefined), null);
});
