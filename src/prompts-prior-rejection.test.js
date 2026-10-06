'use strict';

// Tests for the priorRejectionBlock hard-constraint wording in src/prompts.js.
// Mirrors the node --test convention used by src/agentic-draft-common.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { priorRejectionBlock, priorVerdictBlock, buildImplementPrompt, buildPlanPrompt } = require('./prompts.js');

test('priorRejectionBlock renders hard-constraint wording when feedback is present', () => {
  const task = { priorRejectionFeedback: ['Line 5 already contains `import logging`'] };
  const out = priorRejectionBlock(task);
  assert.equal(typeof out, 'string');
  assert.match(out, /HARD CONSTRAINT/);
  assert.match(out, /MUST NOT repeat/);
  // the specific feedback reason itself must be surfaced verbatim
  assert.match(out, /Line 5 already contains/);
  assert.match(out, /1\. Line 5 already contains/);
});

test('priorRejectionBlock returns empty string for an empty feedback array', () => {
  assert.equal(priorRejectionBlock({ priorRejectionFeedback: [] }), '');
});

test('priorRejectionBlock returns empty string when the feedback property is absent', () => {
  assert.equal(priorRejectionBlock({}), '');
});

test('priorRejectionBlock returns empty string for a non-array feedback value', () => {
  assert.equal(priorRejectionBlock({ priorRejectionFeedback: 'not an array' }), '');
});

// ---- priorVerdictBlock: a chat/manual needs-work verdict carried on promptContext.priorVerdict ----

// An adhoc task: its prompt builders are registered by core, unlike arch_review (a hygiene-plugin source).
// The dispatchers add the block for every source, so the source under test does not matter.
const verdictTask = (pv, extra = {}) => ({
  id: 't1', domain: 'adhoc', source: 'manual', title: 'T',
  promptContext: { rawText: 'the ask', priorVerdict: pv },
  ...extra,
});
const NEEDS_WORK = { verdict: 'needs-work', reasons: ['`pick(obj: Record<string, unknown>, keys)` makes pick return unknown -> 6 new TS errors; keep the return type `any`'], sha: 'abc', source: 'chat' };

test('priorVerdictBlock renders the needs-work reasons and tells the drafter not to repeat the change', () => {
  const out = priorVerdictBlock(verdictTask(NEEDS_WORK));
  assert.match(out, /A reviewer examined your previous attempt/);
  assert.match(out, /judged it needs-work/);
  assert.match(out, /Do not repeat that change/);
  assert.ok(out.includes('pick(obj: Record<string, unknown>, keys)'));
  assert.ok(out.includes('1. '));
});

test('priorVerdictBlock returns empty string when priorVerdict is absent, null, malformed, not needs-work, or has no usable reasons', () => {
  assert.equal(priorVerdictBlock({}), '');
  assert.equal(priorVerdictBlock({ promptContext: {} }), '');
  assert.equal(priorVerdictBlock(verdictTask(null)), '');
  assert.equal(priorVerdictBlock(verdictTask('needs-work')), '');
  assert.equal(priorVerdictBlock(verdictTask({ verdict: 'discard', reasons: ['x'] })), '');
  assert.equal(priorVerdictBlock(verdictTask({ verdict: 'merge', reasons: ['x'] })), '');
  assert.equal(priorVerdictBlock(verdictTask({ verdict: 'needs-work', reasons: [] })), '');
  assert.equal(priorVerdictBlock(verdictTask({ verdict: 'needs-work', reasons: ['  ', 7, null] })), '');
  assert.equal(priorVerdictBlock(verdictTask({ verdict: 'needs-work', reasons: 'not an array' })), '');
  assert.equal(priorVerdictBlock({ promptContext: 'string' }), '');
});

test('priorVerdictBlock caps the total reasons text at 1500 characters, on an entry boundary or with an ellipsis', () => {
  const long = { verdict: 'needs-work', reasons: ['a'.repeat(1000), 'b'.repeat(1000), 'c'.repeat(1000)] };
  const out = priorVerdictBlock(verdictTask(long));
  const reasonText = out.split('\n').filter((l) => /^\d+\. /.test(l)).map((l) => l.replace(/^\d+\. /, '')).join('');
  assert.ok(reasonText.length <= 1500, `reasons text was ${reasonText.length} chars`);
  assert.ok(out.includes('a'.repeat(1000)));
  assert.ok(out.includes('...'), 'the clipped second reason ends with an ellipsis');
  assert.ok(!out.includes('c'.repeat(50)), 'the third reason is dropped once the budget is spent');
});

test('buildImplementPrompt and buildPlanPrompt include the prior-verdict reasons when set, and not when absent', () => {
  const withV = verdictTask(NEEDS_WORK);
  const without = verdictTask(undefined);
  delete without.promptContext.priorVerdict;
  for (const build of [(t) => buildImplementPrompt(t, 'the plan'), (t) => buildPlanPrompt(t)]) {
    assert.ok(build(withV).includes('keep the return type `any`'));
    assert.ok(build(withV).includes('A reviewer examined your previous attempt'));
    assert.ok(!build(without).includes('A reviewer examined your previous attempt'));
  }
});

test('priorVerdictBlock composes after priorRejectionBlock without replacing it', () => {
  const t = verdictTask(NEEDS_WORK, { priorRejectionFeedback: ['an earlier pipeline rejection'] });
  const out = buildImplementPrompt(t, 'the plan');
  const iReject = out.indexOf('an earlier pipeline rejection');
  const iVerdict = out.indexOf('A reviewer examined your previous attempt');
  assert.ok(iReject >= 0 && iVerdict > iReject);
});
