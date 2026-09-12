'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runSoWhatCitationCheck, realCompletedNumbers, realTaskIds, extractSoWhatSection,
} = require('./pipeline-debrief-so-what-check.js');

const REAL_EVIDENCE = [
  'PIPELINE DETERMINISM AUDIT -- window 2026-09-08T00:00:00Z .. 2026-09-08T01:00:00Z (3 done)',
  '',
  '### COMPLETED 1: brain-dump-sort-bd-1111-first-task',
  'source=brain_dump_sort',
  'model_calls:',
  '  - stage=critique model=qwen2.5:3b latency=13s promptTok=4201 evalTok=5',
  '',
  '### COMPLETED 2: brain-dump-sort-bd-2222-second-task',
  'source=brain_dump_sort',
  'model_calls:',
  '  - stage=critique model=qwen2.5:3b latency=14s promptTok=4300 evalTok=5',
  '',
  '### COMPLETED 3: brain-dump-sort-bd-3333-third-task',
  'source=brain_dump_sort',
  'model_calls:',
  '  - stage=critique model=qwen2.5:3b latency=12s promptTok=4100 evalTok=5',
].join('\n');

function task(over = {}) {
  return {
    source: 'pipeline_debrief',
    promptContext: {
      evidenceText: REAL_EVIDENCE,
      taskIds: ['brain-dump-sort-bd-1111-first-task', 'brain-dump-sort-bd-2222-second-task', 'brain-dump-sort-bd-3333-third-task'],
      ...over.promptContext,
    },
    ...over,
  };
}

// --- realCompletedNumbers / realTaskIds (free, deterministic) ---------------------------

test('realCompletedNumbers extracts every real "### COMPLETED N" number from the evidence', () => {
  assert.deepEqual(realCompletedNumbers(task()), ['1', '2', '3']);
});

test('realCompletedNumbers returns [] for a task with no evidenceText', () => {
  assert.deepEqual(realCompletedNumbers({ promptContext: {} }), []);
  assert.deepEqual(realCompletedNumbers({}), []);
});

test('realTaskIds returns the real taskIds array, filtering out anything malformed', () => {
  assert.deepEqual(realTaskIds(task()), ['brain-dump-sort-bd-1111-first-task', 'brain-dump-sort-bd-2222-second-task', 'brain-dump-sort-bd-3333-third-task']);
  assert.deepEqual(realTaskIds({ promptContext: { taskIds: ['ok', 42, null, ''] } }), ['ok']);
  assert.deepEqual(realTaskIds({}), []);
});

// --- extractSoWhatSection ----------------------------------------------------------------

test('extractSoWhatSection isolates the SO WHAT body up to the next section heading', () => {
  const text = 'WHAT\nprofile stuff\n\nSO WHAT\nthe real citation content here\n\nALREADY-DETERMINISTIC CHECK\nother stuff';
  assert.match(extractSoWhatSection(text), /the real citation content here/);
  assert.doesNotMatch(extractSoWhatSection(text), /other stuff/);
});

test('extractSoWhatSection falls back to the whole text when no SO WHAT heading is found', () => {
  const text = 'NO CONFIDENT INEFFICIENCY -- nothing to see';
  assert.equal(extractSoWhatSection(text), text);
});

// --- runSoWhatCitationCheck (the real gate) ----------------------------------------------

// This is the exact real-world failure shape: a generic aggregate claim citing zero
// specific evidence items, confirmed against a 31-task blocked pipeline_debrief cluster.
test('runSoWhatCitationCheck flags a generic aggregate SO WHAT claim with zero citations', () => {
  const draft = [
    'WHAT',
    'All 3 tasks ran the same three-stage profile.',
    '',
    'SO WHAT',
    'Across all 3 tasks, the critique stage is redundant and adds no value.',
    '',
    'ALREADY-DETERMINISTIC CHECK',
    'The review gate already exists.',
  ].join('\n');
  const r = runSoWhatCitationCheck(task(), draft);
  assert.equal(r.verdict, 'ungrounded');
  assert.match(r.reason, /COMPLETED 1/);
});

test('runSoWhatCitationCheck accepts a SO WHAT that cites a real "COMPLETED N" item', () => {
  const draft = [
    'SO WHAT',
    'The critique stage is redundant (e.g. COMPLETED 1: stage=critique evalTok=5, uniformly a no-op across the window).',
  ].join('\n');
  assert.equal(runSoWhatCitationCheck(task(), draft).verdict, 'ok');
});

test('runSoWhatCitationCheck accepts a SO WHAT that cites a real task id directly', () => {
  const draft = [
    'SO WHAT',
    'brain-dump-sort-bd-1111-first-task shows a redundant critique call with evalTok=5.',
  ].join('\n');
  assert.equal(runSoWhatCitationCheck(task(), draft).verdict, 'ok');
});

test('runSoWhatCitationCheck accepts the "NO CONFIDENT INEFFICIENCY" terminal outcome unconditionally', () => {
  const draft = 'NO CONFIDENT INEFFICIENCY -- the window is too small to draw a real conclusion.';
  assert.equal(runSoWhatCitationCheck(task(), draft).verdict, 'ok');
});

test('runSoWhatCitationCheck never blocks an empty response -- that is the degenerate-output gate\'s job, not this one', () => {
  assert.equal(runSoWhatCitationCheck(task(), '').verdict, 'ok');
  assert.equal(runSoWhatCitationCheck(task(), '   ').verdict, 'ok');
});

test('runSoWhatCitationCheck never blocks when the evidence itself has nothing real to cite -- does not invent a requirement the input can\'t support', () => {
  const t = task({ promptContext: { evidenceText: '(no completed blocks here)', taskIds: [] } });
  const draft = 'SO WHAT\nAcross all tasks, something is inefficient.';
  assert.equal(runSoWhatCitationCheck(t, draft).verdict, 'ok');
});

test('runSoWhatCitationCheck respects the AGENT_MANAGER_PIPELINE_DEBRIEF_SO_WHAT_CHECK=false kill switch', () => {
  const prev = process.env.AGENT_MANAGER_PIPELINE_DEBRIEF_SO_WHAT_CHECK;
  process.env.AGENT_MANAGER_PIPELINE_DEBRIEF_SO_WHAT_CHECK = 'false';
  try {
    const draft = 'SO WHAT\nAcross all tasks, something is inefficient, no citation at all.';
    assert.equal(runSoWhatCitationCheck(task(), draft).verdict, 'ok');
  } finally {
    if (prev === undefined) delete process.env.AGENT_MANAGER_PIPELINE_DEBRIEF_SO_WHAT_CHECK;
    else process.env.AGENT_MANAGER_PIPELINE_DEBRIEF_SO_WHAT_CHECK = prev;
  }
});

// Real regression case from live investigation: a fresh, otherwise well-formed report
// that names "task 6" in WHAT (describing attempt counts) but never cites a real
// COMPLETED N or task id inside SO WHAT itself -- must still be flagged, since the
// citation requirement is about SO WHAT specifically, not the report as a whole.
test('runSoWhatCitationCheck flags a citation that only appears OUTSIDE the SO WHAT section', () => {
  const draft = [
    'WHAT',
    'COMPLETED 1 shows a two-attempt plan pass.',
    '',
    'SO WHAT',
    'The plan stage is generally re-deriving a routing decision that is already specified.',
    '',
    'ALREADY-DETERMINISTIC CHECK',
    'brain-dump-sort-bd-1111-first-task confirms the gate exists.',
  ].join('\n');
  const r = runSoWhatCitationCheck(task(), draft);
  assert.equal(r.verdict, 'ungrounded');
});
