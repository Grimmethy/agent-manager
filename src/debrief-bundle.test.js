'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  MIN_WINDOW_TASKS, MAX_CONTEXT_SECTION_CHARS, MAX_CONTEXT_STRATA, collectDoneWindow, collectContrastTasks, buildDebriefBundle, renderContextEffectiveness,
} = require('./debrief-bundle.js');

function makePipeline() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'debrief-bundle-test-'));
  for (const s of ['done', 'blocked', 'needs-clarification', 'worklogs']) {
    fs.mkdirSync(path.join(dir, 'queue', s), { recursive: true });
  }
  return dir;
}

function writeTask(pipelineDir, state, task) {
  fs.writeFileSync(path.join(pipelineDir, 'queue', state, `${task.id}.json`), JSON.stringify(task, null, 2));
}

function doneTask(id, atIso, source = 'adhoc') {
  return {
    id, source, domain: 'adhoc',
    promptContext: { rawText: 'do a thing' },
    mergedAt: atIso,
    history: [
      { stage: 'created', at: atIso },
      { stage: 'applied', at: atIso },
    ],
  };
}

function stuckTask(id, atIso, stage, source = 'adhoc') {
  return {
    id, source, domain: 'adhoc',
    promptContext: { rawText: 'do a similar thing' },
    blockedReason: 'still stuck',
    history: [
      { stage: 'created', at: atIso },
      { stage, at: atIso, detail: 'stuck' },
    ],
  };
}

function fillWindow(pipelineDir, n, sourceFn = () => 'adhoc') {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const id = `done-${i}`;
    const at = `2026-09-0${1 + (i % 9)}T0${i % 9}:00:00Z`;
    writeTask(pipelineDir, 'done', doneTask(id, at, sourceFn(i)));
    ids.push(id);
  }
  return ids;
}

test('collectDoneWindow returns nothing below MIN_WINDOW_TASKS and something at/above it', () => {
  const dir = makePipeline();
  fillWindow(dir, MIN_WINDOW_TASKS - 1);
  const bundle = buildDebriefBundle({ pipelineDir: dir, dbPath: path.join(dir, 'model-stats.db') });
  assert.equal(bundle.evidenceText, null);
  assert.equal(bundle.stats.windowCount, MIN_WINDOW_TASKS - 1);

  writeTask(dir, 'done', doneTask('done-extra', '2026-09-05T05:00:00Z'));
  const bundle2 = buildDebriefBundle({ pipelineDir: dir, dbPath: path.join(dir, 'model-stats.db') });
  assert.ok(bundle2.evidenceText, 'expected a real evidence blob once the window floor is met');
  assert.equal(bundle2.taskIds.length, MIN_WINDOW_TASKS);
});

test('collectDoneWindow only includes tasks strictly after sinceIso, oldest first', () => {
  const dir = makePipeline();
  writeTask(dir, 'done', doneTask('old', '2026-09-01T00:00:00Z'));
  writeTask(dir, 'done', doneTask('new', '2026-09-02T00:00:00Z'));
  const window = collectDoneWindow(dir, '2026-09-01T12:00:00.000Z');
  assert.deepEqual(window.map((t) => t.id), ['new']);
});

test('collectDoneWindow never descends into _archived/ or _archived_no_action/ (non-recursive readdir)', () => {
  const dir = makePipeline();
  fs.mkdirSync(path.join(dir, 'queue', 'done', '_archived', '2026-08'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'queue', 'done', '_archived_no_action'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'queue', 'done', '_archived', '2026-08', 'old.json'), JSON.stringify(doneTask('old', '2026-08-01T00:00:00Z')));
  fs.writeFileSync(path.join(dir, 'queue', 'done', '_archived_no_action', 'na.json'), JSON.stringify(doneTask('na', '2026-08-01T00:00:00Z')));
  writeTask(dir, 'done', doneTask('live', '2026-09-01T00:00:00Z'));
  const window = collectDoneWindow(dir, null);
  assert.deepEqual(window.map((t) => t.id), ['live']);
});

test('collectContrastTasks matches only tasks sharing a window source, from blocked/needs-clarification', () => {
  const dir = makePipeline();
  const window = [doneTask('d1', '2026-09-01T00:00:00Z', 'observability_review')];
  writeTask(dir, 'blocked', stuckTask('b1', '2026-09-01T00:00:00Z', 'blocked', 'observability_review'));
  writeTask(dir, 'needs-clarification', stuckTask('nc1', '2026-09-02T00:00:00Z', 'needs-clarification', 'observability_review'));
  writeTask(dir, 'blocked', stuckTask('unrelated', '2026-09-01T00:00:00Z', 'blocked', 'arch_import'));
  const contrast = collectContrastTasks(dir, window);
  const ids = contrast.map((r) => r.task.id).sort();
  assert.deepEqual(ids, ['b1', 'nc1']);
});

