'use strict';

// Unit tests for ab-model-select.js. The load-bearing guarantees: (1) fewer than 2
// candidates is always a no-op (null), matching resolveStrategy's own backward-
// compatibility guarantee for an unset/single-entry ORNITH_AB_MODELS; (2) selection is
// deterministic per taskId, so a redraft/retry of the same task keeps comparing against
// the same candidate rather than a fresh coin flip each time.
//
// Run: node --test src/ab-model-select.test.js  (or `npm test`)

const test = require('node:test');
const assert = require('node:assert/strict');
const { selectAbModel } = require('./ab-model-select.js');

test('returns null for an empty candidate list', () => {
  assert.equal(selectAbModel('task-1', []), null);
});

test('returns null for a single-entry candidate list (nothing to A/B against)', () => {
  assert.equal(selectAbModel('task-1', ['ornith:35b']), null);
});

test('returns null for a null/undefined candidate list', () => {
  assert.equal(selectAbModel('task-1', null), null);
  assert.equal(selectAbModel('task-1', undefined), null);
});

test('always picks one of the given candidates', () => {
  const candidates = ['ornith:35b', 'claude:sonnet', 'qwen3.8:27b-q4_K_M'];
  for (const taskId of ['a', 'b', 'c', 'task-123', 'adhoc-brain-dump-bd-999']) {
    assert.ok(candidates.includes(selectAbModel(taskId, candidates)));
  }
});

test('same taskId always resolves to the same candidate (retry consistency)', () => {
  const candidates = ['ornith:35b', 'claude:sonnet'];
  const first = selectAbModel('stable-task-id', candidates);
  for (let i = 0; i < 20; i++) {
    assert.equal(selectAbModel('stable-task-id', candidates), first);
  }
});

test('different taskIds are not all forced onto the same candidate (spot-check actual variation)', () => {
  const candidates = ['ornith:35b', 'claude:sonnet'];
  const results = new Set();
  for (let i = 0; i < 50; i++) {
    results.add(selectAbModel(`task-${i}`, candidates));
  }
  // Not a statistical rigor test -- just confirms selection isn't secretly constant
  // across different inputs (e.g. a hashing bug that always reads the same bytes).
  assert.ok(results.size > 1, 'expected selection to vary across different taskIds');
});
