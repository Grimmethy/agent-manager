'use strict';

// Unit tests for deterministic-draft-registry.js's registry mechanics (S4a of the
// hub-tasks extraction, 2026-09-24). runOnePassStyleDraft's own full flow (real source
// read + git diff capture) is exercised end to end already via script-extract.js's
// registered tryDraft (local-draft.test.js's "script-extract move task ... applied
// deterministically" tests) and mirrors decompose-review-registry.js's already-tested
// verifyOnePassStyleRederivation closely enough that a second from-scratch git fixture
// here would mostly duplicate that coverage; this file focuses on what's genuinely new:
// the register/dispatch/clear contract.
//
// Run: node --test src/deterministic-draft-registry.test.js

process.env.AGENT_MANAGER_REPO_ROOT = require('os').tmpdir();
process.env.AGENT_MANAGER_PIPELINE_DIR = process.env.AGENT_MANAGER_REPO_ROOT;

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  registerDeterministicDraft, tryRegisteredDeterministicDraft, clearDeterministicDraftRegistry,
} = require('./deterministic-draft-registry.js');

test('tryRegisteredDeterministicDraft returns null for a task with no deterministicApply kind', () => {
  assert.equal(tryRegisteredDeterministicDraft(null, {}), null);
  assert.equal(tryRegisteredDeterministicDraft({}, {}), null);
  assert.equal(tryRegisteredDeterministicDraft({ promptContext: {} }, {}), null);
});

test('tryRegisteredDeterministicDraft returns null for an unregistered kind', () => {
  assert.equal(tryRegisteredDeterministicDraft({ promptContext: { deterministicApply: 'nobody-registered-this-kind' } }, {}), null);
});

test('a registered kind\'s tryDraft() decides the outcome and receives (task, attempt)', () => {
  const seen = [];
  registerDeterministicDraft('test-kind-records-args', {
    tryDraft: (task, attempt) => { seen.push([task.id, attempt]); return { succeeded: true, blocked: false }; },
  });
  const result = tryRegisteredDeterministicDraft({ id: 't1', promptContext: { deterministicApply: 'test-kind-records-args' } }, { n: 1 });
  assert.deepEqual(result, { succeeded: true, blocked: false });
  assert.deepEqual(seen, [['t1', { n: 1 }]]);
});

test('registerDeterministicDraft overwrites (not throws) on a re-registered kind name', () => {
  registerDeterministicDraft('test-kind-dup', { tryDraft: () => null });
  assert.doesNotThrow(() => registerDeterministicDraft('test-kind-dup', { tryDraft: () => ({ succeeded: true, blocked: false }) }));
  assert.deepEqual(
    tryRegisteredDeterministicDraft({ promptContext: { deterministicApply: 'test-kind-dup' } }, {}),
    { succeeded: true, blocked: false },
  );
});

test('registerDeterministicDraft requires a non-empty kind string and a tryDraft function', () => {
  assert.throws(() => registerDeterministicDraft('', { tryDraft: () => null }), /non-empty string/);
  assert.throws(() => registerDeterministicDraft('test-kind-no-fn', {}), /tryDraft must be a function/);
});

// Run last: exercises clearDeterministicDraftRegistry, which wipes the SAME process-wide
// singleton script-extract.js registers 'script-extract' into (real, in core). Restores
// it immediately afterward so any other test file sharing this process (e.g.
// local-draft.test.js, via lib/deterministic-extract.js's require) isn't left with an
// empty registry.
test('clearDeterministicDraftRegistry empties the registry', () => {
  registerDeterministicDraft('test-kind-for-clear', { tryDraft: () => ({ succeeded: true, blocked: false }) });
  assert.deepEqual(
    tryRegisteredDeterministicDraft({ promptContext: { deterministicApply: 'test-kind-for-clear' } }, {}),
    { succeeded: true, blocked: false },
  );
  clearDeterministicDraftRegistry();
  assert.equal(tryRegisteredDeterministicDraft({ promptContext: { deterministicApply: 'test-kind-for-clear' } }, {}), null);

  // Restore production state (re-triggers script-extract.js's own registration call).
  delete require.cache[require.resolve('./script-extract.js')];
  require('./script-extract.js');
});