test('buildDebriefBundle: evidence blob names the determinism-audit framing and sections', () => {
  const dir = makePipeline();
  fillWindow(dir, MIN_WINDOW_TASKS, () => 'observability_review');
  writeTask(dir, 'blocked', stuckTask('stuck-1', '2026-09-05T00:00:00Z', 'blocked', 'observability_review'));
  const bundle = buildDebriefBundle({ pipelineDir: dir, dbPath: path.join(dir, 'model-stats.db') });
  assert.ok(bundle.evidenceText.includes('PIPELINE DETERMINISM AUDIT'));
  assert.ok(bundle.evidenceText.includes('DETERMINISM AUDIT, not a "what worked" retrospective'));
  assert.ok(bundle.evidenceText.includes('ALREADY-DETERMINISTIC CHECK'));
  assert.ok(bundle.evidenceText.includes('COMPLETED 1'));
  assert.ok(bundle.evidenceText.includes('CONTRAST 1'));
  assert.equal(bundle.contrastIds.length, 1);
});

test('buildDebriefBundle notes explicitly when there are no contrast tasks at all', () => {
  const dir = makePipeline();
  fillWindow(dir, MIN_WINDOW_TASKS, () => 'a-source-nothing-else-uses');
  const bundle = buildDebriefBundle({ pipelineDir: dir, dbPath: path.join(dir, 'model-stats.db') });
  assert.equal(bundle.contrastIds.length, 0);
  assert.ok(bundle.evidenceText.includes('No contrast tasks were found'));
});

test('buildDebriefBundle caps the window at the given maxWindow even with a much larger backlog', () => {
  const dir = makePipeline();
  fillWindow(dir, 40);
  const bundle = buildDebriefBundle({ pipelineDir: dir, dbPath: path.join(dir, 'model-stats.db'), maxWindow: 15 });
  assert.equal(bundle.taskIds.length, 15);
});

// --- shipped / no-op window split (2026-09-10) -----------------------------------------
const { taskDidShip, splitWindowByShipped } = require('./debrief-bundle.js');

function doneTaskWithApplyDetail(id, atIso, detail, source = 'adhoc') {
  const t = doneTask(id, atIso, source);
  t.history[t.history.length - 1].detail = detail;
  return t;
}

test('taskDidShip: terminalDisposition is decisive', () => {
  assert.equal(taskDidShip({ terminalDisposition: 'noop', history: [{ stage: 'applied' }] }), false);
  assert.equal(taskDidShip({ terminalDisposition: 'dismissed', history: [{ stage: 'applied' }] }), false);
  assert.equal(taskDidShip({ terminalDisposition: 'abandoned', history: [{ stage: 'applied' }] }), false);
  assert.equal(taskDidShip({ terminalDisposition: 'merged', history: [{ stage: 'applied', detail: 'no candidates' }] }), true);
  assert.equal(taskDidShip({ terminalDisposition: 'filed', history: [{ stage: 'applied' }] }), true);
});

test('taskDidShip: falls back to the applied-event detail when disposition is not stamped yet', () => {
  assert.equal(taskDidShip({ history: [{ stage: 'applied', detail: 'agent/adhoc-x is 1 commit(s) ahead of master' }] }), true);
  assert.equal(taskDidShip({ history: [{ stage: 'applied' }] }), true, 'no detail = shipped (conservative toward analysis)');
  assert.equal(taskDidShip({ history: [{ stage: 'applied', detail: 'no candidates in implement response -- nothing to apply' }] }), false);
  assert.equal(taskDidShip({ history: [{ stage: 'applied', detail: 'no code change needed (empty implement response)' }] }), false);
  assert.equal(taskDidShip({ history: [{ stage: 'created' }] }), false, 'never applied');
});

test('splitWindowByShipped separates the two', () => {
  const shipped = { history: [{ stage: 'applied', detail: 'agent/adhoc-a is 2 commit(s) ahead' }] };
  const noop = { history: [{ stage: 'applied', detail: 'no candidates -- nothing to apply' }] };
  const { shipped: s, noop: n } = splitWindowByShipped([shipped, noop, shipped]);
  assert.equal(s.length, 2);
  assert.equal(n.length, 1);
});

