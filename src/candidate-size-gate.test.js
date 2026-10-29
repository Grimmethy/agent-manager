'use strict';

// Unit tests for candidate-size-gate.js (ADR-0023 slice S1). Run: node --test src/candidate-size-gate.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkCandidateSize, CANDIDATE_SIZE_MARGIN } = require('./candidate-size-gate.js');
const { renderCandidateSection, parseArchDiscoveryCandidates } = require('./candidate-docs.js');
const { MAX_ARCH_REVIEW_TASK_CHARS, candidateGuardSize } = require('./sdk/lib/candidate-lifecycle.js');
const { categorizeBlockedReason } = require('./blocked-task-classifiers.js');

const ENTRY = { directToMain: true };
// Hard-coded on purpose: deriving it from CANDIDATE_SIZE_MARGIN would let a changed margin silently move the boundary this test pins.
const LIMIT = 3900;
const block = (title, problem, id = 1) => `### AC-${id} · ${title}\nStrength: Strong\nFiles: src/a.js\n\nProblem:\n${problem}\n\nSolution:\nS\n\nBenefits:\nB\n`;

// Size of the candidate exactly as the gate measures it.
const measure = (response) => candidateGuardSize(renderCandidateSection(parseArchDiscoveryCandidates(response)[0], 'AC-9999', { snippet: null, dependsOnId: null }));
// Pad Problem so the measured size is exactly `target`.
const padTo = (target) => {
  const base = measure(block('Boundary', ''));
  return block('Boundary', 'x'.repeat(target - base));
};

test('the margin is 100 and the limit is read from candidate-lifecycle, not copied', () => {
  assert.equal(CANDIDATE_SIZE_MARGIN, 100);
  assert.equal(MAX_ARCH_REVIEW_TASK_CHARS - CANDIDATE_SIZE_MARGIN, LIMIT);
});

test('ok for a source that is not directToMain, and when no entry is given', () => {
  const big = block('Big', 'x'.repeat(4300));
  assert.equal(checkCandidateSize({}, big, { entry: {} }).verdict, 'ok');
  assert.equal(checkCandidateSize({}, big, { entry: { directToMain: false } }).verdict, 'ok');
  assert.equal(checkCandidateSize({}, big, {}).verdict, 'ok');
});

test('ok for a response with no candidate block (a code diff)', () => {
  assert.equal(checkCandidateSize({}, 'diff --git a/x b/x\n+const a = 1;\n', { entry: ENTRY }).verdict, 'ok');
  assert.equal(checkCandidateSize({}, '', { entry: ENTRY }).verdict, 'ok');
});

test('ok for a short candidate', () => {
  const v = checkCandidateSize({}, block('Short', 'tiny'), { entry: ENTRY });
  assert.equal(v.verdict, 'ok');
  assert.equal(v.sizes.length, 1);
});

test('oversized for a 4300-character write-up, quoting the measured size and both limits', () => {
  const r = block('Too long', 'x'.repeat(4300));
  const size = measure(r);
  const v = checkCandidateSize({}, r, { entry: ENTRY });
  assert.equal(v.verdict, 'oversized');
  assert.match(v.reason, new RegExp(`"Too long" is ${size} chars`));
  assert.match(v.reason, /limit is 3900/);
  assert.match(v.reason, /hard limit 4000/);
  assert.ok(v.reason.length < 450, `reason is ${v.reason.length} chars`);
});

test('exact boundary: a candidate measuring exactly the effective limit is ok, one more character is oversized', () => {
  const at = padTo(LIMIT);
  assert.equal(measure(at), LIMIT);
  assert.equal(checkCandidateSize({}, at, { entry: ENTRY }).verdict, 'ok');
  const over = padTo(LIMIT + 1);
  assert.equal(measure(over), LIMIT + 1);
  assert.equal(checkCandidateSize({}, over, { entry: ENTRY }).verdict, 'oversized');
});

test('the Snippet is not part of the draft: a short write-up is ok even when the task carries a huge snippet', () => {
  const task = { promptContext: { snippet: 'y'.repeat(20000) } };
  assert.equal(checkCandidateSize(task, block('Short', 'tiny'), { entry: ENTRY }).verdict, 'ok');
});

test('several oversized candidates are all counted but at most three are listed', () => {
  const r = [1, 2, 3, 4, 5].map((i) => block(`Big ${i}`, 'x'.repeat(4300), i)).join('\n');
  const v = checkCandidateSize({}, r, { entry: ENTRY });
  assert.equal(v.verdict, 'oversized');
  assert.equal((v.reason.match(/ is \d+ chars/g) || []).length, 3);
  assert.match(v.reason, /\(\+2 more\)/);
  assert.equal(v.sizes.length, 5);
});

test('a mixed batch is oversized when any one candidate is over', () => {
  const r = block('Fine', 'tiny', 1) + '\n' + block('Huge', 'x'.repeat(4300), 2);
  const v = checkCandidateSize({}, r, { entry: ENTRY });
  assert.equal(v.verdict, 'oversized');
  assert.match(v.reason, /"Huge"/);
  assert.doesNotMatch(v.reason, /"Fine"/);
});

test('the reason is not categorized by the real blocked-task classifier (a size violation is not a stochastic gate flake)', () => {
  const v = checkCandidateSize({}, block('Big', 'x'.repeat(4300)), { entry: ENTRY });
  assert.equal(categorizeBlockedReason(`Oversized candidate: ${v.reason}`), null);
});

test('kill switch: AGENT_MANAGER_CANDIDATE_SIZE_GATE=false returns ok', () => {
  const prev = process.env.AGENT_MANAGER_CANDIDATE_SIZE_GATE;
  process.env.AGENT_MANAGER_CANDIDATE_SIZE_GATE = 'false';
  try {
    assert.equal(checkCandidateSize({}, block('Big', 'x'.repeat(4300)), { entry: ENTRY }).verdict, 'ok');
  } finally {
    if (prev === undefined) delete process.env.AGENT_MANAGER_CANDIDATE_SIZE_GATE; else process.env.AGENT_MANAGER_CANDIDATE_SIZE_GATE = prev;
  }
});
