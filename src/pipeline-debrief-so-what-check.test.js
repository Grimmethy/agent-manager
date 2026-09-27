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

// --- advisory-null-outcome.js: a justified null line INSIDE the report passes (real shape: trailing line after WHAT / SO WHAT) ---

test('runSoWhatCitationCheck: an honest null written as a justified NO CONFIDENT INEFFICIENCY line inside the report passes with no citation', () => {
  const report = [
    'WHAT',
    'All 3 shipped tasks share one source and one call profile.',
    '',
    'SO WHAT',
    'None of the four flag categories cleanly apply.',
    '',
    'NO CONFIDENT INEFFICIENCY -- the one additional signal that would be needed is a model_calls row showing the plan or critique stage.',
  ].join('\n');
  assert.equal(runSoWhatCitationCheck(task(), report).verdict, 'ok');
});

test('runSoWhatCitationCheck: an uncited report that flags something (numbered NOW WHAT) is still rejected even if it mentions the phrase', () => {
  const report = [
    'WHAT', 'x', '', 'SO WHAT', 'Across all 3 tasks the plan stage is redundant.', '',
    'NO CONFIDENT INEFFICIENCY does not apply \u2014 the evidence does show real, bounded waste in the plan stage.', '',
    'NOW WHAT', '1. Skip the plan pass -- Files: src/a.js. Why: redundant.',
  ].join('\n');
  assert.equal(runSoWhatCitationCheck(task(), report).verdict, 'ungrounded');
});

// --- 2026-09-27: real evidence written in another form is a citation; generic aggregates still are not ---
// (17 of 21 blocked debriefs cited real evidence as "Task N", "COMPLETED #N", a bd-<digits> token or an id prefix and were rejected.)

const LONG_IDS = [
  'brain-dump-sort-bd-1788670834315-side-finding-sweep-dedup-can-still-false',
  'brain-dump-sort-bd-1788671067392-research-claude-agent-sdk-canusetool-sdk',
  'brain-dump-sort-bd-1788671067392-research-langgraph-persistence-checkpoints',
];
const longTask = () => task({ promptContext: { taskIds: LONG_IDS } });
const report = (soWhat) => ['WHAT', 'x', '', 'SO WHAT', soWhat, '', 'NOW WHAT', '1. Skip the critique pass -- Files: src/a.js. Why: mechanical.'].join('\n');
const verdict = (soWhat, t = task()) => runSoWhatCitationCheck(t, report(soWhat)).verdict;

test('SO WHAT: "COMPLETED #2", "COMPLETED2" and lowercase "task 3" cite a real block number', () => {
  assert.equal(verdict('The critique call on COMPLETED #2 re-derived a mechanical parse.'), 'ok');
  assert.equal(verdict('See COMPLETED2 -- critique stage evalTok=5.'), 'ok');
  assert.equal(verdict('Flag 1: critique (task 3 row: stage=critique evalTok=5) is mechanical.'), 'ok');
});

test('SO WHAT: a list "Tasks 1, 3 and 5" counts when any listed number is real', () => {
  assert.equal(verdict('The plan pass on Tasks 9, 3 and 12 re-derived the classification.'), 'ok');
});

test('SO WHAT: a real bd-<digits> token or a long real task-id prefix is a citation', () => {
  assert.equal(verdict('Flag 1 -- critique on bd-1788671067392 is a mechanical parse.', longTask()), 'ok');
  assert.equal(verdict('Flag 1 -- plan on brain-dump-sort-bd-1788670834315-side-finding re-derived the ask.', longTask()), 'ok');
});

test('SO WHAT: generic aggregates and things NOT in the evidence are still ungrounded', () => {
  assert.equal(verdict('Across all 3 shipped tasks the plan stage re-derived work the ask already specified.'), 'ungrounded');
  assert.equal(verdict('The plan stage of Task 99 re-derived the ask.'), 'ungrounded', 'block 99 is not in the evidence');
  assert.equal(verdict('COMPLETED 7 spent a redundant call.'), 'ungrounded', 'block 7 is not in the evidence');
  assert.equal(verdict('Flag 2 -- the plan stage is mechanical.'), 'ungrounded', '"Flag 2" is not a citation');
  assert.equal(verdict('critique on bd-1999999999999 is mechanical.', longTask()), 'ungrounded', 'a bd token that is in no real task id');
  assert.equal(verdict('critique on brain-dump-s is mechanical.', longTask()), 'ungrounded', 'a short prefix is not distinctive');
});

test('the rejection message names the accepted citation forms and still lists real examples', () => {
  const r = runSoWhatCitationCheck(task(), report('Across all 3 tasks the plan stage is redundant.'));
  assert.equal(r.verdict, 'ungrounded');
  assert.match(r.reason, /^SO WHAT does not cite any specific evidence item/);
  assert.match(r.reason, /Accepted citation forms: "COMPLETED N" or "Task N"/);
  assert.match(r.reason, /COMPLETED 1, COMPLETED 2, COMPLETED 3/);
});