test('buildDebriefBundle: framing counts shipped vs no-op, and only shipped tasks get COMPLETED evidence blocks', () => {
  const dir = makePipeline();
  // 8 real ships + 6 no-ops, all in-window
  for (let i = 0; i < 8; i++) {
    writeTask(dir, 'done', doneTaskWithApplyDetail(`ship-${i}`, `2026-09-0${1 + (i % 8)}T01:00:00Z`, `agent/adhoc-ship-${i} is 1 commit(s) ahead of master`));
  }
  for (let i = 0; i < 6; i++) {
    writeTask(dir, 'done', doneTaskWithApplyDetail(`noop-${i}`, `2026-09-0${1 + (i % 8)}T02:00:00Z`, 'no candidates in implement response -- nothing to apply'));
  }
  const bundle = buildDebriefBundle({ pipelineDir: dir, dbPath: path.join(dir, 'model-stats.db') });
  assert.equal(bundle.stats.windowCount, 14);
  assert.equal(bundle.stats.shippedCount, 8);
  assert.equal(bundle.stats.noopCount, 6);
  assert.equal(bundle.subjectIds.length, 8);
  assert.equal(bundle.noopIds.length, 6);
  assert.equal(bundle.taskIds.length, 14, 'archive blast radius is still the whole window');
  assert.match(bundle.evidenceText, /8 shipped, audited below; 6 no-op/);
  assert.ok(bundle.evidenceText.includes('COMPLETED 8'));
  assert.ok(!bundle.evidenceText.includes('COMPLETED 9'), 'no evidence block for a no-op task');
});

// --- low-trust model-routing caveat (2026-09) -----------------------------------------
const { ROUTING_ADVICE_CAVEAT, renderFraming } = require('./debrief-bundle.js');

test('ROUTING_ADVICE_CAVEAT is exported, states LOW-TRUST, and requires human confirmation', () => {
  assert.equal(typeof ROUTING_ADVICE_CAVEAT, 'string');
  assert.ok(ROUTING_ADVICE_CAVEAT.includes('LOW-TRUST'), 'caveat must state LOW-TRUST');
  assert.ok(ROUTING_ADVICE_CAVEAT.includes('require human confirmation'), 'caveat must require human confirmation');
  assert.ok(ROUTING_ADVICE_CAVEAT.includes('~107s'), 'caveat must cite the ~107s reload latency');
  assert.ok(ROUTING_ADVICE_CAVEAT.includes('reportClass'), 'caveat must mention reportClass treatment');
});

test('renderFraming output carries the LOW-TRUST model-routing caveat', () => {
  const text = renderFraming([doneTask('s1', '2026-09-01T00:00:00Z')], 0, [], '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z');
  assert.ok(text.includes('LOW-TRUST'), 'framing must include the LOW-TRUST caveat');
  assert.ok(text.includes('require human confirmation'), 'framing must include the human-confirmation phrase');
});

test('buildDebriefBundle evidence text carries the LOW-TRUST model-routing caveat in every bundle', () => {
  const dir = makePipeline();
  fillWindow(dir, MIN_WINDOW_TASKS);
  const bundle = buildDebriefBundle({ pipelineDir: dir, dbPath: path.join(dir, 'model-stats.db') });
  assert.ok(bundle.evidenceText, 'expected a real evidence blob');
  assert.ok(bundle.evidenceText.includes('LOW-TRUST'), 'bundle text must include LOW-TRUST');
  assert.ok(bundle.evidenceText.includes('require human confirmation'), 'bundle text must include the human-confirmation phrase');
});

test('buildDebriefBundle: a no-op-dominant window still produces a bundle, framed around the no-op problem', () => {
  const dir = makePipeline();
  for (let i = 0; i < 2; i++) {
    writeTask(dir, 'done', doneTaskWithApplyDetail(`ship-${i}`, `2026-09-0${1 + i}T01:00:00Z`, `agent/adhoc-ship-${i} is 1 commit(s) ahead of master`));
  }
  for (let i = 0; i < 12; i++) {
    writeTask(dir, 'done', doneTaskWithApplyDetail(`noop-${i}`, `2026-09-0${1 + (i % 8)}T03:00:00Z`, 'degenerate implement -- no code change'));
  }
  const bundle = buildDebriefBundle({ pipelineDir: dir, dbPath: path.join(dir, 'model-stats.db') });
  assert.ok(bundle.evidenceText, 'bundle is still produced');
  assert.equal(bundle.stats.shippedCount, 2);
  assert.equal(bundle.stats.noopCount, 12);
  assert.match(bundle.evidenceText, /this window shipped only 2 of 14/);
  assert.match(bundle.evidenceText, /a cheaper deterministic early-exit/);
});

