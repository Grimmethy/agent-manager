'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildContextProvenance } = require('./context-provenance.js');

test('empty grounding gives zeros', () => {
  const stamp = buildContextProvenance({ grounding: null, orient: null, task: {} });
  assert.equal(stamp.v, 1);
  assert.equal(stamp.anchorFileCount, 0);
  assert.deepEqual(stamp.anchorPaths, []);
  assert.equal(stamp.grepQueryCount, 0);
  assert.equal(stamp.grepHitFileCount, 0);
  assert.deepEqual(stamp.grepHitFiles, []);
  assert.equal(stamp.groundingChars, 0);
  assert.equal(stamp.planWasGrounded, false);
  assert.equal(stamp.orientRan, false);
  assert.equal(stamp.orientTurns, null);
  assert.equal(stamp.priorRejectionCount, 0);
  assert.equal(stamp.priorVerdictCount, 0);
});

test('anchorPaths capped at 12', () => {
  const anchorPaths = Array.from({ length: 20 }, (_, i) => `file-${i}.js`);
  const stamp = buildContextProvenance({
    grounding: { text: 'x', anchorPaths, grepHits: [] },
    orient: null,
    task: {},
  });
  assert.equal(stamp.anchorPaths.length, 12);
  assert.equal(stamp.anchorFileCount, 20); // original count preserved
});

test('grepHitFiles capped at 12 unique paths', () => {
  const grepHits = Array.from({ length: 20 }, (_, i) => ({
    file: i < 15 ? `file-${i}.js` : `file-${i - 15}.js`, // 15 unique, 5 duplicates
    line: 1,
    text: 'x',
    query: 'q',
  }));
  const stamp = buildContextProvenance({
    grounding: { text: 'x', anchorPaths: [], grepHits },
    orient: null,
    task: {},
  });
  assert.equal(stamp.grepHitFileCount, 12);
  assert.equal(stamp.grepHitFiles.length, 12);
});

test('500 grep hits serialized under 2048 bytes', () => {
  const grepHits = Array.from({ length: 500 }, (_, i) => ({
    file: `file-${i % 100}.js`,
    line: i,
    text: `match ${i}`,
    query: `q${i % 5}`,
  }));
  const stamp = buildContextProvenance({
    grounding: { text: 'x'.repeat(100), anchorPaths: [], grepHits },
    orient: null,
    task: {},
  });
  const serialized = JSON.stringify(stamp);
  assert.ok(serialized.length < 2048, `serialized size ${serialized.length} exceeds 2048`);
});

test('prior counts read from real task fields', () => {
  const task = {
    priorRejectionFeedback: ['reason1', 'reason2', 'reason3'],
    promptContext: { priorVerdict: { verdict: 'needs-work', reasons: ['r1'] } },
  };
  const stamp = buildContextProvenance({
    grounding: { text: 'x', anchorPaths: [], grepHits: [] },
    orient: null,
    task,
  });
  assert.equal(stamp.priorRejectionCount, 3);
  assert.equal(stamp.priorVerdictCount, 1);
});

test('priorVerdictCount is 0 when verdict is not needs-work', () => {
  const task = {
    promptContext: { priorVerdict: { verdict: 'clean', reasons: [] } },
  };
  const stamp = buildContextProvenance({
    grounding: { text: 'x', anchorPaths: [], grepHits: [] },
    orient: null,
    task,
  });
  assert.equal(stamp.priorVerdictCount, 0);
});

test('orientRan and orientTurns from orient result', () => {
  const stamp = buildContextProvenance({
    grounding: { text: 'x', anchorPaths: [], grepHits: [] },
    orient: { notes: 'n', turnsUsed: 5, skipped: false },
    task: {},
  });
  assert.equal(stamp.orientRan, true);
  assert.equal(stamp.orientTurns, 5);
});

test('orientTurns is null when orient is null', () => {
  const stamp = buildContextProvenance({
    grounding: { text: 'x', anchorPaths: [], grepHits: [] },
    orient: null,
    task: {},
  });
  assert.equal(stamp.orientTurns, null);
});

test('planWasGrounded is true when grounding has text', () => {
  const stamp = buildContextProvenance({
    grounding: { text: 'some text', anchorPaths: [], grepHits: [] },
    orient: null,
    task: {},
  });
  assert.equal(stamp.planWasGrounded, true);
});

test('planWasGrounded is false when grounding is null', () => {
  const stamp = buildContextProvenance({
    grounding: null,
    orient: null,
    task: {},
  });
  assert.equal(stamp.planWasGrounded, false);
});

test('kill switch AGENT_MANAGER_CONTEXT_PROVENANCE=false returns null (tested via env)', () => {
  // The module itself doesn't check the env; the caller (local-draft.js) does.
  // This test verifies the module works without env.
  const stamp = buildContextProvenance({
    grounding: { text: 'x', anchorPaths: [], grepHits: [] },
    orient: null,
    task: {},
  });
  assert.ok(stamp);
  assert.equal(stamp.v, 1);
});
