'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computePremiseEvidence, hasCheckableClaim, runPremiseCheck, runPremiseCheckAsPostImplement,
  parsePremiseVerdict, checkCitations, checkPrerequisiteClaim,
} = require('./candidate-premise-check.js');

const task = (over = {}) => ({
  source: 'pipeline_forensics_fix',
  promptContext: {
    candidateId: 'AC-16', title: 't', files: ['src/reject-retry-check.js'],
    fetchedFiles: [{ path: 'src/reject-retry-check.js', content: 'function isReviewRejection(task) { return task.blockedStage === \'review\'; }\n' }],
    body: 'Problem: reject-retry-check.js needs a guard.',
    ...over.promptContext,
  },
  ...over,
});

// --- checkPrerequisiteClaim (the real AC-16/AC-18 shape) -------------------------------

test('checkPrerequisiteClaim: flags a candidate claiming an existing gate that appears nowhere in the real fetched content', () => {
  const t = task({
    promptContext: {
      body: 'Problem: the existing `detectExternalDependency` gate stamps needsClarification, but reject-retry-check.js has no guard against it.',
      fetchedFiles: [{ path: 'src/reject-retry-check.js', content: 'function isReviewRejection(task) { return task.blockedStage === \'review\'; }\n' }],
    },
  });
  const ev = computePremiseEvidence(t);
  assert.equal(ev.contradictions.length, 1);
  assert.equal(ev.contradictions[0].kind, 'unverified-prerequisite');
  assert.match(ev.contradictions[0].detail, /detectExternalDependency/);
});

test('checkPrerequisiteClaim: does NOT flag a claim that IS backed by real fetched content', () => {
  const t = task({
    promptContext: {
      body: 'Problem: the existing `isReviewRejection` check does not distinguish X from Y.',
      fetchedFiles: [{ path: 'src/reject-retry-check.js', content: 'function isReviewRejection(task) { return task.blockedStage === \'review\'; }\n' }],
    },
  });
  assert.deepEqual(computePremiseEvidence(t).contradictions, []);
});

test('checkPrerequisiteClaim: no prerequisite-claim phrase in the body -> never looks at fetched content', () => {
  const t = task({ promptContext: { body: 'Problem: this file is too long.', fetchedFiles: [{ path: 'src/x.js', content: 'x' }] } });
  assert.deepEqual(checkPrerequisiteClaim(t, t.promptContext.body), []);
});

test('checkPrerequisiteClaim: no fetched files at all -> nothing to check, no false flag', () => {
  const t = task({ promptContext: { body: 'Problem: the existing `foo` gate handles this.', fetchedFiles: [] } });
  assert.deepEqual(checkPrerequisiteClaim(t, t.promptContext.body), []);
});

// --- checkCitations (same shape as the hygiene plugin's own arch-import-premise-check.js) ---

test('checkCitations: flags a symbol cited in a specific file that does not appear there', () => {
  const t = task({
    promptContext: {
      body: 'The draft cites `src/reject-retry-check.js` as defining `hasUnreliableGrounding`, but that name is not there.',
      fetchedFiles: [{ path: 'src/reject-retry-check.js', content: 'function isReviewRejection(task) { return task.blockedStage === \'review\'; }\n' }],
    },
  });
  const ev = computePremiseEvidence(t);
  assert.equal(ev.contradictions.length, 1);
  assert.equal(ev.contradictions[0].kind, 'missing-citation');
});

test('checkCitations: does not flag a symbol that really is in the cited file', () => {
  const t = task({
    promptContext: {
      body: 'The draft cites `src/reject-retry-check.js` as defining `isReviewRejection`.',
      fetchedFiles: [{ path: 'src/reject-retry-check.js', content: 'function isReviewRejection(task) { return task.blockedStage === \'review\'; }\n' }],
    },
  });
  assert.deepEqual(computePremiseEvidence(t).contradictions, []);
});

// --- hasCheckableClaim ------------------------------------------------------------------

test('hasCheckableClaim is true for a path citation or a prerequisite-claim phrase, false otherwise', () => {
  assert.equal(hasCheckableClaim(task({ promptContext: { body: 'cites `src/foo.js`' } })), true);
  assert.equal(hasCheckableClaim(task({ promptContext: { body: 'the existing thing already works' } })), true);
  assert.equal(hasCheckableClaim(task({ promptContext: { body: 'this file is too long, split it' } })), false);
});

// --- parsePremiseVerdict ------------------------------------------------------------------