test('taskDidShip: an unstamped record applied to a branch whose name contains a no-op word still shipped', () => {
  assert.equal(taskDidShip({ history: [{ stage: 'applied', detail: 'agent/adhoc-premium-head-of-line-starvation-rotate-repeatedly-blocked-premium-tasks-behind-fresh-ones-and-avoid-lanes-a-task-degenerated-on-1792061032268' }] }), true);
  assert.equal(taskDidShip({ history: [{ stage: 'applied', detail: 'no candidates in implement response -- nothing to apply' }] }), false);
});

// ---- the context-effectiveness section (piece P3 of the context-impact loop) ----
const STAMP = { v: 1, anchorFileCount: 1, grepHitFileCount: 0, orientRan: true, priorRejectionCount: 0 };
function stampedWindow(dir, n, source = 'adhoc') {
  for (let i = 0; i < n; i++) {
    const at = `2026-09-0${1 + (i % 9)}T0${i % 9}:00:00Z`;
    writeTask(dir, 'done', { ...doneTask(`stamped-${i}`, at, source), contextProvenance: STAMP });
  }
}
const SECTION = 'CONTEXT EFFECTIVENESS';

test('buildDebriefBundle: stamped tasks in the window add the context-effectiveness section right after the framing, as bounded plain counts with the caveats', () => {
  const dir = makePipeline();
  stampedWindow(dir, MIN_WINDOW_TASKS);
  const bundle = buildDebriefBundle({ pipelineDir: dir, dbPath: path.join(dir, 'model-stats.db') });
  const text = bundle.evidenceText;
  assert.ok(text.includes(SECTION));
  assert.ok(text.indexOf('PIPELINE DETERMINISM AUDIT') < text.indexOf(SECTION));
  assert.ok(text.indexOf(SECTION) < text.indexOf('COMPLETED 1'));
  assert.equal(bundle.stats.contextStamped, MIN_WINDOW_TASKS);
  assert.ok(bundle.stats.contextSectionChars > 0 && bundle.stats.contextSectionChars <= MAX_CONTEXT_SECTION_CHARS);
  const section = text.slice(text.indexOf(SECTION), text.indexOf('COMPLETED 1'));
  assert.ok(section.includes('stamped 12, unstamped 0'));
  assert.ok(section.includes('descriptive correlations, not effects'));
  assert.ok(section.includes('anchorFileCount -- 1-2: n=12 first-pass='));
  for (const word of ['because', 'causes', 'improves', 'recommend', 'should', 'better', 'worse', 'helps']) assert.equal(section.toLowerCase().includes(word), false, word);
});

test('buildDebriefBundle: without stamped tasks the section is ABSENT, not an error, and the rest of the bundle is unchanged', () => {
  const dir = makePipeline();
  fillWindow(dir, MIN_WINDOW_TASKS);
  const bundle = buildDebriefBundle({ pipelineDir: dir, dbPath: path.join(dir, 'model-stats.db') });
  assert.equal(bundle.evidenceText.includes(SECTION), false);
  assert.equal(bundle.stats.contextStamped, 0);
  assert.equal(bundle.stats.contextSectionChars, 0);
  assert.equal(/(^|\n)null(\n|$)/.test(bundle.evidenceText), false, 'an absent section leaves nothing behind, not even the word null');
  assert.ok(bundle.evidenceText.includes('COMPLETED 1'));
});

test('buildDebriefBundle: the section covers the SAME window (a stamped task just after the window end is not counted) and the join gets exactly that window', () => {
  const dir = makePipeline();
  stampedWindow(dir, MIN_WINDOW_TASKS);
  writeTask(dir, 'done', { ...doneTask('after-window', '2026-09-09T20:00:00Z'), contextProvenance: STAMP });
  const bundle = buildDebriefBundle({ pipelineDir: dir, dbPath: path.join(dir, 'model-stats.db'), maxWindow: MIN_WINDOW_TASKS });
  assert.equal(bundle.stats.windowCount, MIN_WINDOW_TASKS);
  assert.equal(bundle.stats.contextStamped, MIN_WINDOW_TASKS);
  const calls = [];
  buildDebriefBundle({ pipelineDir: dir, dbPath: path.join(dir, 'model-stats.db'), maxWindow: MIN_WINDOW_TASKS, joinFn: (args) => { calls.push(args); return { counts: { stamped: 0 } }; } });
  assert.equal(calls.length, 1);
  const start = Date.parse(bundle.windowStart);
  const end = Date.parse(bundle.windowEnd);
  assert.deepEqual([calls[0].pipelineDir, calls[0].sinceMs, calls[0].nowMs, calls[0].untilMs], [dir, end - start, end, end]);
});

