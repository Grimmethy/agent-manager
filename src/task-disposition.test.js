'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveDisposition, TERMINAL_STAGES, lastAppliedEvent } = require('./task-disposition.js');

// A fake buildShipContext() result.
function ctx({ onMain = {}, branches = {} } = {}) {
  return {
    mainBranch: 'master',
    onMainIds: new Map(Object.entries(onMain)),
    branchAhead: new Map(Object.entries(branches)),
  };
}
const applied = (detail) => ({ history: [{ stage: 'created' }, { stage: 'applied', detail }] });

test('resolveDisposition returns null for a record that was never applied', () => {
  assert.equal(resolveDisposition({ id: 't', history: [{ stage: 'created' }, { stage: 'blocked' }] }, { ctx: ctx() }), null);
});

test('resolveDisposition returns null when a stable terminal event is already the tail', () => {
  for (const stage of ['merged', 'filed', 'dismissed', 'noop', 'abandoned', 'applied-direct', 'superseded']) {
    const r = { id: 't', history: [{ stage: 'applied', detail: 'agent/t' }, { stage, detail: 'x' }] };
    assert.equal(resolveDisposition(r, { ctx: ctx() }), null, `${stage} tail must be left alone`);
  }
});

test('resolveDisposition RE-resolves a pending-merge tail (the branch may have merged since)', () => {
  const r = { id: 't', ...applied('agent/t'), };
  r.history.push({ stage: 'pending-merge', detail: 'old' });
  const out = resolveDisposition(r, { ctx: ctx({ onMain: { t: 'abc123def456' } }) });
  assert.equal(out.stage, 'merged');
});

test('resolveDisposition: on origin/main by commit trailer -> merged with the sha', () => {
  const out = resolveDisposition({ id: 'observability-fix-ac-9', ...applied('agent/observability-fix-ac-9') },
    { ctx: ctx({ onMain: { 'observability-fix-ac-9': '0123456789abcdef' } }) });
  assert.equal(out.stage, 'merged');
  assert.match(out.detail, /0123456789ab/);
  assert.match(out.detail, /commit-trailer/);
});

test('resolveDisposition: agent branch ahead of main -> pending-merge', () => {
  const out = resolveDisposition({ id: 'ac-50', ...applied('agent/ac-50') }, { ctx: ctx({ branches: { 'ac-50': 1 } }) });
  assert.equal(out.stage, 'pending-merge');
  assert.match(out.detail, /1 commit\(s\) ahead/);
});

test('resolveDisposition: agent branch exists but not ahead -> merged', () => {
  const out = resolveDisposition({ id: 'ac-51', ...applied('agent/ac-51') }, { ctx: ctx({ branches: { 'ac-51': 0 } }) });
  assert.equal(out.stage, 'merged');
  assert.match(out.detail, /not ahead/);
});

test('resolveDisposition: applied to a now-gone branch, not on main -> abandoned (the loud one)', () => {
  const out = resolveDisposition({ id: 'ac-36', ...applied('agent/observability-fix-ac-36') }, { ctx: ctx() });
  assert.equal(out.stage, 'abandoned');
  assert.match(out.detail, /work lost/);
});

test('resolveDisposition: directToMain triage-batch apply detail -> applied-direct', () => {
  const out = resolveDisposition({ id: 'obs-review-1', ...applied('committed to master in a 21-task triage batch') }, { ctx: ctx() });
  assert.equal(out.stage, 'applied-direct');
});

test('resolveDisposition: a doc/note apply -> filed', () => {
  const out = resolveDisposition({ id: 'bd-1', ...applied('filed under "task" -> /media/wok/SecondBrain/x.md') }, { ctx: ctx() });
  assert.equal(out.stage, 'filed');
});

test('resolveDisposition: a no-op verdict apply -> noop', () => {
  for (const d of ['no candidates in implement response -- nothing to apply', 'False positive. The catch block is not silent.', 'no code change needed (empty implement response)']) {
    assert.equal(resolveDisposition({ id: 'x', ...applied(d) }, { ctx: ctx() }).stage, 'noop', d);
  }
});

test('resolveDisposition: an unclassifiable non-branch apply detail -> noop, never abandoned', () => {
  const out = resolveDisposition({ id: 'weird', ...applied('suggested 0 path(s) for adhoc-brain-dump-x') }, { ctx: ctx() });
  assert.equal(out.stage, 'noop');
});

// --- structured review disposition + the `dismissed` stage ---------------------------

