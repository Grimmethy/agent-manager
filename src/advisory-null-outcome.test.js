'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyNullOutcome, MIN_JUSTIFICATION_CHARS } = require('./advisory-null-outcome.js');

// Shapes copied from real drafts in queue/ (2026-09-27): a forensics null (449-560 chars), the health-audit
// `FALSE POSITIVE -- ...` line, and a debrief whose null is a trailing line after WHAT / SO WHAT.
const FORENSICS_NULL = 'NO CLEAR ROOT CAUSE -- the bundle contains zero model_calls rows, zero HISTORY-STAGE TRACE entries, and zero contrast "winner" tasks, so there is no evidence of which tier the subject reached; the single additional signal needed is the subject\'s tier-by-tier trace so a counterfactual can be grounded rather than inferred.';
const HEALTH_NULL = 'FALSE POSITIVE -- The audit correctly detected a real anomaly (many pending tasks with few completions and Ollama timeouts) but it is a live operational event, not a code defect: no matched file shows a root cause worth patching.';
const DEBRIEF_NULL = [
  'WHAT',
  'All 25 shipped tasks share one source and one model-call profile.',
  '',
  'SO WHAT',
  'None of the four flag categories cleanly apply.',
  '',
  'NO CONFIDENT INEFFICIENCY -- the one additional signal that would be needed is a model_calls row showing the plan or critique stage.',
].join('\n');

test('pipeline_forensics: a well-formed NO CLEAR ROOT CAUSE line is a null outcome', () => {
  const r = classifyNullOutcome('pipeline_forensics', FORENSICS_NULL);
  assert.equal(r.kind, 'no-clear-root-cause');
  assert.match(r.justification, /^the bundle contains zero model_calls rows/);
});

test('pipeline_forensics: needs a real justification, and a report that merely mentions the phrase is not a null', () => {
  assert.equal(classifyNullOutcome('pipeline_forensics', 'NO CLEAR ROOT CAUSE'), null);
  assert.equal(classifyNullOutcome('pipeline_forensics', 'NO CLEAR ROOT CAUSE -- short'), null);
  assert.equal(classifyNullOutcome('pipeline_forensics', `ROOT CAUSE 1: x\n\n${FORENSICS_NULL}`), null);
  assert.ok('x'.repeat(MIN_JUSTIFICATION_CHARS - 1).length < MIN_JUSTIFICATION_CHARS);
});

test('pipeline_health_audit: a plain FALSE POSITIVE line is a null; a file-change JSON or fenced block is not', () => {
  assert.equal(classifyNullOutcome('pipeline_health_audit', HEALTH_NULL).kind, 'false-positive');
  assert.equal(classifyNullOutcome('pipeline_health_audit', 'FALSE POSITIVE -- x'), null);
  assert.equal(classifyNullOutcome('pipeline_health_audit', '{"mode":"edit","file":"src/a.js","find":"a","replace":"b"}'), null);
  assert.equal(classifyNullOutcome('pipeline_health_audit', `FALSE POSITIVE -- ${'y'.repeat(60)}\n\`\`\`json\n{"mode":"edit"}\n\`\`\``), null);
});

test('pipeline_debrief: a justified NO CONFIDENT INEFFICIENCY line inside the report is a null', () => {
  const r = classifyNullOutcome('pipeline_debrief', DEBRIEF_NULL);
  assert.equal(r.kind, 'no-confident-inefficiency');
  assert.match(r.justification, /model_calls row/);
});

test('pipeline_debrief: contradictory or partial uses of the phrase are NOT nulls (real blocked drafts)', () => {
  const j = 'the evidence does show real, bounded waste in the brain_dump_sort plan and critique stages';
  assert.equal(classifyNullOutcome('pipeline_debrief', `SO WHAT\nx\n\nNO CONFIDENT INEFFICIENCY does not apply — ${j}.`), null, '"does not apply" means the opposite');
  assert.equal(classifyNullOutcome('pipeline_debrief', `NO CONFIDENT INEFFICIENCY\n\nThe evidence shows a clear, systematic inefficiency: ${j}.`), null, 'a bare sentinel with no justification on the line');
  assert.equal(classifyNullOutcome('pipeline_debrief', `NO CONFIDENT INEFFICIENCY for the manual adhoc cluster: ${j}, but the rest is flagged.`), null, 'a cluster-scoped statement has no dash form');
  assert.equal(classifyNullOutcome('pipeline_debrief', `${DEBRIEF_NULL}\n\nNOW WHAT\n1. Make plan deterministic -- Files: src/a.js. Why: x.`), null, 'a numbered NOW WHAT list means it flagged something');
});

test('other sources and empty input are never a null outcome', () => {
  assert.equal(classifyNullOutcome('arch_review', FORENSICS_NULL), null);
  assert.equal(classifyNullOutcome('pipeline_forensics', HEALTH_NULL), null, 'each source only recognises its own form');
  assert.equal(classifyNullOutcome('pipeline_forensics', ''), null);
  assert.equal(classifyNullOutcome('pipeline_forensics', undefined), null);
});

test('AGENT_MANAGER_NULL_OUTCOME_APPROVAL=false disables the classifier', () => {
  const prev = process.env.AGENT_MANAGER_NULL_OUTCOME_APPROVAL;
  process.env.AGENT_MANAGER_NULL_OUTCOME_APPROVAL = 'false';
  try {
    assert.equal(classifyNullOutcome('pipeline_forensics', FORENSICS_NULL), null);
  } finally {
    if (prev === undefined) delete process.env.AGENT_MANAGER_NULL_OUTCOME_APPROVAL; else process.env.AGENT_MANAGER_NULL_OUTCOME_APPROVAL = prev;
  }
});
