'use strict';

// Tests for src/apply-outcome-classifiers.js -- the RULES-array design landed via PR #162
// (the "wire-classifier-into-task-disposition" sibling), NOT the discarded sibling
// implementation's incompatible ctx/return shape. Pins the contract task-disposition.js's
// step-7 call site depends on: classifyApplyOutcome(ctx) -> { stage, detail }, where stage
// is a TERMINAL_STAGES value ('noop' is the safe fallback when no rule matches).
// 2026-09-27: RULES now ships with one seeded rule (classifyAdvisoryReport) routing
// the advisory report sources to 'filed' instead of the 'noop' fall-through.
//
// 2026-09-11: two siblings of the same coordinator hub independently authored a FULL,
// incompatible src/apply-outcome-classifiers.js (add/add conflict caught by cherry-pick
// during manual landing). The surviving/landed shape is the one exercised here: ctx
// { task, detail, taskId, mainBranch, shipCtx, applied } and result { stage, detail }.

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyApplyOutcome, RULES } = require('./apply-outcome-classifiers.js');
const { TERMINAL_STAGES } = require('./task-disposition.js');

// The advisory report sources named by src/advisory-null-outcome.js's null-outcome
// recogniser -- an applied report from any of them is a completed inspection whose
// record is archival material, classified to the in-contract 'filed' stage.
const ADVISORY_SOURCES = ['pipeline_debrief', 'pipeline_forensics', 'pipeline_health_audit', 'capability_debrief'];

function ctxFor(overrides = {}) {
  return {
    task: { id: 't-1' },
    detail: 'applied some work',
    taskId: 't-1',
    mainBranch: 'master',
    shipCtx: null,
    applied: { stage: 'applied', detail: 'applied some work' },
    ...overrides,
  };
}

test('default fallback (a non-advisory ctx the seeded rule skips): stage is noop and detail carries the outcome= prefix', () => {
  const result = classifyApplyOutcome(ctxFor({ detail: 'mystery apply outcome' }));
  assert.equal(result.stage, 'noop');
  assert.equal(typeof result.detail, 'string');
  assert.ok(result.detail.startsWith('outcome=unclassified'), `detail should start with "outcome=unclassified", got: ${result.detail}`);
  // The landed result shape is exactly { stage, detail } -- no extra fields from the
  // discarded sibling design.
  assert.deepEqual(Object.keys(result).sort(), ['detail', 'stage']);
});

test('a seeded rule is consulted and its non-null return wins over the default', () => {
  RULES.push((ctx) => ({ stage: 'filed', detail: `outcome=filed: ${ctx.detail}` }));
  try {
    const result = classifyApplyOutcome(ctxFor());
    assert.equal(result.stage, 'filed');
    assert.equal(result.detail, 'outcome=filed: applied some work');
  } finally {
    RULES.pop();
  }
});

test('first-match-wins: an earlier rule that matches shadows a later rule', () => {
  RULES.push((ctx) => ({ stage: 'filed', detail: 'first' }));
  RULES.push((ctx) => ({ stage: 'noop', detail: 'second' }));
  try {
    const result = classifyApplyOutcome(ctxFor());
    assert.equal(result.stage, 'filed');
    assert.equal(result.detail, 'first');
  } finally {
    RULES.pop();
    RULES.pop();
  }
});

test('a rule that returns null falls through to the next rule', () => {
  RULES.push(() => null);
  RULES.push((ctx) => ({ stage: 'filed', detail: 'second' }));
  try {
    const result = classifyApplyOutcome(ctxFor());
    assert.equal(result.stage, 'filed');
    assert.equal(result.detail, 'second');
  } finally {
    RULES.pop();
    RULES.pop();
  }
});

test('rules receive the caller-provided ctx (task-disposition.js step-7 shape)', () => {
  let seen = null;
  RULES.push((ctx) => { seen = ctx; return { stage: 'filed', detail: 'matched' }; });
  try {
    const ctx = ctxFor({ detail: 'the detail string' });
    classifyApplyOutcome(ctx);
    assert.equal(seen.detail, 'the detail string');
    assert.equal(seen.taskId, 't-1');
    assert.equal(seen.mainBranch, 'master');
    assert.equal(seen.shipCtx, null);
    assert.equal(seen.task.id, 't-1');
    assert.equal(seen.applied.stage, 'applied');
  } finally {
    RULES.pop();
  }
});

test('export surface: classifyApplyOutcome is a function, RULES is a non-empty array seeded with the advisory rule', () => {
  assert.equal(typeof classifyApplyOutcome, 'function');
  assert.ok(Array.isArray(RULES));
  assert.equal(RULES.length, 1, 'RULES ships with exactly the seeded advisory-report rule');
});

test('an advisory report apply (each named advisory source) classifies to the in-contract filed stage', () => {
  for (const source of ADVISORY_SOURCES) {
    const result = classifyApplyOutcome(ctxFor({ task: { id: 't-1', source } }));
    assert.equal(result.stage, 'filed', `${source} should classify to filed`);
    assert.ok(result.detail.startsWith('outcome=filed'), `${source} detail should start with "outcome=filed", got: ${result.detail}`);
    assert.ok(result.detail.includes(source), `${source} detail should name the source, got: ${result.detail}`);
    assert.ok(TERMINAL_STAGES.has(result.stage), `${source}: stage "${result.stage}" must be a TERMINAL_STAGES member`);
  }
});

test('a non-advisory unclassifiable apply still falls through to the noop default (regression guard)', () => {
  const result = classifyApplyOutcome(ctxFor({ task: { id: 't-1', source: 'candidate-fulfillment' }, detail: 'mystery apply outcome' }));
  assert.equal(result.stage, 'noop');
  assert.ok(result.detail.startsWith('outcome=unclassified'), `detail should start with "outcome=unclassified", got: ${result.detail}`);
  assert.ok(TERMINAL_STAGES.has(result.stage), 'noop must be a TERMINAL_STAGES member');
});

test('TERMINAL_STAGES is unchanged: exactly the 9 pre-existing values (the classifier adds no new stage)', () => {
  const sorted = [...TERMINAL_STAGES].sort();
  assert.equal(sorted.length, 9, 'TERMINAL_STAGES must still have exactly 9 members (the 8 named stages plus the pre-existing aged-out)');
  assert.deepEqual(sorted, ['abandoned', 'aged-out', 'applied-direct', 'dismissed', 'filed', 'merged', 'noop', 'pending-merge', 'superseded']);
});

test('tolerates a minimal ctx (missing detail/taskId/mainBranch/shipCtx/applied) without throwing', () => {
  // Guards the exact incident failure mode: a caller passing the WRONG ctx shape must
  // still receive a well-formed { stage, detail } result, never a crash or a missing
  // .stage field (which would have broken TERMINAL_STAGES downstream).
  let result;
  assert.doesNotThrow(() => { result = classifyApplyOutcome({ task: {} }); });
  assert.equal(result.stage, 'noop');
  assert.equal(typeof result.detail, 'string');
  assert.deepEqual(Object.keys(result).sort(), ['detail', 'stage']);
});
