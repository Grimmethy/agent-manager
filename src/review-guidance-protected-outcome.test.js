'use strict';

// 2026-09-08 -- regression guard for the "evidence-insufficiency is a valid terminal
// state" carve-out in the advisory-report review guidance strings (task family:
// pipeline_forensics' zero-winners contrast, filed from the 3rd confirmed live
// false-rejection of a draft that HONESTLY said the evidence could not support the
// requested comparison). The draft-side prompt already instructs the model to say so
// plainly (src/prompts.js pipelineForensicsImplementPrompt step 2); the review-side
// guidance must honour that instruction instead of treating the honest absence as a
// failure. The guidance strings are free-text handed to the LLM reviewer (no parser),
// so a string-contains check on the real constants is the meaningful assertion here.
// The strings are read straight out of src/task-sources.js (not required) so this test
// never triggers task-source registration/config side effects on load.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const TASK_SOURCES = path.join(__dirname, 'task-sources.js');

// Extracts the single-quoted string literal assigned to `const <name> = '...'` --
// the guidance strings are plain (non-template) literals with no escaped quotes, so a
// match up to the first `';` is the whole value.
function guidanceConstant(name) {
  const src = fs.readFileSync(TASK_SOURCES, 'utf8');
  const m = new RegExp(`const ${name} = '([\\s\\S]*?)';`).exec(src);
  assert.ok(m, `${name} constant not found in ${TASK_SOURCES}`);
  return m[1];
}

const FORENSICS = guidanceConstant('PIPELINE_FORENSICS_REVIEW_GUIDANCE');
const DEBRIEF = guidanceConstant('PIPELINE_DEBRIEF_REVIEW_GUIDANCE');

test('pipeline_forensics guidance protects a "0 contrast winner task(s)" draft from rejection', () => {
  // The exact draft shape the live blocked task carried, named verbatim in the guidance.
  assert.match(FORENSICS, /0 contrast winner task\(s\)/);
  assert.match(FORENSICS, /no successful sibling tasks to contrast against/);
  // ...and it is stated as a valid terminal outcome, explicitly not to be rejected.
  assert.match(FORENSICS, /valid, correct terminal outcome/);
  assert.match(FORENSICS, /do not reject a draft for failing to contrast against winners that do not exist/);
  // And the old over-broad reject condition is now qualified to the case where
  // winners WERE available (the actual defect that was misapplied).
  assert.match(FORENSICS, /no counterfactual and no contrast when winner tasks WERE actually available in the evidence/);
  // The carve-out names the specific section, symmetric with debrief naming its own.
  assert.match(FORENSICS, /a CONTRAST section that plainly says so/);
});

test('pipeline_forensics "NO CLEAR ROOT CAUSE" remains protected too', () => {
  assert.match(FORENSICS, /"NO CLEAR ROOT CAUSE" is a valid, correct outcome/);
});

test('pipeline_debrief guidance keeps its symmetric "NO CONFIDENT INEFFICIENCY" protection', () => {
  assert.match(DEBRIEF, /"NO CONFIDENT INEFFICIENCY" is a valid, correct outcome/);
  assert.match(DEBRIEF, /do NOT reject it under the hedging rule/);
});

test('the two families are textually symmetric in the protected-outcome clause', () => {
  // Both name the specific section, both say the outcome is valid and must not be
  // rejected -- the exact shape that was missing for forensics before this fix.
  assert.match(FORENSICS, /CONTRAST section/);
  assert.match(FORENSICS, /valid, correct (?:terminal )?outcome/i);
  assert.match(FORENSICS, /do[ _]NOT? reject/i);
  assert.match(DEBRIEF, /NO CONFIDENT INEFFICIENCY/);
  assert.match(DEBRIEF, /valid, correct outcome/);
  assert.match(DEBRIEF, /do[ _]NOT? reject/i);
});

test('a zero-winners draft shape matches the guidance\'s protected pattern (simulated review pass)', () => {
  // The review guidance is consumed by an LLM reviewer, not a rule engine, so the
  // strongest deterministic check possible is: the draft's honest zero-winner line is
  // literally the example the guidance quotes as CORRECT and REQUIRED behavior.
  const draft = [
    'ROOT CAUSES (RANKED): NO CLEAR ROOT CAUSE -- insufficient signal to rank any cause.',
    '',
    'CONTRAST WITH SUCCESSFUL SIBLINGS',
    '0 contrast winner task(s) -- there are no successful sibling tasks to contrast against.',
    'There are no successful sibling tasks to contrast against.',
  ].join('\n');
  const protectedExample = '0 contrast winner task(s) -- there are no successful sibling tasks to contrast against';
  assert.ok(draft.includes(protectedExample));
  assert.ok(FORENSICS.includes(protectedExample), 'the guidance must quote this exact draft shape as protected');
  assert.match(FORENSICS, /is a valid, correct terminal outcome/);
});
