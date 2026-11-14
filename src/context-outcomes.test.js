'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { joinContextOutcomes, parseSince, defaultReadDir, isFirstPass, blockedClass, MIN_CELL_N, CAVEATS } = require('./context-outcomes.js');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const FIRST = ['created', 'draft-started', 'plan-done', 'implement-done', 'review-started', 'approved', 'applied', 'merged'];

// A record as the pipeline writes it: history with stage and at, terminalDisposition, an optional contextProvenance stamp.
function rec({ id = 'x', source = 'manual', stages = FIRST, stamp, disposition = 'merged', agoMs = DAY, blockedReason, needsClarification } = {}) {
  const r = { id, source, history: stages.map((stage, i) => ({ stage, at: iso(agoMs + (stages.length - i) * 1000) })) };
  if (disposition !== undefined) r.terminalDisposition = disposition;
  if (stamp !== undefined) r.contextProvenance = stamp;
  if (blockedReason !== undefined) r.blockedReason = blockedReason;
  if (needsClarification !== undefined) r.needsClarification = needsClarification;
  return r;
}
const stamp = (over = {}) => ({ v: 1, anchorFileCount: 1, grepHitFileCount: 1, orientRan: true, priorRejectionCount: 0, ...over });
const many = (n, make) => Array.from({ length: n }, (_, i) => make(i));
const run = (dirs, over = {}) => joinContextOutcomes({ pipelineDir: '/p', nowMs: NOW, readDir: (dir) => dirs[path.basename(dir)] || [], ...over });

test('an empty pipeline gives zero counts, no strata and the caveats', () => {
  const r = run({});
  assert.deepEqual(r.counts, { shipped: 0, excludedDone: 0, blocked: 0, needsClarification: 0, stamped: 0, unstamped: 0 });
  assert.deepEqual(r.strata, {});
  assert.deepEqual(r.caveats, CAVEATS);
  assert.ok(r.caveats.includes('confounded by task size and source'));
  assert.ok(r.caveats.includes('descriptive correlations, not effects'));
  assert.equal(r.minCellN, 10);
  assert.equal(MIN_CELL_N, 10);
});

test('a task without a usable stamp is unstamped: absent, a string and an array all count as unstamped', () => {
  const r = run({ done: [rec({ id: 'a' }), rec({ id: 'b', stamp: 'nope' }), rec({ id: 'c', stamp: [1] }), rec({ id: 'd', stamp: stamp() })] });
  assert.equal(r.counts.stamped, 1);
  assert.equal(r.counts.unstamped, 3);
  assert.equal(r.strata.manual.stamped, 1);
  assert.deepEqual(r.strata.manual.unstamped, { n: 3, insufficient: true });
});

test('first pass: approved, never requeued, blocked or sent to clarification, at most one draft; advisory events are noise', () => {
  assert.equal(isFirstPass({ history: FIRST.map((stage) => ({ stage })) }), true);
  assert.equal(isFirstPass({ history: [...FIRST, 'advisory', 'advisory'].map((stage) => ({ stage })) }), true);
  for (const retry of ['requeued', 'blocked', 'needs-clarification']) assert.equal(isFirstPass({ history: ['draft-started', retry, 'approved'].map((stage) => ({ stage })) }), false, retry);
  assert.equal(isFirstPass({ history: ['draft-started', 'draft-started', 'approved'].map((stage) => ({ stage })) }), false);
  assert.equal(isFirstPass({ history: ['draft-started', 'plan-done'].map((stage) => ({ stage })) }), false, 'never approved');
  assert.equal(isFirstPass({}), false);
  assert.equal(isFirstPass({ history: 'x' }), false);
  assert.equal(isFirstPass(null), false);
});

test('no-op, dismissed, abandoned and filed tasks are excluded from the outcomes, not counted as shipped', () => {
  const r = run({ done: [rec({ id: 'a' }), rec({ id: 'b', disposition: 'noop' }), rec({ id: 'c', disposition: 'dismissed' }), rec({ id: 'd', disposition: 'abandoned' }), rec({ id: 'e', disposition: 'filed' }), rec({ id: 'f', disposition: 'pending-merge' }), rec({ id: 'g', disposition: undefined })] });
  assert.equal(r.counts.shipped, 3);
  assert.equal(r.counts.excludedDone, 4);
});