test('buildDebriefBundle: a join that throws leaves the section out and the bundle built', () => {
  const dir = makePipeline();
  stampedWindow(dir, MIN_WINDOW_TASKS);
  const bundle = buildDebriefBundle({ pipelineDir: dir, dbPath: path.join(dir, 'model-stats.db'), joinFn: () => { throw new Error('queue unreadable'); } });
  assert.ok(bundle.evidenceText.includes('COMPLETED 1'));
  assert.equal(bundle.evidenceText.includes(SECTION), false);
  assert.equal(bundle.stats.contextStamped, 0);
});

test('buildDebriefBundle: the bundle stays inside its size cap with the section present (the existing hard truncation still applies)', () => {
  const dir = makePipeline();
  stampedWindow(dir, MIN_WINDOW_TASKS);
  const budgetChars = 2500;
  const bundle = buildDebriefBundle({ pipelineDir: dir, dbPath: path.join(dir, 'model-stats.db'), budgetChars });
  assert.ok(bundle.evidenceText.length <= budgetChars + 80, `${bundle.evidenceText.length}`);
  assert.ok(bundle.stats.droppedForBudget.includes('hard-truncate'));
});

const cellOf = (over = {}) => ({ n: 12, approvedFirstPass: 9, blockedOrNeedsClarification: 3, medianHistoryStages: 8, ...over });
const reportOf = (strata, over = {}) => ({ minCellN: 10, counts: { shipped: 20, blocked: 2, needsClarification: 1, stamped: 15, unstamped: 5 }, strata, caveats: ['c1', 'c2'], ...over });

test('renderContextEffectiveness: null for no report and for no stamped task; cells render as counts or insufficient; strata with no stamp are left out', () => {
  assert.equal(renderContextEffectiveness(null), null);
  assert.equal(renderContextEffectiveness({}), null);
  assert.equal(renderContextEffectiveness(reportOf({}, { counts: { stamped: 0 } })), null);
  const text = renderContextEffectiveness(reportOf({
    adhoc: { stamped: 15, stuck: 3, unstamped: { n: 4, insufficient: true }, cells: { orientRan: { true: cellOf(), false: { n: 3, insufficient: true } }, anchorFileCount: {} } },
    brain_dump_sort: { stamped: 0, stuck: 0, unstamped: cellOf(), cells: {} },
  }));
  assert.ok(text.includes('tasks in window: shipped 20, stuck 3; stamped 15, unstamped 5; a cell under 10 tasks reports insufficient.'));
  assert.ok(text.includes('adhoc: stamped 15, stuck 3, unstamped baseline insufficient(n=4)'));
  assert.ok(text.includes('orientRan -- true: n=12 first-pass=9 stuck=3 median-stages=8 | false: insufficient(n=3)'));
  assert.equal(text.includes('anchorFileCount'), false);
  assert.equal(text.includes('brain_dump_sort'), false);
  assert.ok(text.endsWith('caveats: c1; c2'));
});

test('renderContextEffectiveness: at most MAX_CONTEXT_STRATA strata, largest stamped first, and a long report is cut to MAX_CONTEXT_SECTION_CHARS with a marker', () => {
  const strata = {};
  for (let i = 0; i < 9; i++) strata[`source_${i}`] = { stamped: 10 + i, stuck: 0, unstamped: cellOf(), cells: { orientRan: { true: cellOf(), false: cellOf() } } };
  const text = renderContextEffectiveness(reportOf(strata));
  const listed = Object.keys(strata).filter((k) => text.includes(`${k}: stamped`));
  assert.equal(MAX_CONTEXT_STRATA, 4);
  assert.deepEqual(listed.sort(), ['source_5', 'source_6', 'source_7', 'source_8']);
  const big = {};
  for (let i = 0; i < 4; i++) big[`${'long_source_name_'.repeat(8)}${i}`] = { stamped: 50, stuck: 0, unstamped: cellOf(), cells: Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f'].map((f) => [`${f}Feature`, { x: cellOf(), y: cellOf(), z: cellOf() }])) };
  const cut = renderContextEffectiveness(reportOf(big));
  assert.equal(cut.length, MAX_CONTEXT_SECTION_CHARS);
  assert.ok(cut.endsWith('...[context section truncated]'));
  assert.equal(renderContextEffectiveness(reportOf(big), 50).length, 50);
});

test('the section budget is 1600 characters and 4 strata (the debrief shares one 28000 character budget with its evidence)', () => {
  assert.equal(MAX_CONTEXT_SECTION_CHARS, 1600);
  assert.equal(MAX_CONTEXT_STRATA, 4);
});