test('parsePremiseVerdict parses PREMISE_VALID and PREMISE_INVALID, falls back to ok on noise', () => {
  assert.deepEqual(parsePremiseVerdict('PREMISE_VALID'), { verdict: 'ok' });
  assert.deepEqual(parsePremiseVerdict('PREMISE_INVALID -- the gate does not exist'), { verdict: 'invalid-premise', reason: 'the gate does not exist' });
  assert.deepEqual(parsePremiseVerdict('some unrelated garbage'), { verdict: 'ok' });
  assert.deepEqual(parsePremiseVerdict(''), { verdict: 'ok' });
});

// --- runPremiseCheck: deterministic-first, model-fallback-second -----------------------

test('runPremiseCheck returns invalid-premise from deterministic evidence alone, never calling the model', async () => {
  const t = task({
    promptContext: {
      body: 'Problem: the existing `detectExternalDependency` gate already handles this.',
      fetchedFiles: [{ path: 'src/reject-retry-check.js', content: 'function isReviewRejection(task) {}\n' }],
    },
  });
  let called = false;
  const result = await runPremiseCheck(t, { call: async () => { called = true; return { response: 'PREMISE_VALID' }; } });
  assert.equal(result.verdict, 'invalid-premise');
  assert.equal(called, false, 'deterministic evidence alone must short-circuit before any model call');
});

test('runPremiseCheck skips the model entirely when the candidate makes no checkable claim', async () => {
  const t = task({ promptContext: { body: 'Problem: this file is too long.', fetchedFiles: [] } });
  let called = false;
  const result = await runPremiseCheck(t, { call: async () => { called = true; return { response: 'PREMISE_INVALID -- x' }; } });
  assert.equal(result.verdict, 'ok');
  assert.equal(called, false);
});

test('runPremiseCheck falls back to the model for a checkable-but-not-deterministically-settled claim', async () => {
  const t = task({
    promptContext: {
      body: 'Problem: the existing retry logic already handles external dependencies correctly.',
      fetchedFiles: [{ path: 'src/reject-retry-check.js', content: 'function isReviewRejection(task) {}\n' }],
    },
  });
  const result = await runPremiseCheck(t, { call: async () => ({ response: 'PREMISE_INVALID -- no such handling exists' }) });
  assert.equal(result.verdict, 'invalid-premise');
  assert.match(result.reason, /no such handling exists/);
});

test('runPremiseCheck is advisory: a throwing call() never blocks, returns ok', async () => {
  const t = task({ promptContext: { body: 'Problem: the existing thing already works.', fetchedFiles: [{ path: 'src/x.js', content: 'y' }] } });
  const result = await runPremiseCheck(t, { call: async () => { throw new Error('model down'); } });
  assert.equal(result.verdict, 'ok');
});

test('runPremiseCheck respects the AGENT_MANAGER_CANDIDATE_PREMISE_CHECK=false kill switch', async () => {
  process.env.AGENT_MANAGER_CANDIDATE_PREMISE_CHECK = 'false';
  try {
    const t = task({
      promptContext: {
        body: 'Problem: the existing `detectExternalDependency` gate already handles this.',
        fetchedFiles: [{ path: 'src/reject-retry-check.js', content: 'x' }],
      },
    });
    const result = await runPremiseCheck(t, { call: async () => ({ response: 'PREMISE_INVALID -- x' }) });
    assert.equal(result.verdict, 'ok');
  } finally {
    delete process.env.AGENT_MANAGER_CANDIDATE_PREMISE_CHECK;
  }
});

test('runPremiseCheck without a call function is advisory-safe (no caller means no check)', async () => {
  const t = task({
    promptContext: {
      body: 'Problem: the existing retry logic already handles this correctly.',
      fetchedFiles: [{ path: 'src/reject-retry-check.js', content: 'x' }],
    },
  });
  const result = await runPremiseCheck(t, {});
  assert.equal(result.verdict, 'ok');
});

// --- runPremiseCheckAsPostImplement: the postImplementCheck adapter --------------------

test('runPremiseCheckAsPostImplement matches the (task, implementResponse, opts) hook signature and ignores implementResponse', async () => {
  const t = task({
    promptContext: {
      body: 'Problem: the existing `detectExternalDependency` gate already handles this.',
      fetchedFiles: [{ path: 'src/reject-retry-check.js', content: 'x' }],
    },
  });
  const result = await runPremiseCheckAsPostImplement(t, 'this implement response text is irrelevant to the check', {
    call: async () => ({ response: 'PREMISE_VALID' }), // must not even be reached -- deterministic evidence wins first
  });
  assert.equal(result.verdict, 'invalid-premise');
});