test('strata are per source and sources are never pooled', () => {
  const r = run({ done: [...many(12, (i) => rec({ id: `m${i}`, source: 'manual', stamp: stamp() })), ...many(3, (i) => rec({ id: `b${i}`, source: 'brain_dump_sort', stamp: stamp() })), (() => { const r = rec({ id: 'u' }); delete r.source; return r; })()] });
  assert.deepEqual(Object.keys(r.strata), ['brain_dump_sort', 'manual', 'unknown']);
  assert.equal(r.strata.manual.stamped, 12);
  assert.equal(r.strata.brain_dump_sort.stamped, 3);
  assert.equal(r.strata.manual.cells.anchorFileCount['1-2'].n, 12);
  assert.deepEqual(r.strata.brain_dump_sort.cells.anchorFileCount['1-2'], { n: 3, insufficient: true });
});

test('a cell under 10 tasks reports insufficient and no rate; with 10 it reports the counts and the median stage count', () => {
  const nine = run({ done: many(9, (i) => rec({ id: `a${i}`, stamp: stamp() })) });
  assert.deepEqual(nine.strata.manual.cells.orientRan.true, { n: 9, insufficient: true });
  const ten = run({ done: many(10, (i) => rec({ id: `a${i}`, stamp: stamp() })) });
  assert.deepEqual(ten.strata.manual.cells.orientRan.true, { n: 10, approvedFirstPass: 10, blockedOrNeedsClarification: 0, medianHistoryStages: 8 });
});

test('the contrast set (blocked and needs-clarification) is counted in the same cells and its block classes are tallied', () => {
  const stuck = (id, reason) => rec({ id, stages: ['draft-started', 'plan-done', 'blocked'], disposition: undefined, stamp: stamp(), blockedReason: reason });
  const r = run({
    done: many(6, (i) => rec({ id: `d${i}`, stamp: stamp() })),
    blocked: [stuck('b1', 'Deterministic gate: executed verification failed'), stuck('b2', 'Plan pass degenerate: truncated'), stuck('b3', 'Ungrounded draft: The Solution invents a path'), stuck('b4', 'sub-task premise may be stale: x')],
    'needs-clarification': [rec({ id: 'n1', stages: ['draft-started', 'needs-clarification'], disposition: undefined, stamp: stamp(), needsClarification: { reason: 'design-decision', openQuestions: [] } })],
  });
  assert.equal(r.counts.blocked, 4);
  assert.equal(r.counts.needsClarification, 1);
  const c = r.strata.manual.cells.anchorFileCount['1-2'];
  assert.deepEqual([c.n, c.approvedFirstPass, c.blockedOrNeedsClarification], [11, 6, 5]);
  assert.equal(r.strata.manual.stuck, 5);
  assert.deepEqual(r.strata.manual.blockedClasses, { 'executed-verification-gate': 1, 'degenerate-plan': 1, 'ungrounded-draft': 1, 'stale-premise': 1, 'design-decision': 1 });
});

test('blockedClass maps the real reason heads, objects included, and everything else is other', () => {
  const cases = [[{ blockedReason: 'Agentic implement pass produced a diff that x' }, 'agentic-diff'], [{ needsClarification: { reason: 'design-decision' } }, 'design-decision'], [{ blockedReason: 'something new' }, 'other'], [{}, 'other'], [null, 'other']];
  for (const [task, want] of cases) assert.equal(blockedClass(task), want);
});

test('feature buckets: anchors 0 / 1-2 / 3+, grep hits 0 / 1+, orient true / false, prior rejections 0 / 1+; a missing value skips that feature only', () => {
  const at = (n) => rec({ id: `k${n}`, stamp: stamp({ anchorFileCount: n }) });
  const r = run({ done: [...many(10, () => at(0)), ...many(10, () => at(1)), ...many(10, () => at(2)), ...many(10, () => at(3)), ...many(10, () => at(9))] });
  const a = r.strata.manual.cells.anchorFileCount;
  assert.deepEqual([a['0'].n, a['1-2'].n, a['3+'].n], [10, 20, 20]);
  const g = run({ done: [...many(10, () => rec({ stamp: stamp({ grepHitFileCount: 0 }) })), ...many(10, () => rec({ stamp: stamp({ grepHitFileCount: 4 }) }))] }).strata.manual.cells.grepHitFileCount;
  assert.deepEqual([g['0'].n, g['1+'].n], [10, 10]);
  const o = run({ done: [...many(10, () => rec({ stamp: stamp({ orientRan: false }) })), ...many(10, () => rec({ stamp: stamp({ orientRan: true }) }))] }).strata.manual.cells.orientRan;
  assert.deepEqual([o.false.n, o.true.n], [10, 10]);
  const p = run({ done: [...many(10, () => rec({ stamp: stamp({ priorRejectionCount: 0 }) })), ...many(10, () => rec({ stamp: stamp({ priorRejectionCount: 2 }) }))] }).strata.manual.cells.priorRejectionCount;
  assert.deepEqual([p['0'].n, p['1+'].n], [10, 10]);
  const partial = run({ done: many(10, () => rec({ stamp: { v: 1, anchorFileCount: 1 } })) }).strata.manual;
  assert.equal(partial.cells.anchorFileCount['1-2'].n, 10);
  assert.deepEqual(partial.cells.grepHitFileCount, {});
  assert.deepEqual(partial.cells.orientRan, {});
});