test('resolveDisposition: reviewDisposition "dismissed" -> dismissed, wins over every git check', () => {
  const r = { id: 'obs-r-1', reviewDisposition: 'dismissed', ...applied('no candidates in implement response -- nothing to apply') };
  const out = resolveDisposition(r, { ctx: ctx({ onMain: { 'obs-r-1': 'aaaa1111bbbb' } }) });
  assert.equal(out.stage, 'dismissed');
  assert.match(out.detail, /false positive/i);
});

test('resolveDisposition: reviewDisposition "inconclusive" -> noop with an honest detail', () => {
  const out = resolveDisposition({ id: 'x', reviewDisposition: 'inconclusive', ...applied('no candidates in implement response -- nothing to apply') }, { ctx: ctx() });
  assert.equal(out.stage, 'noop');
  assert.match(out.detail, /produced nothing/);
});

test('resolveDisposition: reviewDisposition "genuine" falls through to the normal path', () => {
  // genuine + candidate committed in a triage batch -> merged by the (task <id>) trailer
  const out = resolveDisposition({ id: 'obs-r-2', reviewDisposition: 'genuine', ...applied('committed to master in a 12-task triage batch') },
    { ctx: ctx({ onMain: { 'obs-r-2': 'cccc2222dddd' } }) });
  assert.equal(out.stage, 'merged');
});

test('resolveDisposition: no structured field, review source + FALSE POSITIVE verdict text -> dismissed', () => {
  const r = {
    id: 'observability-am-silent-catch-block-src-x-js-40',
    source: 'observability_review',
    history: [{ stage: 'created' }, { stage: 'applied', detail: 'no candidates in implement response -- nothing to apply' }],
    implementResponse: 'FALSE POSITIVE. The catch block returns a documented fallback value; the function contract is best-effort.',
  };
  assert.equal(resolveDisposition(r, { ctx: ctx() }).stage, 'dismissed');
});

test('resolveDisposition: the FALSE POSITIVE fallback is gated to *_review sources', () => {
  // same verdict text on a non-review source must NOT be read as a dismissal
  const r = {
    id: 'adhoc-x', source: 'adhoc',
    history: [{ stage: 'created' }, { stage: 'applied', detail: 'nothing to do' }],
    implementResponse: 'This is not a false positive, it is a real bug, but I could not fix it.',
  };
  assert.equal(resolveDisposition(r, { ctx: ctx() }).stage, 'noop');
});

test('resolveDisposition: allowReopenFrom re-resolves a noop tail to dismissed, only when passed', () => {
  const r = {
    id: 'obs-r-3', source: 'observability_review',
    history: [
      { stage: 'created' },
      { stage: 'applied', detail: 'no candidates in implement response -- nothing to apply' },
      { stage: 'noop', detail: 'no-op apply' },
    ],
    implementResponse: 'FALSE POSITIVE — the except binds e and the documented contract returns None.',
  };
  assert.equal(resolveDisposition(r, { ctx: ctx() }), null, 'noop tail is stable without the opt-in');
  const out = resolveDisposition(r, { ctx: ctx(), allowReopenFrom: new Set(['noop']) });
  assert.equal(out.stage, 'dismissed');
});

test('resolveDisposition: allowReopenFrom does not re-open merged/filed/etc', () => {
  const r = { id: 't', source: 'observability_review', history: [{ stage: 'applied', detail: 'x' }, { stage: 'merged', detail: 'y' }] };
  assert.equal(resolveDisposition(r, { ctx: ctx(), allowReopenFrom: new Set(['noop']) }), null);
});

test('trailer detection wins over a still-present ahead branch (hand-applied, branch left behind)', () => {
  const out = resolveDisposition({ id: 'ac-110', ...applied('agent/ac-110') },
    { ctx: ctx({ onMain: { 'ac-110': 'deadbeefcafe' }, branches: { 'ac-110': 1 } }) });
  assert.equal(out.stage, 'merged');
});

test('lastAppliedEvent picks the LAST applied event when a task was applied twice (requeue-after-apply-fail)', () => {
  const h = [{ stage: 'applied', detail: 'first' }, { stage: 'apply-failed' }, { stage: 'applied', detail: 'second' }];
  assert.equal(lastAppliedEvent(h).detail, 'second');
});

test('a superseded tail is respected as terminal -- the sweep never re-opens it', () => {
  const r = { id: 't', history: [{ stage: 'applied', detail: 'agent/t' }, { stage: 'superseded', detail: 'fix landed via ac-121' }] };
  assert.equal(resolveDisposition(r, { ctx: ctx() }), null, 'superseded must not be re-resolved back to abandoned');
});

test('TERMINAL_STAGES is the closed vocabulary', () => {
  assert.deepEqual([...TERMINAL_STAGES].sort(), ['abandoned', 'applied-direct', 'dismissed', 'filed', 'merged', 'noop', 'pending-merge', 'superseded']);
});
