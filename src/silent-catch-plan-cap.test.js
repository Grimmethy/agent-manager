'use strict';

// Unit tests for silent-catch-plan-cap.js -- capPlanStageOutput's
// (ruleId, expectedDisposition) gating and the SILENT_CATCH_PLAN_MAX_CHARS
// bound. Pure module, no I/O, no fixtures.

const test = require('node:test');
const assert = require('node:assert/strict');
const { SILENT_CATCH_PLAN_MAX_CHARS, capPlanStageOutput } = require('./silent-catch-plan-cap.js');

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