test('the window: tasks older than sinceMs are left out, the reader is asked only for files from the cut-off on, and a record with no history or no date is left out', () => {
  const calls = [];
  const dirs = { done: [rec({ id: 'new', agoMs: 2 * DAY }), rec({ id: 'old', agoMs: 20 * DAY }), { id: 'nohist', source: 'manual' }, { id: 'nodate', history: [{ stage: 'x' }] }] };
  const r = joinContextOutcomes({ pipelineDir: '/p', nowMs: NOW, sinceMs: 14 * DAY, readDir: (dir, min) => { calls.push([path.basename(dir), min]); return dirs[path.basename(dir)] || []; } });
  assert.equal(r.counts.shipped, 1);
  assert.deepEqual(calls.map((c) => c[0]), ['done', 'blocked', 'needs-clarification']);
  assert.ok(calls.every((c) => c[1] === NOW - 14 * DAY));
  const wide = joinContextOutcomes({ pipelineDir: '/p', nowMs: NOW, sinceMs: 30 * DAY, readDir: (dir) => dirs[path.basename(dir)] || [] });
  assert.equal(wide.counts.shipped, 2);
});

test('the median counts stage events without the advisory noise, and a record with no votes or odd history does not throw', () => {
  const noisy = many(10, (i) => rec({ id: `n${i}`, stamp: stamp(), stages: [...FIRST.slice(0, 5), 'advisory', 'advisory', 'advisory', ...FIRST.slice(5)] }));
  assert.equal(run({ done: noisy }).strata.manual.cells.orientRan.true.medianHistoryStages, 8);
  assert.doesNotThrow(() => run({ done: [{ source: 'manual', terminalDisposition: 'merged', history: [null, {}, { stage: 5 }, { stage: 'approved', at: iso(DAY) }] }] }));
});

test('the output has no causal wording and no recommendation, and is plain JSON', () => {
  const r = run({ done: many(12, (i) => rec({ id: `a${i}`, stamp: stamp() })), blocked: many(3, (i) => rec({ id: `b${i}`, stamp: stamp(), stages: ['draft-started', 'blocked'], disposition: undefined })) });
  const text = JSON.stringify(r).toLowerCase();
  for (const word of ['because', 'causes', 'caused', 'improves', 'improved', 'recommend', 'should', 'better', 'worse', 'helps', 'helped']) assert.equal(text.includes(word), false, word);
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
});

test('parseSince reads 14d, 36h, 90m and a bare number of days, and falls back to 14 days', () => {
  assert.equal(parseSince('14d'), 14 * DAY);
  assert.equal(parseSince('36h'), 36 * 60 * 60 * 1000);
  assert.equal(parseSince('90m'), 90 * 60 * 1000);
  assert.equal(parseSince('2'), 2 * DAY);
  for (const bad of [undefined, '', 'x', '-3d']) assert.equal(parseSince(bad), 14 * DAY);
});

