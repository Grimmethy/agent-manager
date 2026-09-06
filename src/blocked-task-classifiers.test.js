'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyBlockedTask, categorizeBlockedReason, hasZeroHitHarnessSearch, hasUnreliableGrounding,
  hasInvalidPremise, signatureForTask, findClassifier, REASON_CATEGORIES,
} = require('./blocked-task-classifiers.js');

test('classifyBlockedTask recognizes a pre-stamped external-dependency task as environment-side, non-retryable', () => {
  const task = { needsClarification: { reason: 'external-dependency', openQuestions: ['x'] } };
  const result = classifyBlockedTask(task);
  assert.deepEqual(result, { category: 'external-dependency', faultSide: 'environment', retryable: false, classifierName: 'external-dependency' });
});

test('classifyBlockedTask recognizes unreliable grounding as harness-side, non-retryable', () => {
  const task = { promptContext: { fetchedFiles: [{ path: 'src/foo.js', anchorConfidence: 'none' }] } };
  const result = classifyBlockedTask(task);
  assert.deepEqual(result, { category: 'unreliable-grounding', faultSide: 'harness', retryable: false, classifierName: 'unreliable-grounding' });
});

test('classifyBlockedTask recognizes a zero-hit harness search as harness-side, but still RETRYABLE', () => {
  const task = { history: [{ stage: 'harness-search', detail: '0 hit(s) found' }] };
  const result = classifyBlockedTask(task);
  assert.deepEqual(result, { category: 'harness-search-zero-results', faultSide: 'harness', retryable: true, classifierName: 'harness-search-zero-results' });
});

test('classifyBlockedTask recognizes an "Invalid premise:" blockedReason as environment-side, non-retryable', () => {
  const task = { blockedReason: 'Invalid premise: candidate claims `foo` already exists, but it does not' };
  const result = classifyBlockedTask(task);
  assert.deepEqual(result, { category: 'invalid-premise', faultSide: 'environment', retryable: false, classifierName: 'invalid-premise' });
});

test('hasInvalidPremise matches case-insensitively and is false for an unrelated reason', () => {
  assert.equal(hasInvalidPremise({ blockedReason: 'invalid premise: x' }), true);
  assert.equal(hasInvalidPremise({ blockedReason: 'INVALID PREMISE: x' }), true);
  assert.equal(hasInvalidPremise({ blockedReason: 'Ungrounded draft: x' }), false);
  assert.equal(hasInvalidPremise({}), false);
});

test('findClassifier("invalid-premise") has a buildQuestion that quotes the blockedReason detail', () => {
  const c = findClassifier('invalid-premise');
  assert.ok(c);
  const question = c.buildQuestion({ blockedReason: 'Invalid premise: the AC-13a gate was never built' });
  assert.match(question, /the AC-13a gate was never built/);
});

test('classifyBlockedTask maps each existing keyword category to faultSide:model, retryable:true', () => {
  const cases = [
    ['fabricated-ungrounded-claim', 'the draft cites a fabricated value nowhere in the source'],
    ['refusal-no-changes-needed', 'the draft is a refusal (no-changes-needed)'],
    ['empty-degenerate-draft', 'Implement pass degenerate: empty'],
    ['truncated-draft', 'the response was truncated mid-sentence'],
    ['inconclusive-review', 'the vote was inconclusive'],
  ];
  for (const [category, blockedReason] of cases) {
    const result = classifyBlockedTask({ blockedReason });
    assert.equal(result.category, category, `for reason "${blockedReason}"`);
    assert.equal(result.faultSide, 'model');
    assert.equal(result.retryable, true);
  }
});

test('classifyBlockedTask falls back to uncategorized/model/retryable for anything unrecognized', () => {
  const result = classifyBlockedTask({ blockedReason: 'something entirely novel that matches nothing' });
  assert.deepEqual(result, { category: 'uncategorized', faultSide: 'model', retryable: true, classifierName: null });
});

test('classifyBlockedTask falls back cleanly for a task with no blockedReason at all', () => {
  const result = classifyBlockedTask({});
  assert.equal(result.category, 'uncategorized');
});

test('priority order: external-dependency and unreliable-grounding are checked before the keyword categories', () => {
  // A task that would ALSO match a keyword category (blockedReason mentions "empty")
  // but is really external-dependency-gated must resolve to the more specific,
  // structural classification, not the generic keyword one.
  const task = {
    blockedReason: 'empty response from the model',
    needsClarification: { reason: 'external-dependency' },
  };
  assert.equal(classifyBlockedTask(task).category, 'external-dependency');
});

test('the 5 keyword categories are checked in the documented priority order', () => {
  // A reason matching both "fabricat" and "empty" resolves to the FIRST category
  // (fabricated-ungrounded-claim), matching the original REASON_CATEGORIES iteration
  // order this registry preserves verbatim.
  const result = classifyBlockedTask({ blockedReason: 'a fabricated, empty draft' });
  assert.equal(result.category, 'fabricated-ungrounded-claim');
});

test('categorizeBlockedReason is re-exported unchanged for external callers (pipeline-forensics.js, staleness-audit.js)', () => {
  assert.equal(categorizeBlockedReason('this claim is fabricated'), 'fabricated-ungrounded-claim');
  assert.equal(categorizeBlockedReason('nothing matches here'), null);
  assert.equal(categorizeBlockedReason(undefined), null);
});

test('hasZeroHitHarnessSearch and hasUnreliableGrounding are re-exported as standalone functions', () => {
  assert.equal(hasZeroHitHarnessSearch({ history: [{ stage: 'harness-search', detail: '0 result(s)' }] }), true);
  assert.equal(hasZeroHitHarnessSearch({ history: [] }), false);
  assert.equal(hasUnreliableGrounding({ promptContext: { fetchedFiles: [{ anchorConfidence: 'none' }] } }), true);
  assert.equal(hasUnreliableGrounding({ promptContext: { fetchedFiles: [{ anchorConfidence: 'strong' }] } }), false);
});

test('signatureForTask matches the exact `${source}::${category}` format, unchanged from before this registry existed', () => {
  assert.equal(signatureForTask({ source: 'observability_fix', blockedReason: 'fabricated claim' }), 'observability_fix::fabricated-ungrounded-claim');
  assert.equal(signatureForTask({ source: 'pipeline_forensics_fix', promptContext: { fetchedFiles: [{ anchorConfidence: 'none' }] } }), 'pipeline_forensics_fix::unreliable-grounding');
  assert.equal(signatureForTask({ blockedReason: 'nothing recognizable' }), null, 'uncategorized -> null, same as before');
  assert.equal(signatureForTask({ source: 'unknown-src' }), null);
});

test('findClassifier locates a registered classifier by name, including its buildQuestion for unreliable-grounding', () => {
  const c = findClassifier('unreliable-grounding');
  assert.ok(c);
  assert.equal(typeof c.buildQuestion, 'function');
  const question = c.buildQuestion({ promptContext: { fetchedFiles: [{ path: 'src/foo.js', anchorConfidence: 'none' }] } });
  assert.match(question, /src\/foo\.js/);
});

test('findClassifier returns null for an unknown name', () => {
  assert.equal(findClassifier('does-not-exist'), null);
});

test('REASON_CATEGORIES is exported unchanged in shape for staleness-audit.js\'s FABRICATION_KEYWORDS lookup', () => {
  const entry = REASON_CATEGORIES.find((c) => c.key === 'fabricated-ungrounded-claim');
  assert.ok(entry);
  assert.deepEqual(entry.keywords, ['fabricat', 'hallucinat', 'unverified claim', 'ungrounded']);
});
