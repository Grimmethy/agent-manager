'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { registerTaskSource, getRegisteredSource } = require('./task-source-registry.js');

function pipeline(tasks) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grs-'));
  for (const [state, t] of tasks) {
    fs.mkdirSync(path.join(dir, 'queue', state), { recursive: true });
    fs.writeFileSync(path.join(dir, 'queue', state, `${t.id}.json`), JSON.stringify(t));
  }
  return dir;
}
const has = (dir, state, id) => fs.existsSync(path.join(dir, 'queue', state, `${id}.json`));
const read = (dir, state, id) => JSON.parse(fs.readFileSync(path.join(dir, 'queue', state, `${id}.json`), 'utf8'));

const blocked = (over = {}) => ({
  id: 'test-task-1', domain: 'default', source: 'test_grounding_source', title: 't',
  status: 'blocked', createdAt: '2026-09-27T00:00:00Z', blockedStage: 'review',
  blockedReason: 'Ungrounded draft: the Solution claims X but the real snippet shows Y',
  reviewInconclusive: true, implementResponse: 'GENUINE\n### AC-1\nsome candidate text',
  history: [{ stage: 'created', at: '2026-09-27T00:00:00Z' }, { stage: 'blocked', at: '2026-09-27T00:01:00Z' }],
  ...over,
});

// A registered source whose postImplementCheck's verdict is controlled per-test via a
// module-level mutable box, so the SAME registered source can answer differently across
// calls without re-registering (registerTaskSource throws on a duplicate id).
const verdictBox = { verdict: 'ok', reason: 'still fabricated' };
let registered = false;
function ensureTestSourceRegistered() {
  if (registered) return;
  registered = true;
  registerTaskSource('test_grounding_source', {
    priority: 1,
    next: () => null,
    postImplementCheck: async (task, implementResponse) => {
      if (verdictBox.verdict === 'ok') return { verdict: 'ok' };
      return { verdict: verdictBox.verdict, reason: verdictBox.reason };
    },
  });
}
test.before(() => { ensureTestSourceRegistered(); });

let sweepGroundingRecheck;
test.before(() => {
  // Required AFTER the test source is registered above, and with getRegisteredSource
  // confirmed non-empty first -- the module under test also requires task-sources.js /
  // ensureRegistered() at its own load time, which must not clobber the test registration.
  ({ sweepGroundingRecheck } = require('./grounding-recheck-sweep.js'));
  assert.ok(getRegisteredSource('test_grounding_source'), 'test source must be registered before the module under test loads');
});

const run = (dir, over = {}) => sweepGroundingRecheck({ pipelineDir: dir, ...over });

test('recovers a task straight to approved/ when the registered check now says ok, with no redraft', async () => {
  verdictBox.verdict = 'ok';
  const dir = pipeline([['blocked', blocked()]]);
  const s = await run(dir);
  assert.equal(s.recovered.length, 1);
  assert.ok(!has(dir, 'blocked', 'test-task-1'));
  const t = read(dir, 'approved', 'test-task-1');
  assert.equal(t.blockedReason, undefined);
  assert.equal(t.blockedStage, undefined);
  assert.equal(t.reviewInconclusive, undefined);
  assert.equal(t.reviewProvider, 'grounding-recheck-sweep');
  assert.match(t.history[t.history.length - 1].detail, /now passes/);
});

test('grants exactly one real redraft chance on the FIRST recheck when the check still says ungrounded', async () => {
  verdictBox.verdict = 'ungrounded';
  verdictBox.reason = 'still fabricated the same helper behavior';
  const dir = pipeline([['blocked', blocked()]]);
  const s = await run(dir);
  assert.equal(s.requeued.length, 1);
  assert.ok(!has(dir, 'blocked', 'test-task-1'));
  const t = read(dir, 'pending', 'test-task-1');
  assert.equal(t.status, 'pending');
  assert.equal(t.groundingRecheckAttempted, true);
  assert.equal(t.reviewInconclusive, undefined, 'cleared so a genuine next rejection is visible to reject-retry-check.js');
  assert.equal(t.blockedStage, undefined);
  assert.equal(t.blockedReason, undefined);
  assert.equal(t.implementResponse, undefined, 'cleared for a fresh implement pass');
  assert.equal(t.localRejectCount, 1);
  assert.ok(t.priorRejectionFeedback.includes('still fabricated the same helper behavior'));
});

