'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  beginDraftAttempt, recordPlan, recordImplement, recordCritique, recordTier,
  finalizeDraftAttempt, collapseOldAttempts, summariseToolCalls,
  PLAN_TEXT_CAP, RESPONSE_TEXT_CAP, DIFF_TEXT_CAP, MAX_FULL_ATTEMPTS,
} = require('./draft-attempt-record.js');

test('beginDraftAttempt: attemptNo counts up over whatever is already on the task', () => {
  assert.equal(beginDraftAttempt({}).attemptNo, 1);
  assert.equal(beginDraftAttempt({ draftAttempts: [] }).attemptNo, 1);
  assert.equal(beginDraftAttempt({ draftAttempts: [{}, {}] }).attemptNo, 3);
  const a = beginDraftAttempt({ source: 'adhoc', localRejectCount: 2 });
  assert.equal(a.source, 'adhoc');
  assert.equal(a.localRejectCount, 2);
  assert.deepEqual(a.tiers, []);
  assert.ok(a.at);
});

test('recordPlan: full text under the cap is kept verbatim; a degenerate plan records the reason, not text', () => {
  const a = beginDraftAttempt({});
  recordPlan(a, { text: 'here is the plan', attempts: 2 });
  assert.equal(a.plan.text, 'here is the plan');
  assert.equal(a.plan.chars, 'here is the plan'.length);
  assert.equal(a.plan.attempts, 2);
  assert.equal(a.plan.degenerate, undefined);

  const b = beginDraftAttempt({});
  recordPlan(b, { degenerate: 'empty', attempts: 3 });
  assert.equal(b.plan.degenerate, 'empty');
  assert.equal(b.plan.chars, 0);
  assert.equal(b.plan.text, undefined);
});

test('recordPlan: an over-cap plan is truncated with a marker but chars reflects the TRUE length', () => {
  const a = beginDraftAttempt({});
  const huge = 'x'.repeat(PLAN_TEXT_CAP + 5000);
  recordPlan(a, { text: huge });
  assert.equal(a.plan.chars, huge.length);
  assert.ok(a.plan.text.length < huge.length);
  assert.match(a.plan.text, /truncated 5000 more chars/);
});

test('recordImplement: note and text can coexist; degenerate is recorded separately', () => {
  const a = beginDraftAttempt({});
  recordImplement(a, { text: 'the diff', note: 'split into 3 sub-candidate(s)', attempts: 1 });
  assert.equal(a.implement.text, 'the diff');
  assert.equal(a.implement.note, 'split into 3 sub-candidate(s)');
  assert.equal(a.implement.chars, 'the diff'.length);

  const b = beginDraftAttempt({});
  recordImplement(b, { degenerate: 'repetition-loop' });
  assert.equal(b.implement.degenerate, 'repetition-loop');
  assert.equal(b.implement.chars, 0);
});

test('recordCritique records the outcome enum and whether a revision was applied', () => {
  const a = beginDraftAttempt({});
  recordCritique(a, { outcome: 'issues-flagged', revised: true });
  assert.deepEqual(a.critique, { outcome: 'issues-flagged', revised: true });
});

test('recordTier: captures resolution/applied/reason + response + diff (all capped) + tool summary', () => {
  const a = beginDraftAttempt({});
  recordTier(a, {
    tier: 'local-agentic-write',
    resolution: 'implemented',
    reason: 'did the thing',
    response: 'y'.repeat(RESPONSE_TEXT_CAP + 100),
    rawDiff: 'd'.repeat(DIFF_TEXT_CAP + 100),
    turnsUsed: 12,
    toolCallLog: [
      { tool: 'read_file', args: { path: 'a.js' }, result: { content: 'abc' } },
      { tool: 'read_file', args: { path: 'b.js' }, result: { content: 'defgh' } },
      { tool: 'edit_file', args: { path: 'a.js', find: 'x', replace: 'y' }, result: { error: 'not found' } },
    ],
  });
  const t = a.tiers[0];
  assert.equal(t.tier, 'local-agentic-write');
  assert.equal(t.resolution, 'implemented');
  assert.equal(t.reason, 'did the thing');
  assert.equal(t.turnsUsed, 12);
  assert.equal(t.responseChars, RESPONSE_TEXT_CAP + 100);
  assert.ok(t.response.length < RESPONSE_TEXT_CAP + 100);
  assert.equal(t.rawDiffChars, DIFF_TEXT_CAP + 100);
  assert.ok(t.rawDiff.length < DIFF_TEXT_CAP + 100);
  assert.equal(t.toolCalls.total, 3);
  assert.deepEqual(t.toolCalls.byTool, { read_file: 2, edit_file: 1 });
  assert.equal(t.toolCalls.errors, 1);
  // arg VALUES (paths, edit bodies, shell commands) are never kept -- only the keys.
  const edit = t.toolCalls.calls.find((c) => c.tool === 'edit_file');
  assert.deepEqual(edit.argKeys, ['path', 'find', 'replace']);
  assert.equal(edit.error, true);
  assert.equal(JSON.stringify(t.toolCalls).includes('a.js'), false);
});

test('recordTier: an empty response / empty diff / empty toolCallLog leaves those keys off entirely', () => {
  const a = beginDraftAttempt({});
  recordTier(a, { tier: 'harness-search', applied: false, reason: 'no matches', response: '', rawDiff: '', toolCallLog: [] });
  const t = a.tiers[0];
  assert.equal(t.applied, false);
  assert.equal(t.reason, 'no matches');
  assert.equal('response' in t, false);
  assert.equal('rawDiff' in t, false);
  assert.equal('toolCalls' in t, false);
});

test('summariseToolCalls returns undefined for a missing/empty log', () => {
  assert.equal(summariseToolCalls(undefined), undefined);
  assert.equal(summariseToolCalls([]), undefined);
});

