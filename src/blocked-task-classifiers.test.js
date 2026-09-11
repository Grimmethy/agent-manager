'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyBlockedTask, categorizeBlockedReason, hasZeroHitHarnessSearch, hasUnreliableGrounding,
  hasInvalidPremise, hasFabricatedFilePath, signatureForTask, findClassifier, REASON_CATEGORIES,
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

test('classifyBlockedTask recognizes a "fabricated file path(s)" grounding block as model-side, NON-retryable', () => {
  const task = { blockedReason: 'Ungrounded draft: fabricated file path(s): src/agent-manager/task-queue.js -- not present anywhere in the target repo. A redraft cannot make an invented path real; re-file with an accurate citation, or archive if nothing applies.' };
  const result = classifyBlockedTask(task);
  assert.deepEqual(result, { category: 'fabricated-file-path', faultSide: 'model', retryable: false, classifierName: 'fabricated-file-path' });
});

test('fabricated-file-path wins over the retryable "fabricated-ungrounded-claim" keyword classifier (ordering)', () => {
  // The reason string contains BOTH "ungrounded" and "fabricat" -- the keyword classifier
  // would otherwise shadow it with retryable:true.
  const result = classifyBlockedTask({ blockedReason: 'Ungrounded draft: fabricated file path(s): src/nope.js -- not present anywhere in the target repo.' });
  assert.equal(result.classifierName, 'fabricated-file-path');
  assert.equal(result.retryable, false);
});

test('hasFabricatedFilePath matches the exact grounding-check prefix, case-insensitively, and nothing else', () => {
  assert.equal(hasFabricatedFilePath({ blockedReason: 'Ungrounded draft: fabricated file path(s): src/x.js -- ...' }), true);
  assert.equal(hasFabricatedFilePath({ blockedReason: 'UNGROUNDED DRAFT: FABRICATED FILE PATH(S): a.js' }), true);
  assert.equal(hasFabricatedFilePath({ blockedReason: 'Ungrounded draft: the class `Foo` is not in any fetched file' }), false); // a Check-1 fabricated-symbol block stays retryable
  assert.equal(hasFabricatedFilePath({ blockedReason: 'Invalid premise: x' }), false);
  assert.equal(hasFabricatedFilePath({}), false);
});

test('findClassifier("fabricated-file-path").buildQuestion names the paths and says a redraft cannot fix it', () => {
  const c = findClassifier('fabricated-file-path');
  assert.ok(c);
  const q = c.buildQuestion({ blockedReason: 'Ungrounded draft: fabricated file path(s): src/agent-manager/task-queue.js -- not present anywhere in the target repo.' });
  assert.match(q, /src\/agent-manager\/task-queue\.js/);
  assert.match(q, /blind redraft cannot fix this/i);
  assert.match(q, /Archive/);
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

test('categorizeBlockedReason recognizes the AC-45/AC-59 JSON-parse-failure shape (mixed case, real apply-group-b.js wording)', () => {
  assert.equal(
    categorizeBlockedReason('Invalid JSON in Group B implementResponse: Unexpected end of JSON input'),
    'json-parse-failure',
  );
  assert.equal(
    categorizeBlockedReason('invalid json: Unexpected token < in JSON at position 0'),
    'json-parse-failure',
  );
});

test('categorizeBlockedReason recognizes a false-positive-worded blockedReason (case-insensitive)', () => {
  assert.equal(categorizeBlockedReason('False positive: task was not actually blocked'), 'json-parse-failure');
  assert.equal(categorizeBlockedReason('FALSE POSITIVE after re-check'), 'json-parse-failure');
});

test('classifyBlockedTask returns json-parse-failure / model / retryable for a JSON-parse blockedReason, not uncategorized', () => {
  const result = classifyBlockedTask({ blockedReason: 'Invalid JSON in Group B implementResponse: Unexpected end of JSON input' });
  assert.deepEqual(result, { category: 'json-parse-failure', faultSide: 'model', retryable: true, classifierName: 'json-parse-failure' });
});

test('negative: the five pre-existing keyword categories still resolve to their own buckets', () => {
  const cases = [
    ['fabricated-ungrounded-claim', 'the draft contains a fabricated citation'],
    ['refusal-no-changes-needed', 'refusal: no-changes-needed'],
    ['empty-degenerate-draft', 'empty response from model'],
    ['truncated-draft', 'response was truncated'],
    ['inconclusive-review', 'review vote was inconclusive'],
  ];
  for (const [category, reason] of cases) {
    assert.equal(categorizeBlockedReason(reason), category, `for "${reason}"`);
  }
});

test('negative: an unknown reason still categorizes to null and still falls back to uncategorized', () => {
  assert.equal(categorizeBlockedReason('a genuinely novel failure nobody has a keyword for'), null);
  const result = classifyBlockedTask({ blockedReason: 'a genuinely novel failure nobody has a keyword for' });
  assert.equal(result.category, 'uncategorized');
  assert.equal(result.classifierName, null);
});

test('signatureForTask: json-parse-failure gets a distinct non-null signature; uncategorized stays null', () => {
  const classified = signatureForTask({ source: 'pipeline_forensics_fix', blockedReason: 'Invalid JSON in Group B implementResponse: Unexpected end of JSON input' });
  assert.equal(classified, 'pipeline_forensics_fix::json-parse-failure');
  assert.equal(signatureForTask({ source: 'pipeline_forensics_fix', blockedReason: 'a genuinely novel failure nobody has a keyword for' }), null);
  assert.notEqual(classified, null);
});
