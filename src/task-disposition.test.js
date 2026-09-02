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
  for (const stage of ['merged', 'filed', 'noop', 'abandoned', 'applied-direct']) {
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

test('trailer detection wins over a still-present ahead branch (hand-applied, branch left behind)', () => {
  const out = resolveDisposition({ id: 'ac-110', ...applied('agent/ac-110') },
    { ctx: ctx({ onMain: { 'ac-110': 'deadbeefcafe' }, branches: { 'ac-110': 1 } }) });
  assert.equal(out.stage, 'merged');
});

test('lastAppliedEvent picks the LAST applied event when a task was applied twice (requeue-after-apply-fail)', () => {
  const h = [{ stage: 'applied', detail: 'first' }, { stage: 'apply-failed' }, { stage: 'applied', detail: 'second' }];
  assert.equal(lastAppliedEvent(h).detail, 'second');
});

test('TERMINAL_STAGES is the closed vocabulary', () => {
  assert.deepEqual([...TERMINAL_STAGES].sort(), ['abandoned', 'applied-direct', 'filed', 'merged', 'noop', 'pending-merge']);
});