test('summariseToolCalls caps the per-call list but keeps the true total', () => {
  const log = Array.from({ length: 60 }, (_, i) => ({ tool: 'grep_codebase', args: { q: `t${i}` }, result: { hits: [] } }));
  const s = summariseToolCalls(log);
  assert.equal(s.total, 60);
  assert.equal(s.calls.length, 40);
  assert.equal(s.listTruncated, true);
  assert.equal(s.byTool.grep_codebase, 60);
});

test('finalizeDraftAttempt: maps the draftTask result onto an outcome and appends the record', () => {
  const cases = [
    [{ succeeded: true, blocked: false }, 'succeeded'],
    [{ succeeded: true, blocked: true, blockedReason: 'nope' }, 'blocked'],
    [{ succeeded: true, blocked: false, needsClarification: true }, 'needs-clarification'],
    [{ succeeded: false, reason: 'infra boom' }, 'error'],
  ];
  for (const [result, expected] of cases) {
    const task = {};
    const a = beginDraftAttempt(task);
    finalizeDraftAttempt(task, a, result);
    assert.equal(task.draftAttempts.length, 1);
    assert.equal(task.draftAttempts[0].outcome, expected);
    assert.ok(task.draftAttempts[0].finishedAt);
  }
});

test('finalizeDraftAttempt: carries blockedReason / reason / adhocResolution through', () => {
  const task = { adhocResolution: 'decompose' };
  const a = beginDraftAttempt(task);
  finalizeDraftAttempt(task, a, { succeeded: true, blocked: true, blockedReason: 'too big' });
  assert.equal(task.draftAttempts[0].blockedReason, 'too big');
  assert.equal(task.draftAttempts[0].adhocResolution, 'decompose');
});

test('finalizeDraftAttempt: emitHistory is called so a persist hook can flush the record', () => {
  const task = {};
  const a = beginDraftAttempt(task);
  recordTier(a, { tier: 'harness-search', applied: false });
  recordTier(a, { tier: 'local-agentic-write', blocked: true });
  const seen = [];
  finalizeDraftAttempt(task, a, { succeeded: true, blocked: true, blockedReason: 'x' }, {
    emitHistory: (t, stage, detail) => seen.push([stage, detail]),
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], 'draft-attempt');
  assert.match(seen[0][1], /attempt 1: blocked/);
  assert.match(seen[0][1], /harness-search=declined -> local-agentic-write=blocked/);
});

test('finalizeDraftAttempt: a throwing emitHistory never breaks the pass', () => {
  const task = {};
  const a = beginDraftAttempt(task);
  assert.doesNotThrow(() => finalizeDraftAttempt(task, a, { succeeded: true }, {
    emitHistory: () => { throw new Error('disk full'); },
  }));
  assert.equal(task.draftAttempts.length, 1);
});

test('append-only across requeues: every attempt survives, plans kept char-for-char', () => {
  const task = {};
  const plans = ['plan A (93 chars-ish)', 'plan B is completely different and much longer', 'plan C'];
  plans.forEach((p, i) => {
    const a = beginDraftAttempt(task);
    recordPlan(a, { text: p });
    finalizeDraftAttempt(task, a, { succeeded: true, blocked: true, blockedReason: `round ${i}` });
  });
  assert.equal(task.draftAttempts.length, 3);
  assert.deepEqual(task.draftAttempts.map((a) => a.plan.text), plans);
  assert.deepEqual(task.draftAttempts.map((a) => a.attemptNo), [1, 2, 3]);
});

test('collapseOldAttempts: keeps the newest MAX_FULL_ATTEMPTS in full, slims the rest, preserves order/attemptNo', () => {
  const task = {};
  for (let i = 0; i < MAX_FULL_ATTEMPTS + 3; i++) {
    const a = beginDraftAttempt(task);
    recordPlan(a, { text: `plan number ${i} with some real body text` });
    recordTier(a, { tier: 'local-agentic-write', blocked: true, response: 'a long transcript '.repeat(50) });
    finalizeDraftAttempt(task, a, { succeeded: true, blocked: true, blockedReason: `r${i}` });
  }
  const all = task.draftAttempts;
  assert.equal(all.length, MAX_FULL_ATTEMPTS + 3);
  // first 3 collapsed
  for (let i = 0; i < 3; i++) {
    assert.equal(all[i].collapsed, true, `#${i} should be collapsed`);
    assert.equal(all[i].attemptNo, i + 1);
    assert.equal(all[i].tiers[0].tier, 'local-agentic-write');
    assert.equal('response' in all[i].tiers[0], false, 'a collapsed tier drops the transcript body');
    assert.ok(all[i].planChars > 0);
    assert.equal('plan' in all[i], false);
  }
  // the rest still full
  for (let i = 3; i < all.length; i++) {
    assert.equal(all[i].collapsed, undefined);
    assert.ok(all[i].plan.text);
    assert.ok(all[i].tiers[0].response);
  }
});

test('collapseOldAttempts is idempotent and a no-op below the threshold', () => {
  const few = [{ attemptNo: 1, plan: { chars: 10, text: 'x' }, tiers: [] }];
  collapseOldAttempts(few);
  assert.equal(few[0].collapsed, undefined);

  const task = {};
  for (let i = 0; i < MAX_FULL_ATTEMPTS + 2; i++) {
    const a = beginDraftAttempt(task);
    recordPlan(a, { text: 'body' });
    finalizeDraftAttempt(task, a, { succeeded: true });
  }
  const snapshot = JSON.stringify(task.draftAttempts);
  collapseOldAttempts(task.draftAttempts);
  assert.equal(JSON.stringify(task.draftAttempts), snapshot, 're-collapsing changes nothing');
});
