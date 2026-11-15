'use strict';

// Tests for src/lib/plan-retry-strategy.js (HUB0316 · 2/4).
//
// Sets HOME and state paths to temp dirs so no real filesystem state is
// touched. Uses node:test (the repo's test runner).
//
// Run: node --test tests/unit/plan-retry.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Set HOME to a temp dir before requiring the module so any state paths
// resolved internally point at the temp directory.
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-retry-test-'));
const originalHome = process.env.HOME;
process.env.HOME = tempHome;

const { MAX_RETRIES, RETRY_STRATEGIES, runWithRetry } = require('../../src/lib/plan-retry-strategy');

test.after(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

test('exports MAX_RETRIES === 3', () => {
  assert.equal(MAX_RETRIES, 3);
});

test('exports RETRY_STRATEGIES with the shared-contract values in order', () => {
  assert.deepEqual(RETRY_STRATEGIES, [
    'larger-output-budget',
    'simplified-request',
    'constraint-heavy-prompt',
  ]);
  assert.equal(RETRY_STRATEGIES.length, 3);
});

test('exports runWithRetry as a function', () => {
  assert.equal(typeof runWithRetry, 'function');
});

// ---------------------------------------------------------------------------
// runWithRetry — happy path
// ---------------------------------------------------------------------------

test('runWithRetry: returns plan on first strategy when planner produces a valid plan', () => {
  const planner = () => 'Step 1: create the db. Step 2: write migrations. Step 3: deploy.';
  const result = runWithRetry({ planner, task: { id: 't1' } });
  assert.equal(result.exhausted, false);
  assert.equal(result.plan, 'Step 1: create the db. Step 2: write migrations. Step 3: deploy.');
  assert.equal(result.strategy, 'larger-output-budget');
});

test('runWithRetry: calls planner exactly once on success', () => {
  let calls = 0;
  const planner = () => {
    calls++;
    return 'Step 1: do X. Step 2: do Y. Step 3: do Z. Step 4: ship it.';
  };
  const result = runWithRetry({ planner, task: { id: 't1' } });
  assert.equal(result.exhausted, false);
  assert.equal(calls, 1);
});

// ---------------------------------------------------------------------------
// runWithRetry — strategy advancement
// ---------------------------------------------------------------------------

test('runWithRetry: advances to next strategy when first plan is degenerate (too short)', () => {
  let calls = 0;
  const planner = () => {
    calls++;
    if (calls === 1) return 'short'; // too short for isDegeneratePlan (needs >= 50 chars)
    return 'Step 1: create the db schema. Step 2: write migrations. Step 3: run tests. Step 4: deploy.';
  };
  const result = runWithRetry({ planner, task: { id: 't1' } });
  assert.equal(result.exhausted, false);
  assert.equal(result.strategy, 'simplified-request');
  assert.equal(calls, 2);
});

test('runWithRetry: advances through all strategies and reports exhausted=true', () => {
  const planner = () => 'x'; // always degenerate
  const result = runWithRetry({ planner, task: { id: 't1' } });
  assert.equal(result.exhausted, true);
  assert.equal(result.plan, null);
  assert.equal(result.strategy, 'constraint-heavy-prompt');
});

test('runWithRetry: treats null plan as invalid and advances strategy', () => {
  let calls = 0;
  const planner = () => {
    calls++;
    if (calls < 3) return null;
    return 'Step 1: create the db. Step 2: write migrations. Step 3: run tests. Step 4: ship.';
  };
  const result = runWithRetry({ planner, task: { id: 't1' } });
  assert.equal(result.exhausted, false);
  assert.equal(result.strategy, 'constraint-heavy-prompt');
  assert.equal(calls, 3);
});

test('runWithRetry: treats undefined plan as invalid and advances strategy', () => {
  let calls = 0;
  const planner = () => {
    calls++;
    if (calls < 3) return undefined;
    return 'Step 1: create the db. Step 2: write migrations. Step 3: run tests. Step 4: ship.';
  };
  const result = runWithRetry({ planner, task: { id: 't1' } });
  assert.equal(result.exhausted, false);
  assert.equal(result.strategy, 'constraint-heavy-prompt');
  assert.equal(calls, 3);
});

test('runWithRetry: treats empty string plan as invalid and advances strategy', () => {
  let calls = 0;
  const planner = () => {
    calls++;
    if (calls < 3) return '';
    return 'Step 1: create the db. Step 2: write migrations. Step 3: run tests. Step 4: ship.';
  };
  const result = runWithRetry({ planner, task: { id: 't1' } });
  assert.equal(result.exhausted, false);
  assert.equal(result.strategy, 'constraint-heavy-prompt');
  assert.equal(calls, 3);
});

// ---------------------------------------------------------------------------
// runWithRetry — exhaustion
// ---------------------------------------------------------------------------

test('runWithRetry: returns exhausted=true when planner always returns null', () => {
  const planner = () => null;
  const result = runWithRetry({ planner, task: { id: 't1' } });
  assert.equal(result.exhausted, true);
  assert.equal(result.plan, null);
  assert.equal(result.strategy, 'constraint-heavy-prompt');
});

test('runWithRetry: returns exhausted=true when planner throws every time', () => {
  const planner = () => { throw new Error('boom'); };
  let result;
  try {
    result = runWithRetry({ planner, task: { id: 't1' } });
  } catch (_) {
    assert.fail('runWithRetry should not propagate planner errors');
  }
  assert.equal(result.exhausted, true);
  assert.equal(result.plan, null);
  assert.equal(result.strategy, 'constraint-heavy-prompt');
});

test('runWithRetry: returns exhausted=true for plan classified as incomplete', () => {
  const planner = () => 'Step 1: create the database'; // no terminal punctuation
  const result = runWithRetry({ planner, task: { id: 't1' } });
  assert.equal(result.exhausted, true);
  assert.equal(result.plan, null);
});

test('runWithRetry: returns exhausted=true for plan classified as exploratory narration', () => {
  const plan = "I think maybe we could use PostgreSQL, or perhaps MongoDB. I'm not sure which is better. Maybe we should consider the trade-offs.";
  const planner = () => plan;
  const result = runWithRetry({ planner, task: { id: 't1' } });
  assert.equal(result.exhausted, true);
  assert.equal(result.plan, null);
});

// ---------------------------------------------------------------------------
// runWithRetry — attempt parameter
// ---------------------------------------------------------------------------

test('runWithRetry: attempt=2 skips the first strategy', () => {
  const planner = () => 'Step 1: create the db. Step 2: write migrations. Step 3: run tests. Step 4: ship.';
  const result = runWithRetry({ planner, task: { id: 't1' }, attempt: 2 });
  assert.equal(result.exhausted, false);
  assert.equal(result.strategy, 'simplified-request');
});

test('runWithRetry: attempt=3 uses only the last strategy', () => {
  const planner = () => 'Step 1: create the db. Step 2: write migrations. Step 3: run tests. Step 4: ship.';
  const result = runWithRetry({ planner, task: { id: 't1' }, attempt: 3 });
  assert.equal(result.exhausted, false);
  assert.equal(result.strategy, 'constraint-heavy-prompt');
});

test('runWithRetry: attempt beyond MAX_RETRIES clamps to last strategy and returns exhausted', () => {
  let calls = 0;
  const planner = () => {
    calls++;
    return 'Step 1: create the db. Step 2: write migrations. Step 3: run tests. Step 4: ship.';
  };
  const result = runWithRetry({ planner, task: { id: 't1' }, attempt: 99 });
  assert.equal(result.exhausted, true);
  assert.equal(result.strategy, 'constraint-heavy-prompt');
  assert.equal(calls, 0);
});

test('runWithRetry: attempt=0 clamps to 1 (first strategy)', () => {
  const planner = () => 'Step 1: create the db. Step 2: write migrations. Step 3: run tests. Step 4: ship.';
  const result = runWithRetry({ planner, task: { id: 't1' }, attempt: 0 });
  assert.equal(result.exhausted, false);
  assert.equal(result.strategy, 'larger-output-budget');
});

// ---------------------------------------------------------------------------
// runWithRetry — input validation
// ---------------------------------------------------------------------------

test('runWithRetry: throws TypeError when planner is not a function', () => {
  assert.throws(
    () => runWithRetry({ planner: 'not-a-fn', task: { id: 't1' } }),
    TypeError,
  );
});

test('runWithRetry: throws TypeError when task is not an object', () => {
  assert.throws(
    () => runWithRetry({ planner: () => 'ok', task: 'bad' }),
    TypeError,
  );
});

test('runWithRetry: throws TypeError when task is null', () => {
  assert.throws(
    () => runWithRetry({ planner: () => 'ok', task: null }),
    TypeError,
  );
});
