'use strict';

// Tests for src/apply-outcome-classifiers.js -- the RULES-array design landed via PR #162
// (the "wire-classifier-into-task-disposition" sibling), NOT the discarded sibling
// implementation's incompatible ctx/return shape. Pins the contract task-disposition.js's
// step-7 call site depends on: classifyApplyOutcome(ctx) -> { stage, detail }, where stage
// is a TERMINAL_STAGES value ('noop' is the safe fallback when RULES is empty).
//
// 2026-09-11: two siblings of the same coordinator hub independently authored a FULL,
// incompatible src/apply-outcome-classifiers.js (add/add conflict caught by cherry-pick
// during manual landing). The surviving/landed shape is the one exercised here: ctx
// { task, detail, taskId, mainBranch, shipCtx, applied } and result { stage, detail }.

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyApplyOutcome, RULES } = require('./apply-outcome-classifiers.js');

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

test('default fallback with empty RULES: stage is noop and detail carries the outcome= prefix', () => {
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

test('export surface: classifyApplyOutcome is a function, RULES is a (shipped-empty) array', () => {
  assert.equal(typeof classifyApplyOutcome, 'function');
  assert.ok(Array.isArray(RULES));
  assert.equal(RULES.length, 0, 'the shipped module is a stub: RULES is empty by default');
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