test('escalates to needs-clarification on the SECOND failure (groundingRecheckAttempted already true)', async () => {
  verdictBox.verdict = 'ungrounded';
  const dir = pipeline([['blocked', blocked({ groundingRecheckAttempted: true })]]);
  const s = await run(dir);
  assert.equal(s.exhausted.length, 1);
  assert.equal(s.exhausted[0].disposition, 'needs-clarification');
  assert.ok(!has(dir, 'blocked', 'test-task-1'));
  const t = read(dir, 'needs-clarification', 'test-task-1');
  assert.equal(t.needsClarification.reason, 'fabricated-ungrounded-claim');
  assert.ok(Array.isArray(t.needsClarification.openQuestions) && t.needsClarification.openQuestions.length > 0);
});

test('a pipeline_debrief/pipeline_forensics task on its SECOND failure is marked exhausted and left in blocked/, not escalated (matches the existing "usually moot" design)', async () => {
  verdictBox.verdict = 'ungrounded';
  const dir = pipeline([['blocked', blocked({ source: 'pipeline_debrief', groundingRecheckAttempted: true })]]);
  const s = await run(dir);
  assert.equal(s.exhausted.length, 1);
  assert.equal(s.exhausted[0].disposition, 'moot');
  assert.ok(has(dir, 'blocked', 'test-task-1'), 'stays in blocked/, not moved');
  const t = read(dir, 'blocked', 'test-task-1');
  assert.ok(t.history.some((h) => h.stage === 'exhausted'));
  assert.equal(t.needsClarification, undefined);
});

test('a pipeline_debrief task recovers normally on its FIRST recheck like any other source', async () => {
  verdictBox.verdict = 'ok';
  const dir = pipeline([['blocked', blocked({ source: 'pipeline_debrief' })]]);
  const s = await run(dir);
  assert.equal(s.recovered.length, 1);
});

test('never touches a task without reviewInconclusive:true (a genuine reviewer rejection, not this sweep\'s job)', async () => {
  const dir = pipeline([['blocked', blocked({ reviewInconclusive: undefined })]]);
  const s = await run(dir);
  assert.equal(s.checked, 0);
  assert.ok(has(dir, 'blocked', 'test-task-1'));
});

test('never touches a task whose source has no registered postImplementCheck', async () => {
  const dir = pipeline([['blocked', blocked({ source: 'no_such_source' })]]);
  const s = await run(dir);
  assert.equal(s.checked, 0);
  assert.ok(has(dir, 'blocked', 'test-task-1'));
});

test('never touches a task with no implementResponse', async () => {
  const dir = pipeline([['blocked', blocked({ implementResponse: '' })]]);
  const s = await run(dir);
  assert.equal(s.checked, 0);
  assert.ok(has(dir, 'blocked', 'test-task-1'));
});

test('a check that throws on recheck is treated as ok (same fail-safe local-draft.js\'s own call site uses)', async () => {
  registerTaskSource('test_grounding_source_throws', {
    priority: 1, next: () => null,
    postImplementCheck: async () => { throw new Error('boom'); },
  });
  const dir = pipeline([['blocked', blocked({ id: 'test-task-2', source: 'test_grounding_source_throws' })]]);
  const s = await run(dir);
  assert.equal(s.recovered.length, 1);
});

test('respects the AGENT_MANAGER_GROUNDING_RECHECK=false kill switch', async () => {
  verdictBox.verdict = 'ok';
  const dir = pipeline([['blocked', blocked()]]);
  const prev = process.env.AGENT_MANAGER_GROUNDING_RECHECK;
  process.env.AGENT_MANAGER_GROUNDING_RECHECK = 'false';
  try {
    const s = await run(dir);
    assert.equal(s.checked, 0);
    assert.ok(has(dir, 'blocked', 'test-task-1'));
  } finally {
    if (prev === undefined) delete process.env.AGENT_MANAGER_GROUNDING_RECHECK;
    else process.env.AGENT_MANAGER_GROUNDING_RECHECK = prev;
  }
});

test('picks up a task sitting in needs-clarification/ too, not just blocked/', async () => {
  verdictBox.verdict = 'ok';
  const dir = pipeline([['needs-clarification', blocked()]]);
  const s = await run(dir);
  assert.equal(s.recovered.length, 1);
  assert.equal(s.recovered[0].from, 'needs-clarification');
});
