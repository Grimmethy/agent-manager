'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectStaleDecomposePremise } = require('./decompose-premise-check.js');

// --- detectStaleDecomposePremise (2026-09-15, brain-dump bd-1789433484305, "pipeline
// hardening 3/5") -- root-caused live against the real sub-task that cited src/local-
// draft.js line 2178 after decompose #226 had already shrunk that file to 1327 lines. ---

test('detects the real incident: cited line well past the file\'s current length', () => {
  const task = {
    promptContext: {
      decomposedFrom: 'parent-1',
      rawText: "In src/local-draft.js, find the two places that set task.blockedStage = 'review': (1) ~line 1651 where runGroundingCheck returns verdict 'ungrounded', and (2) ~line 2178 where postImplementCheck returns verdict 'ungrounded' or 'invalid-premise'.",
    },
  };
  const lineCountFn = () => 1327; // decompose #226's real shrunk line count
  const result = detectStaleDecomposePremise(task, { repoRoot: '/repo', lineCountFn });
  assert.ok(result, 'must detect the stale citation');
  assert.equal(result.stale, true);
  assert.equal(result.findings.length, 1, 'both overshooting line refs against the same file collapse to one finding');
  assert.equal(result.findings[0].kind, 'line-overshoot');
  assert.equal(result.findings[0].relPath, 'src/local-draft.js');
  assert.equal(result.findings[0].realLineCount, 1327);
});

test('does not fire when the task was not filed by an internal decompose (no decomposedFrom)', () => {
  const task = { promptContext: { rawText: 'In src/foo.js line 99999, fix it.' } };
  assert.equal(detectStaleDecomposePremise(task, { repoRoot: '/repo', lineCountFn: () => 10 }), null);
});

test('does not fire on a plausible citation within the overshoot slack', () => {
  const task = { promptContext: { decomposedFrom: 'p', rawText: 'In src/apply-group-a.js near line 128, wire the dedup.' } };
  assert.equal(detectStaleDecomposePremise(task, { repoRoot: '/repo', lineCountFn: () => 397 }), null);
});

test('does not fire on a citation with no line number at all -- only a checkable numeric claim is in scope', () => {
  const task = { promptContext: { decomposedFrom: 'p', rawText: 'In src/apply-group-a.js, wire the dispatch loop in.' } };
  assert.equal(detectStaleDecomposePremise(task, { repoRoot: '/repo', lineCountFn: () => 397 }), null);
});

test('flags a cited file that does not exist at all', () => {
  const task = { promptContext: { decomposedFrom: 'p', rawText: 'In src/gone-in-a-later-decompose.js line 10, fix it.' } };
  const result = detectStaleDecomposePremise(task, { repoRoot: '/repo', lineCountFn: () => null });
  assert.ok(result);
  assert.equal(result.findings[0].kind, 'missing-file');
  assert.equal(result.findings[0].relPath, 'src/gone-in-a-later-decompose.js');
});

test('associates a line reference with the nearest preceding file path, not always the first', () => {
  const task = {
    promptContext: {
      decomposedFrom: 'p',
      rawText: 'First touch src/a.js near line 10. Then touch src/b.js near line 9999.',
    },
  };
  const lineCountFn = (repoRoot, relPath) => (relPath === 'src/a.js' ? 500 : 50);
  const result = detectStaleDecomposePremise(task, { repoRoot: '/repo', lineCountFn });
  assert.ok(result, 'src/b.js:9999 is impossible given its real 50-line length');
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].relPath, 'src/b.js', 'the overshoot must attach to b.js, not a.js, even though a.js is named first');
});

test('two overshooting line refs against the same file collapse into one finding, not two', () => {
  const task = {
    promptContext: {
      decomposedFrom: 'p',
      rawText: 'In src/x.js: (1) line 9000 and (2) line 9500.',
    },
  };
  const result = detectStaleDecomposePremise(task, { repoRoot: '/repo', lineCountFn: () => 100 });
  assert.equal(result.findings.length, 1);
});

test('null on a task with no promptContext/rawText at all', () => {
  assert.equal(detectStaleDecomposePremise({}, { repoRoot: '/repo', lineCountFn: () => 10 }), null);
  assert.equal(detectStaleDecomposePremise(null, { repoRoot: '/repo', lineCountFn: () => 10 }), null);
});

test('null without a repoRoot (nothing to check against)', () => {
  const task = { promptContext: { decomposedFrom: 'p', rawText: 'In src/x.js line 9000, fix it.' } };
  assert.equal(detectStaleDecomposePremise(task, { lineCountFn: () => 100 }), null);
});

test('kill switch: AGENT_MANAGER_DECOMPOSE_PREMISE_CHECK=false disables the check entirely', () => {
  const prev = process.env.AGENT_MANAGER_DECOMPOSE_PREMISE_CHECK;
  process.env.AGENT_MANAGER_DECOMPOSE_PREMISE_CHECK = 'false';
  try {
    const task = { promptContext: { decomposedFrom: 'p', rawText: 'In src/x.js line 9000, fix it.' } };
    assert.equal(detectStaleDecomposePremise(task, { repoRoot: '/repo', lineCountFn: () => 100 }), null);
  } finally {
    if (prev === undefined) delete process.env.AGENT_MANAGER_DECOMPOSE_PREMISE_CHECK;
    else process.env.AGENT_MANAGER_DECOMPOSE_PREMISE_CHECK = prev;
  }
});