test('defaultReadDir reads only files at or after the mtime cut-off, skips torn and non-json files, and a missing directory gives nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-out-'));
  try {
    const put = (name, text, ageMs) => { const f = path.join(dir, name); fs.writeFileSync(f, text); const t = new Date(NOW - ageMs); fs.utimesSync(f, t, t); };
    put('new.json', JSON.stringify({ id: 'new' }), DAY);
    put('old.json', JSON.stringify({ id: 'old' }), 30 * DAY);
    put('torn.json', '{"id":', DAY);
    put('note.txt', 'x', DAY);
    assert.deepEqual(defaultReadDir(dir, NOW - 14 * DAY).map((r) => r.id), ['new']);
    assert.deepEqual(defaultReadDir(dir, 0).map((r) => r.id).sort(), ['new', 'old']);
    assert.deepEqual(defaultReadDir(path.join(dir, 'nowhere'), 0), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the CLI prints the JSON for a pipeline directory and reads nothing it should not: a real queue layout in a temp directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-out-cli-'));
  try {
    for (const s of ['done', 'blocked', 'needs-clarification']) fs.mkdirSync(path.join(dir, 'queue', s), { recursive: true });
    fs.writeFileSync(path.join(dir, 'queue', 'done', 'a.json'), JSON.stringify({ id: 'a', source: 'manual', terminalDisposition: 'merged', history: [{ stage: 'approved', at: new Date().toISOString() }], contextProvenance: { v: 1, anchorFileCount: 2 } }));
    const before = fs.readdirSync(path.join(dir, 'queue', 'done')).length;
    const res = spawnSync(process.execPath, [path.join(__dirname, 'context-outcomes.js'), '--since', '7d', '--pipeline-dir', dir], { encoding: 'utf8', env: { PATH: process.env.PATH } });
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.counts.shipped, 1);
    assert.equal(out.counts.stamped, 1);
    assert.equal(out.window.sinceMs, 7 * DAY);
    assert.deepEqual(out.caveats, CAVEATS);
    assert.equal(fs.readdirSync(path.join(dir, 'queue', 'done')).length, before);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the one-versus-many boundary: exactly 1 grep-hit file and exactly 1 prior rejection fall in the 1+ buckets, 0 in the 0 buckets', () => {
  const cells = (over) => run({ done: [...many(10, () => rec({ stamp: stamp(over[0]) })), ...many(10, () => rec({ stamp: stamp(over[1]) }))] }).strata.manual.cells;
  const g = cells([{ grepHitFileCount: 0 }, { grepHitFileCount: 1 }]).grepHitFileCount;
  assert.deepEqual([g['0'].n, g['1+'].n], [10, 10]);
  const p = cells([{ priorRejectionCount: 0 }, { priorRejectionCount: 1 }]).priorRejectionCount;
  assert.deepEqual([p['0'].n, p['1+'].n], [10, 10]);
});

test('a record dated in the future is left out (an hour of clock skew is allowed, five days is not)', () => {
  const r = run({ done: [rec({ id: 'skew', agoMs: -60 * 60 * 1000 }), rec({ id: 'future', agoMs: -5 * DAY }), rec({ id: 'now' })] });
  assert.equal(r.counts.shipped, 2);
});

test('the median of an even number of cell tasks is the mean of the two middle stage counts', () => {
  const four = ['created', 'draft-started', 'approved', 'merged'];
  const six = [...four, 'applied', 'pending-merge'];
  const r = run({ done: [...many(5, (i) => rec({ id: `f${i}`, stamp: stamp(), stages: four })), ...many(5, (i) => rec({ id: `s${i}`, stamp: stamp(), stages: six }))] });
  assert.equal(r.strata.manual.cells.orientRan.true.medianHistoryStages, 5);
  const odd = run({ done: [...many(5, (i) => rec({ id: `f${i}`, stamp: stamp(), stages: four })), ...many(6, (i) => rec({ id: `s${i}`, stamp: stamp(), stages: six }))] });
  assert.equal(odd.strata.manual.cells.orientRan.true.medianHistoryStages, 6);
});

test('untilMs is a strict upper end: a task after it is left out, and the default still allows an hour of clock skew', () => {
  const dirs = { done: [rec({ id: 'in', agoMs: 3 * DAY }), rec({ id: 'late', agoMs: DAY })] };
  const bounded = run(dirs, { untilMs: NOW - 2 * DAY });
  assert.equal(bounded.counts.shipped, 1);
  assert.equal(run(dirs).counts.shipped, 2);
  assert.equal(run({ done: [rec({ id: 'skew', agoMs: -60 * 60 * 1000 })] }).counts.shipped, 1);
});

test('the default upper end allows one day of clock skew, not more: a task dated a day and a half ahead is left out', () => {
  assert.equal(run({ done: [rec({ id: 'ahead', agoMs: -1.5 * DAY })] }).counts.shipped, 0);
  assert.equal(run({ done: [rec({ id: 'ahead', agoMs: -0.9 * DAY })] }).counts.shipped, 1);
});
