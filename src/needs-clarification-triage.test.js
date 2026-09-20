'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { needsClarificationTriage, DEGENERATE_RE, INVALID_PREMISE_RE, FALSE_CLAIM_RE, BUDGET_EXHAUSTED_RE, COMPLETABLE_NOT_DESIGN_RE, BLOCKER_TYPE_BUDGET_EXHAUSTED_RE, BLOCKER_TYPE_INFRA_ERROR_RE, hasFreshEscalationSince, isStillLeaveForHuman } = require('./needs-clarification-triage.js');

function makePipeline() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-triage-test-'));
  for (const s of ['needs-clarification', 'adhoc', 'done/_archived_no_action']) {
    fs.mkdirSync(path.join(dir, 'queue', s), { recursive: true });
  }
  return dir;
}
const held = (dir, task) => fs.writeFileSync(
  path.join(dir, 'queue', 'needs-clarification', `${task.id}.json`), JSON.stringify(task, null, 2));
const at = (dir, ...seg) => path.join(dir, 'queue', ...seg);
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const exists = (p) => fs.existsSync(p);

// majorityVote stub matching src/local-client.js's real return shape
const voteOf = (verdict, reason) => {
  const fn = async () => ({
    verdict, confident: !!verdict, votes: verdict ? [{ verdict, response: `${verdict}: ${reason}` }] : [],
    realVoteCount: verdict ? 2 : 1, requestedVotes: 3,
  });
  fn.calls = 0;
  return async (...a) => { fn.calls += 1; return fn(...a); };
};
const countingVote = (verdict, reason) => {
  const box = { calls: 0 };
  const fn = async () => { box.calls += 1; return { verdict, confident: !!verdict, votes: [{ verdict, response: `${verdict}: ${reason}` }], realVoteCount: 2, requestedVotes: 3 }; };
  fn.box = box;
  return fn;
};
const throwingVote = async () => { throw new Error('ollama down'); };

const DEGEN_OQ = "I don't have any prior context, task, or tool results to work from — this appears to be the start of our conversation with no defined problem.";
const bigRawText = 'x'.repeat(800);
const args = (dir, majorityVote) => ({ pipelineDir: dir, repoRoot: dir, majorityVote });

function baseTask(id, over = {}) {
  return {
    id, domain: 'adhoc', source: 'manual', status: 'blocked',
    promptContext: { rawText: bigRawText },
    needsClarification: { reason: 'design-decision', openQuestions: DEGEN_OQ },
    history: [{ stage: 'implement-done', at: '2026-09-01T00:00:00Z' }],
    ...over,
  };
}

test('regexes: real openQuestions strings bucket correctly', () => {
  assert.ok(DEGENERATE_RE.test(DEGEN_OQ));
  assert.ok(DEGENERATE_RE.test("I don't have any prior turns, tasks, or context to work from — this appears to be the first message in our conversation."));
  assert.ok(!DEGENERATE_RE.test('The automated handler could not get this past review after 3 attempts:'));
  assert.ok(INVALID_PREMISE_RE.test("the task's premise contradicts the codebase"));
  assert.ok(INVALID_PREMISE_RE.test('has no mapping to anything in this repository'));
  assert.ok(INVALID_PREMISE_RE.test('This is a research-domain brain-dump note'));
});

test('bucket A: degenerate draft + big rawText + no exhausted -> clean requeue to adhoc/', async () => {
  const dir = makePipeline();
  held(dir, baseTask('t1', {
    localRejectCount: 2, turnBudgetExhausted: true, adhocResolution: 'needs-human-decision',
    priorRejectionFeedback: ['x'], implementResponse: 'blah',
  }));
  const s = await needsClarificationTriage(args(dir));
  assert.deepEqual([s.checked, s.requeued, s.leftForHuman], [1, 1, 0]);
  assert.ok(!exists(at(dir, 'needs-clarification', 't1.json')));
  const moved = read(at(dir, 'adhoc', 't1.json'));
  assert.equal(moved.needsClarification, undefined);
  assert.equal(moved.localRejectCount, undefined);
  assert.equal(moved.turnBudgetExhausted, undefined);
  assert.equal(moved.priorRejectionFeedback, undefined);
  assert.equal(moved.promptContext.rawText, bigRawText, 'rawText preserved');
  assert.equal(moved.ncTriageBucketAttempts.A, 1);
  assert.ok(moved.history.some((h) => h.stage === 'requeued' && /clean-state retry 1\/1/.test(h.detail)));
  assert.equal(moved.status, 'pending', 'must not still read as blocked after a clean-slate requeue');
});

test('bucket A skipped: rawText too short -> leave for human', async () => {
  const dir = makePipeline();
  held(dir, baseTask('t2', { promptContext: { rawText: 'tiny' } }));
  const s = await needsClarificationTriage(args(dir));
  assert.deepEqual([s.requeued, s.leftForHuman], [0, 1]);
  assert.ok(exists(at(dir, 'needs-clarification', 't2.json')));
  assert.equal(read(at(dir, 'needs-clarification', 't2.json')).ncTriageDecision, 'leave-for-human');
});

test('bucket A skipped: already at MAX_REQUEUES -> leave for human', async () => {
  const dir = makePipeline();
  held(dir, baseTask('t3', { ncTriageBucketAttempts: { A: 1 } }));
  const s = await needsClarificationTriage(args(dir));
  assert.deepEqual([s.requeued, s.leftForHuman], [0, 1]);
});

test('bucket A skipped: has an exhausted history event -> bucket C retry-exhausted', async () => {
  const dir = makePipeline();
  held(dir, baseTask('t4', { history: [{ stage: 'exhausted' }, { stage: 'needs-clarification' }] }));
  const s = await needsClarificationTriage(args(dir));
  assert.deepEqual([s.requeued, s.leftForHuman], [0, 1]);
  const t = read(at(dir, 'needs-clarification', 't4.json'));
  assert.ok(t.history.some((h) => /retry-exhausted/.test(h.detail || '')));
});

test('decompose-loop flag, target IS an oversized file -> skipped entirely (autoroute owns it)', async () => {
  const dir = makePipeline();
  fs.writeFileSync(at(dir, 'file-length-flags.json'), JSON.stringify({ findings: [{ file: 'python/dashboard/app.py' }] }));
  held(dir, baseTask('t5', {
    stalenessFlag: { reason: 'decompose-loop' },
    promptContext: { rawText: 'Decompose python/dashboard/app.py -- it is too large to split in one pass.' },
  }));
  const s = await needsClarificationTriage(args(dir));
  assert.deepEqual([s.checked, s.requeued, s.leftForHuman], [0, 0, 0]);
  assert.ok(exists(at(dir, 'needs-clarification', 't5.json')));
});

test('bucket B: invalid premise + possibly-resolved reason -> archived, no vote', async () => {
  const dir = makePipeline();
  const vote = voteOf('CONFIRM', 'nope');
  held(dir, baseTask('t6', {
    needsClarification: { reason: 'design-decision', openQuestions: "the task's premise contradicts the codebase; zero matches for the fields it names" },
    promptContext: { rawText: bigRawText, reasons: ['possibly-resolved'] },
  }));
  const s = await needsClarificationTriage(args(dir, vote));
  assert.equal(s.archived, 1);
  assert.ok(!exists(at(dir, 'needs-clarification', 't6.json')));
  assert.ok(exists(at(dir, 'done/_archived_no_action', 't6.json')));
  assert.equal(vote.calls, undefined); // voteOf's wrapper doesn't expose .calls; assert via countingVote elsewhere
});

test('bucket B excluded: a "create a new file" task whose files are absent -> bucket C, never archived', async () => {
  const dir = makePipeline();
  held(dir, baseTask('tcreate', {
    // adhoc-staleness-flag would (falsely) flag this invalid-premise: the file is absent
    // because the task's job is to create it.
    stalenessFlag: { reason: 'invalid-premise', confidence: 'high' },
    promptContext: { rawText: 'Create a new file src/foo.js that extracts the helper functions. ' + 'x'.repeat(600) },
    needsClarification: { reason: 'design-decision', openQuestions: 'does not exist in the repo. I got close but ran out of turns before the next pass.' },
  }));
  const s = await needsClarificationTriage(args(dir, voteOf('CONFIRM', 'file missing')));
  assert.equal(s.archived, 0);
  assert.equal(s.leftForHuman, 1);
  assert.ok(exists(at(dir, 'needs-clarification', 'tcreate.json')));
});

test('bucket B: invalid premise, no signal, confident CONFIRM vote -> archived', async () => {
  const dir = makePipeline();
  held(dir, baseTask('t7', {
    needsClarification: { reason: 'design-decision', openQuestions: 'has no mapping to anything in this repository' },
  }));
  const s = await needsClarificationTriage(args(dir, voteOf('CONFIRM', 'symbol never existed')));
  assert.equal(s.archived, 1);
  assert.ok(exists(at(dir, 'done/_archived_no_action', 't7.json')));
});

test('bucket B: invalid premise, no signal, confident DENY vote -> flagged, left in place', async () => {
  const dir = makePipeline();
  held(dir, baseTask('t8', {
    needsClarification: { reason: 'design-decision', openQuestions: 'has no mapping to anything in this repository' },
  }));
  const s = await needsClarificationTriage(args(dir, voteOf('DENY', 'there is real work')));
  assert.equal(s.flagged, 1);
  assert.equal(s.archived, 0);
  const t = read(at(dir, 'needs-clarification', 't8.json'));
  assert.equal(t.stalenessFlag.reason, 'nc-triage-invalid-premise');
  assert.equal(t.stalenessFlag.confidence, 'medium');
});

test('bucket B: the premise vote is called with the task id + stage (so a vote-model SIDE-FINDING is attributed, not orphaned as taskId:null)', async () => {
  const dir = makePipeline();
  held(dir, baseTask('t-attrib', {
    needsClarification: { reason: 'design-decision', openQuestions: 'has no mapping to anything in this repository' },
  }));
  let seen = null;
  const recordingVote = async (opts) => {
    seen = opts;
    return { verdict: 'DENY', confident: true, votes: [{ verdict: 'DENY', response: 'DENY: x' }], realVoteCount: 2, requestedVotes: 3 };
  };
  await needsClarificationTriage(args(dir, recordingVote));
  assert.ok(seen, 'the vote was actually invoked');
  assert.equal(seen.taskId, 't-attrib');
  assert.equal(seen.stage, 'nc-triage-premise-vote');
  assert.equal(seen.source, 'needs_clarification_triage');
});

test('bucket B: vote throws -> not stamped, errors++, retried next tick', async () => {
  const dir = makePipeline();
  held(dir, baseTask('t9', {
    needsClarification: { reason: 'design-decision', openQuestions: 'has no mapping to anything in this repository' },
  }));
  const s = await needsClarificationTriage(args(dir, throwingVote));
  assert.equal(s.errors, 1);
  const t = read(at(dir, 'needs-clarification', 't9.json'));
  assert.equal(t.ncTriageReviewedAt, undefined);
  assert.equal(t.stalenessFlag, undefined);
});

test('bucket C: plain design question (no signature) -> leave for human, in place', async () => {
  const dir = makePipeline();
  held(dir, baseTask('t10', {
    needsClarification: { reason: 'design-decision', openQuestions: 'Should the widget default to on or off? I need you to decide the product behaviour.' },
  }));
  const s = await needsClarificationTriage(args(dir));
  assert.equal(s.leftForHuman, 1);
  const t = read(at(dir, 'needs-clarification', 't10.json'));
  assert.equal(t.ncTriageDecision, 'leave-for-human');
  assert.ok(t.history.some((h) => /genuine design question/.test(h.detail || '')));
});

test('idempotency: already leave-for-human -> skipped', async () => {
  const dir = makePipeline();
  held(dir, baseTask('t11', { ncTriageDecision: 'leave-for-human' }));
  const s = await needsClarificationTriage(args(dir));
  assert.equal(s.checked, 0);
});

// hasFreshEscalationSince / isStillLeaveForHuman (2026-09-18, pipeline hardening --
// confirmed live: two real tasks stayed permanently invisible to every triage sweep
// after a human resolved the question, requeued, redrafted, and re-escalated for an
// unrelated reason, because ncTriageDecision:'leave-for-human' from the FIRST escalation
// was never cleared).
test('hasFreshEscalationSince: false when ncTriageReviewedAt is missing (fail closed, preserves old behavior)', () => {
  assert.equal(hasFreshEscalationSince({ history: [{ stage: 'needs-clarification', at: '2026-09-18T00:00:00Z' }] }), false);
});

test('hasFreshEscalationSince: false when ncTriageReviewedAt is unparseable', () => {
  assert.equal(hasFreshEscalationSince({
    ncTriageReviewedAt: 'not-a-date',
    history: [{ stage: 'needs-clarification', at: '2026-09-18T00:00:00Z' }],
  }), false);
});

test('hasFreshEscalationSince: false when no needs-clarification history event exists at all', () => {
  assert.equal(hasFreshEscalationSince({
    ncTriageReviewedAt: '2026-09-16T13:03:56.000Z',
    history: [{ stage: 'exhausted', at: '2026-09-18T04:05:21.000Z' }],
  }), false);
});

test('hasFreshEscalationSince: false when the only needs-clarification event is AT OR BEFORE ncTriageReviewedAt (the escalation that produced the decision itself)', () => {
  assert.equal(hasFreshEscalationSince({
    ncTriageReviewedAt: '2026-09-16T13:03:56.000Z',
    history: [{ stage: 'needs-clarification', at: '2026-09-16T13:03:40.092Z' }],
  }), false);
});

test('hasFreshEscalationSince: true when a needs-clarification event is STRICTLY AFTER ncTriageReviewedAt', () => {
  assert.equal(hasFreshEscalationSince({
    ncTriageReviewedAt: '2026-09-16T13:03:56.000Z',
    history: [
      { stage: 'needs-clarification', at: '2026-09-16T13:03:40.092Z' }, // the original escalation -- must not count
      { stage: 'needs-clarification-resolved', at: '2026-09-16T23:19:49.232Z' },
      { stage: 'needs-clarification', at: '2026-09-18T04:05:21.408Z' }, // the real re-escalation
    ],
  }), true);
});

test('isStillLeaveForHuman: true for a stamped decision with no fresh re-escalation', () => {
  assert.equal(isStillLeaveForHuman({
    ncTriageDecision: 'leave-for-human',
    ncTriageReviewedAt: '2026-09-16T13:03:56.000Z',
    history: [{ stage: 'needs-clarification', at: '2026-09-16T13:03:40.092Z' }],
  }), true);
});

test('isStillLeaveForHuman: false once a fresh re-escalation has happened since the decision', () => {
  assert.equal(isStillLeaveForHuman({
    ncTriageDecision: 'leave-for-human',
    ncTriageReviewedAt: '2026-09-16T13:03:56.000Z',
    history: [
      { stage: 'needs-clarification', at: '2026-09-16T13:03:40.092Z' },
      { stage: 'needs-clarification', at: '2026-09-18T04:05:21.408Z' },
    ],
  }), false);
});

test('isStillLeaveForHuman: false when the decision was never actually stamped', () => {
  assert.equal(isStillLeaveForHuman({ history: [] }), false);
});

test('a task re-escalated after its stale leave-for-human decision gets a fresh triage pass, not silently skipped', async () => {
  const dir = makePipeline();
  // Mirrors the real live incident: escalated, a human resolved it (stamping
  // ncTriageDecision/ncTriageReviewedAt via bucket C on the FIRST escalation), then
  // requeued/redrafted and re-escalated a SECOND time for a totally unrelated reason
  // (here: the degenerate-draft signature, so it lands in bucket A once re-evaluated).
  held(dir, baseTask('t-reescalated', {
    ncTriageDecision: 'leave-for-human',
    ncTriageReviewedAt: '2026-09-16T13:03:56.000Z',
    needsClarification: { reason: 'design-decision', openQuestions: DEGEN_OQ },
    history: [
      { stage: 'needs-clarification', at: '2026-09-16T13:03:40.092Z' },
      { stage: 'needs-clarification-resolved', at: '2026-09-16T23:19:49.232Z' },
      { stage: 'needs-clarification', at: '2026-09-18T04:05:21.408Z' },
    ],
  }));
  const s = await needsClarificationTriage(args(dir));
  assert.equal(s.checked, 1, 'the re-escalated task must be evaluated, not silently skipped');
  assert.equal(s.requeued, 1);
  assert.ok(exists(at(dir, 'adhoc', 't-reescalated.json')), 'bucket A should have requeued it to adhoc/ once actually evaluated');
});

test('a task with NO fresh re-escalation since its leave-for-human decision stays skipped (checked stays 0)', async () => {
  const dir = makePipeline();
  held(dir, baseTask('t-still-stale', {
    ncTriageDecision: 'leave-for-human',
    ncTriageReviewedAt: '2026-09-16T13:03:56.000Z',
    needsClarification: { reason: 'design-decision', openQuestions: DEGEN_OQ },
    history: [{ stage: 'needs-clarification', at: '2026-09-16T13:03:40.092Z' }],
  }));
  const s = await needsClarificationTriage(args(dir));
  assert.equal(s.checked, 0);
  assert.ok(exists(at(dir, 'needs-clarification', 't-still-stale.json')), 'must stay in needs-clarification, untouched');
});

test('reason ambiguous -> not ours, skipped', async () => {
  const dir = makePipeline();
  held(dir, baseTask('t12', { needsClarification: { reason: 'ambiguous', candidates: {} } }));
  const s = await needsClarificationTriage(args(dir));
  assert.equal(s.checked, 0);
});

test('kill switch AGENT_MANAGER_NC_TRIAGE=false -> zeroed summary, nothing touched', async () => {
  const dir = makePipeline();
  held(dir, baseTask('t13'));
  process.env.AGENT_MANAGER_NC_TRIAGE = 'false';
  try {
    const s = await needsClarificationTriage(args(dir));
    assert.deepEqual(s, { checked: 0, requeued: 0, archived: 0, flagged: 0, leftForHuman: 0, errors: 0 });
    assert.ok(exists(at(dir, 'needs-clarification', 't13.json')));
  } finally { delete process.env.AGENT_MANAGER_NC_TRIAGE; }
});

test('MAX_VOTES cap: 3 invalid-premise tasks, only 2 votes spent', async () => {
  const dir = makePipeline();
  const vote = countingVote('DENY', 'work remains');
  for (const id of ['v1', 'v2', 'v3']) {
    held(dir, baseTask(id, { needsClarification: { reason: 'design-decision', openQuestions: 'has no mapping to anything in this repository' } }));
  }
  process.env.AGENT_MANAGER_NC_TRIAGE_MAX_VOTES = '2';
  try {
    const s = await needsClarificationTriage(args(dir, vote));
    assert.equal(vote.box.calls, 2);
    assert.equal(s.flagged, 3); // 2 voted-then-flagged + 1 flagged without a vote
  } finally { delete process.env.AGENT_MANAGER_NC_TRIAGE_MAX_VOTES; }
});

test('409 race: adhoc/<id>.json already exists -> bucket A task left in place', async () => {
  const dir = makePipeline();
  held(dir, baseTask('t15'));
  fs.writeFileSync(at(dir, 'adhoc', 't15.json'), '{"id":"t15"}');
  const s = await needsClarificationTriage(args(dir));
  assert.equal(s.requeued, 0);
  assert.ok(exists(at(dir, 'needs-clarification', 't15.json')));
});

test('DRY_RUN=1: bucket A reported but file not moved', async () => {
  const dir = makePipeline();
  held(dir, baseTask('t16'));
  process.env.AGENT_MANAGER_NC_TRIAGE_DRY_RUN = '1';
  try {
    const s = await needsClarificationTriage(args(dir));
    assert.equal(s.requeued, 1);
    assert.equal(s.dryRun, true);
    assert.ok(exists(at(dir, 'needs-clarification', 't16.json')));
    assert.ok(!exists(at(dir, 'adhoc', 't16.json')));
  } finally { delete process.env.AGENT_MANAGER_NC_TRIAGE_DRY_RUN; }
});

test('no needs-clarification/ dir -> empty summary, no throw', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-triage-nodir-'));
  const s = await needsClarificationTriage(args(dir));
  assert.equal(s.checked, 0);
});

// --- Bucket D: false completion-claim signature (2026-09-04) -----------------------

const REAL_TEST_COUNT_CLAIM = 'The draft\'s RESOLUTION claims to have "implemented" the task and "verif[ies] the '
  + 'per-process reentrancy fix already present in src/single-flight-lock.js," but the diff only adds a test file '
  + 'and makes zero changes to the actual source files required to implement the fix.';
const REAL_FILE_CLAIM = 'The implement draft claims to have created the file `queue/research/x.json`, but the '
  + 'deterministic fact-check confirms this file does not exist and it is not marked as a create target.';

test('regexes: FALSE_CLAIM_RE matches real corpus blockedReason text, not a plain design question', () => {
  assert.ok(FALSE_CLAIM_RE.test(REAL_TEST_COUNT_CLAIM));
  assert.ok(FALSE_CLAIM_RE.test(REAL_FILE_CLAIM));
  assert.ok(FALSE_CLAIM_RE.test('Agentic implement pass resolved no-changes-needed but no "Already covered:" block at all'));
  assert.ok(!FALSE_CLAIM_RE.test('Should the widget default to on or off? I need you to decide the product behaviour.'));
});

test('bucket D: false completion-claim signature in blockedReason -> clean requeue to adhoc/', async () => {
  const dir = makePipeline();
  held(dir, baseTask('td1', {
    blockedReason: REAL_TEST_COUNT_CLAIM,
    needsClarification: { reason: 'design-decision', openQuestions: 'could not get this past review after 3 attempts' },
    stalenessFlag: { reason: 'retries-exhausted', confidence: 'medium' },
  }));
  const s = await needsClarificationTriage(args(dir));
  assert.deepEqual([s.checked, s.requeued, s.leftForHuman], [1, 1, 0]);
  assert.ok(!exists(at(dir, 'needs-clarification', 'td1.json')));
  const moved = read(at(dir, 'adhoc', 'td1.json'));
  assert.equal(moved.needsClarification, undefined);
  assert.equal(moved.blockedReason, undefined);
  assert.equal(moved.ncTriageBucketAttempts.D, 1);
  assert.ok(moved.history.some((h) => h.stage === 'requeued' && /false completion-claim signature/.test(h.detail)));
  assert.equal(moved.status, 'pending', 'must not still read as blocked after a clean-slate requeue');
});

test('bucket D: previously stamped leave-for-human is NOT frozen against the new signature', async () => {
  const dir = makePipeline();
  held(dir, baseTask('td2', {
    blockedReason: REAL_FILE_CLAIM,
    ncTriageDecision: 'leave-for-human',
    ncTriageReviewedAt: '2026-09-03T00:00:00Z',
  }));
  const s = await needsClarificationTriage(args(dir));
  assert.equal(s.requeued, 1);
  const moved = read(at(dir, 'adhoc', 'td2.json'));
  assert.equal(moved.ncTriageDecision, undefined, 'stale leave-for-human stamp cleared on requeue');
});

test('bucket D: a plain leave-for-human task with no matching signature stays skipped (checked stays 0)', async () => {
  // Regression guard: bucket D must not change the pre-existing idempotency behavior for
  // tasks that don't match its own new signature.
  const dir = makePipeline();
  held(dir, baseTask('td3', { ncTriageDecision: 'leave-for-human' }));
  const s = await needsClarificationTriage(args(dir));
  assert.equal(s.checked, 0);
  assert.equal(s.requeued, 0);
});

test('bucket D: already at MAX_REQUEUES -> falls through to leave-for-human, not re-requeued', async () => {
  const dir = makePipeline();
  // needsClarification override so this fixture matches ONLY bucket D's signature (its
  // default openQuestions is bucket A's own degenerate-draft signature -- with per-bucket
  // counters, bucket D being capped no longer implicitly caps bucket A too).
  held(dir, baseTask('td4', {
    blockedReason: REAL_TEST_COUNT_CLAIM,
    needsClarification: { reason: 'design-decision', openQuestions: REAL_TEST_COUNT_CLAIM },
    ncTriageBucketAttempts: { D: 1 },
  }));
  const s = await needsClarificationTriage(args(dir));
  assert.equal(s.requeued, 0);
  assert.ok(exists(at(dir, 'needs-clarification', 'td4.json')));
});

test('bucket D: adhoc/<id>.json already exists -> left in place, not double-requeued', async () => {
  const dir = makePipeline();
  held(dir, baseTask('td5', { blockedReason: REAL_TEST_COUNT_CLAIM }));
  fs.writeFileSync(at(dir, 'adhoc', 'td5.json'), '{"id":"td5"}');
  const s = await needsClarificationTriage(args(dir));
  assert.equal(s.requeued, 0);
  assert.ok(exists(at(dir, 'needs-clarification', 'td5.json')));
});

test('bucket D: DRY_RUN=1 reports but does not move the file', async () => {
  const dir = makePipeline();
  held(dir, baseTask('td6', { blockedReason: REAL_FILE_CLAIM }));
  process.env.AGENT_MANAGER_NC_TRIAGE_DRY_RUN = '1';
  try {
    const s = await needsClarificationTriage(args(dir));
    assert.equal(s.requeued, 1);
    assert.ok(exists(at(dir, 'needs-clarification', 'td6.json')));
    assert.ok(!exists(at(dir, 'adhoc', 'td6.json')));
  } finally { delete process.env.AGENT_MANAGER_NC_TRIAGE_DRY_RUN; }
});

// --- Bucket E: decompose-loop, not an oversized-file target (2026-09-04) -----------

test('bucket E: decompose-loop + no oversized-file target -> clean requeue to adhoc/', async () => {
  const dir = makePipeline();
  held(dir, baseTask('te1', {
    stalenessFlag: { reason: 'decompose-loop', disposition: 're-scope', confidence: 'medium' },
    decomposeBlockCount: 2,
    history: [{ stage: 'exhausted' }, { stage: 'needs-clarification' }],
  }));
  const s = await needsClarificationTriage(args(dir));
  assert.deepEqual([s.checked, s.requeued, s.leftForHuman], [1, 1, 0]);
  assert.ok(!exists(at(dir, 'needs-clarification', 'te1.json')));
  const moved = read(at(dir, 'adhoc', 'te1.json'));
  assert.equal(moved.stalenessFlag, undefined);
  assert.equal(moved.decomposeBlockCount, undefined);
  assert.equal(moved.needsClarification, undefined);
  assert.equal(moved.ncTriageBucketAttempts.E, 1);
  assert.ok(moved.history.some((h) => h.stage === 'requeued' && /not an oversized file/.test(h.detail)));
  // 2026-09-17: root-caused live -- REQUEUE_STRIP_FIELDS clears blockedReason/
  // blockedStage but never reset task.status, so a clean-slate requeue landed in
  // adhoc/ still reading status:'blocked' with nothing left to explain it.
  assert.equal(moved.status, 'pending', 'must not still read as blocked after a clean-slate requeue');
});

test('bucket E: a real oversized-file target still defers to autoroute, unaffected', async () => {
  const dir = makePipeline();
  fs.writeFileSync(at(dir, 'file-length-flags.json'), JSON.stringify({ findings: [{ file: 'python/dashboard/app.py' }] }));
  held(dir, baseTask('te2', {
    stalenessFlag: { reason: 'decompose-loop' },
    promptContext: { rawText: 'Split python/dashboard/app.py into smaller modules.' },
  }));
  const s = await needsClarificationTriage(args(dir));
  assert.deepEqual([s.checked, s.requeued], [0, 0]);
  assert.ok(exists(at(dir, 'needs-clarification', 'te2.json')));
});

test('bucket E: already at MAX_REQUEUES -> falls through to bucket C, gets a visible leave-for-human stamp', async () => {
  const dir = makePipeline();
  held(dir, baseTask('te3', {
    stalenessFlag: { reason: 'decompose-loop' },
    ncTriageBucketAttempts: { E: 1 },
    history: [{ stage: 'exhausted' }, { stage: 'needs-clarification' }],
  }));
  const s = await needsClarificationTriage(args(dir));
  assert.equal(s.requeued, 0);
  assert.equal(s.leftForHuman, 1);
  const t = read(at(dir, 'needs-clarification', 'te3.json'));
  assert.equal(t.ncTriageDecision, 'leave-for-human');
});

test('bucket E: adhoc/<id>.json already exists -> left in place, not double-requeued', async () => {
  const dir = makePipeline();
  held(dir, baseTask('te4', { stalenessFlag: { reason: 'decompose-loop' } }));
  fs.writeFileSync(at(dir, 'adhoc', 'te4.json'), '{"id":"te4"}');
  const s = await needsClarificationTriage(args(dir));
  assert.equal(s.requeued, 0);
  assert.ok(exists(at(dir, 'needs-clarification', 'te4.json')));
});

test('bucket E: DRY_RUN=1 reports but does not move the file', async () => {
  const dir = makePipeline();
  held(dir, baseTask('te5', { stalenessFlag: { reason: 'decompose-loop' } }));
  process.env.AGENT_MANAGER_NC_TRIAGE_DRY_RUN = '1';
  try {
    const s = await needsClarificationTriage(args(dir));
    assert.equal(s.requeued, 1);
    assert.ok(exists(at(dir, 'needs-clarification', 'te5.json')));
    assert.ok(!exists(at(dir, 'adhoc', 'te5.json')));
  } finally { delete process.env.AGENT_MANAGER_NC_TRIAGE_DRY_RUN; }
});

// Real corpus text, 2026-09-07: adhoc-extract-29-functions-to-analytics-and-discovery-js
// wrote a complete extraction script, ran out of turn/context budget before running it,
// and explicitly disclaimed any design uncertainty -- but sailed past CREATE_TASK_RE into
// bucket C ("genuine design question") because nothing recognized this signature. See the
// header's own comment on bucket F for the full incident.
const REAL_BUDGET_EXHAUSTED_OQ = 'I did not get to finish the change. Here is the exact state so nothing is lost:\n\n'
  + 'Wrote the complete extraction script to the repo root as `_extract_analytics.py`. '
  + 'The only reason this is uncompleted is that I ran out of context budget immediately after writing the script, before running it '
  + '-- not any design uncertainty or missing code. The change is fully specified and the script is already in place.\n\n'
  + 'RESOLUTION: needs-human-decision\n'
  + 'Blocker: ran out of turn/context budget immediately after writing `_extract_analytics.py` to the repo root; the one missing fact is '
  + 'simply that the script has not been executed yet. To finish: run `python3 _extract_analytics.py` in the repo root, `rm _extract_analytics.py`, '
  + 'then run the node --check and grep acceptance checks listed above. No further code changes or decisions are needed.';

test('regexes: BUDGET_EXHAUSTED_RE/COMPLETABLE_NOT_DESIGN_RE match the real corpus text, not a plain design question', () => {
  assert.ok(BUDGET_EXHAUSTED_RE.test(REAL_BUDGET_EXHAUSTED_OQ));
  assert.ok(COMPLETABLE_NOT_DESIGN_RE.test(REAL_BUDGET_EXHAUSTED_OQ));
  assert.ok(!BUDGET_EXHAUSTED_RE.test('Should the widget default to on or off? I need you to decide the product behaviour.'));
  assert.ok(!COMPLETABLE_NOT_DESIGN_RE.test('Should the widget default to on or off? I need you to decide the product behaviour.'));
});

test('bucket F: turn/context budget exhausted, not a design question -> clean requeue to adhoc/', async () => {
  const dir = makePipeline();
  held(dir, baseTask('tf1', {
    needsClarification: { reason: 'design-decision', openQuestions: REAL_BUDGET_EXHAUSTED_OQ },
  }));
  const s = await needsClarificationTriage(args(dir));
  assert.deepEqual([s.checked, s.requeued, s.leftForHuman], [1, 1, 0]);
  assert.ok(!exists(at(dir, 'needs-clarification', 'tf1.json')));
  const moved = read(at(dir, 'adhoc', 'tf1.json'));
  assert.equal(moved.needsClarification, undefined);
  assert.equal(moved.ncTriageBucketAttempts.F, 1);
  assert.equal(moved.promptContext.rawText, bigRawText, 'rawText preserved');
  assert.ok(moved.history.some((h) => h.stage === 'requeued' && /ran out of turn\/context budget mid-mechanical-step/.test(h.detail)));
});

test('bucket F: previously stamped leave-for-human is NOT frozen against the new signature', async () => {
  const dir = makePipeline();
  held(dir, baseTask('tf2', {
    needsClarification: { reason: 'design-decision', openQuestions: REAL_BUDGET_EXHAUSTED_OQ },
    ncTriageDecision: 'leave-for-human',
    ncTriageReviewedAt: '2026-09-03T00:00:00Z',
  }));
  const s = await needsClarificationTriage(args(dir));
  assert.equal(s.requeued, 1);
  const moved = read(at(dir, 'adhoc', 'tf2.json'));
  assert.equal(moved.ncTriageDecision, undefined, 'stale leave-for-human stamp cleared on requeue');
});

test('bucket F skipped: already at MAX_REQUEUES -> falls through to leave-for-human', async () => {
  const dir = makePipeline();
  held(dir, baseTask('tf3', {
    needsClarification: { reason: 'design-decision', openQuestions: REAL_BUDGET_EXHAUSTED_OQ },
    ncTriageBucketAttempts: { F: 1 },
  }));
  const s = await needsClarificationTriage(args(dir));
  assert.equal(s.requeued, 0);
  assert.ok(exists(at(dir, 'needs-clarification', 'tf3.json')));
  assert.equal(read(at(dir, 'needs-clarification', 'tf3.json')).ncTriageDecision, 'leave-for-human');
});

test('bucket F skipped: has an exhausted history event -> bucket C retry-exhausted', async () => {
  const dir = makePipeline();
  held(dir, baseTask('tf4', {
    needsClarification: { reason: 'design-decision', openQuestions: REAL_BUDGET_EXHAUSTED_OQ },
    history: [{ stage: 'exhausted', at: '2026-09-01T00:00:00Z' }],
  }));
  const s = await needsClarificationTriage(args(dir));
  assert.equal(s.requeued, 0);
  assert.ok(exists(at(dir, 'needs-clarification', 'tf4.json')));
});

test('bucket F: adhoc/<id>.json already exists -> left in place, not double-requeued', async () => {
  const dir = makePipeline();
  held(dir, baseTask('tf5', {
    needsClarification: { reason: 'design-decision', openQuestions: REAL_BUDGET_EXHAUSTED_OQ },
  }));
  fs.writeFileSync(at(dir, 'adhoc', 'tf5.json'), '{"id":"tf5"}');
  const s = await needsClarificationTriage(args(dir));
  assert.equal(s.requeued, 0);
  assert.ok(exists(at(dir, 'needs-clarification', 'tf5.json')));
});

test('bucket F: DRY_RUN=1 reports but does not move the file', async () => {
  const dir = makePipeline();
  held(dir, baseTask('tf6', {
    needsClarification: { reason: 'design-decision', openQuestions: REAL_BUDGET_EXHAUSTED_OQ },
  }));
  process.env.AGENT_MANAGER_NC_TRIAGE_DRY_RUN = '1';
  try {
    const s = await needsClarificationTriage(args(dir));
    assert.equal(s.requeued, 1);
    assert.ok(exists(at(dir, 'needs-clarification', 'tf6.json')));
    assert.ok(!exists(at(dir, 'adhoc', 'tf6.json')));
  } finally { delete process.env.AGENT_MANAGER_NC_TRIAGE_DRY_RUN; }
});

// --- BLOCKER-TYPE tag (2026-09-08) -- see the header's own comment on
// BLOCKER_TYPE_BUDGET_EXHAUSTED_RE for the real incident: a second real corpus response
// worded "not a design question -- a pass-budget overrun" / "no tool budget left" matched
// COMPLETABLE_NOT_DESIGN_RE but NOT BUDGET_EXHAUSTED_RE, and fell through to bucket C.
// local-agentic-write-draft.js's prompt now requires an explicit BLOCKER-TYPE line;
// this bucket now recognizes it directly, bypassing the phrase-pair heuristic entirely.

const REAL_BLOCKER_TYPE_OQ = 'I was unable to complete this pass. I oriented fully and built a correct extraction plan, '
  + 'but I have no tool budget left to write the file or delete the functions from the template. No files were created or modified.\n\n'
  + 'RESOLUTION: needs-human-decision\n'
  + 'BLOCKER-TYPE: budget-exhausted\n'
  + 'Open blocker (not a design question -- a pass-budget overrun): the extraction approach is sound; what is missing is the remaining '
  + 'turns to execute the writes and validate. A fresh pass starting from the already-computed line map should complete it.';

test('regexes: BLOCKER_TYPE_BUDGET_EXHAUSTED_RE matches the explicit tag even when the old phrase-pair would not', () => {
  assert.ok(BLOCKER_TYPE_BUDGET_EXHAUSTED_RE.test(REAL_BLOCKER_TYPE_OQ));
  assert.ok(!BUDGET_EXHAUSTED_RE.test(REAL_BLOCKER_TYPE_OQ), 'confirms the old regex genuinely misses this real corpus wording ("no tool budget left", not "ran out of turn/context budget")');
});

test('bucket F: BLOCKER-TYPE: budget-exhausted alone triggers the requeue, without needing the phrase-pair to also match', async () => {
  const dir = makePipeline();
  held(dir, baseTask('tf7', {
    needsClarification: { reason: 'design-decision', openQuestions: REAL_BLOCKER_TYPE_OQ },
  }));
  const s = await needsClarificationTriage(args(dir));
  assert.deepEqual([s.checked, s.requeued, s.leftForHuman], [1, 1, 0]);
  assert.ok(!exists(at(dir, 'needs-clarification', 'tf7.json')));
  const moved = read(at(dir, 'adhoc', 'tf7.json'));
  assert.equal(moved.ncTriageBucketAttempts.F, 1);
  assert.ok(moved.history.some((h) => h.stage === 'requeued' && /ran out of turn\/context budget mid-mechanical-step/.test(h.detail)));
});

test('bucket F: BLOCKER-TYPE: design-question is NOT treated as budget-exhausted', async () => {
  const dir = makePipeline();
  const designOq = 'RESOLUTION: needs-human-decision\nBLOCKER-TYPE: design-question\nShould the license gate call Stripe live, or stub it?';
  held(dir, baseTask('tf8', {
    needsClarification: { reason: 'design-decision', openQuestions: designOq },
  }));
  const s = await needsClarificationTriage(args(dir));
  assert.equal(s.requeued, 0);
  assert.ok(exists(at(dir, 'needs-clarification', 'tf8.json')));
  assert.equal(read(at(dir, 'needs-clarification', 'tf8.json')).ncTriageDecision, 'leave-for-human');
});

// --- Bucket G: BLOCKER-TYPE: infra-error (backstop; resolveAgenticDraft normally
// catches this upstream) ---------------------------------------------------------------
const INFRA_ERROR_OQ = 'RESOLUTION: needs-human-decision\nBLOCKER-TYPE: infra-error\n'
  + 'Every `node --check` invocation exits with ETIMEDOUT and edit_file reports "unable to create .git/index.lock". '
  + 'This is a tool/environment failure, not a design question -- a fresh pass should be able to proceed.';

test('regex: BLOCKER_TYPE_INFRA_ERROR_RE matches the explicit tag and not a design question', () => {
  assert.ok(BLOCKER_TYPE_INFRA_ERROR_RE.test(INFRA_ERROR_OQ));
  assert.ok(!BLOCKER_TYPE_INFRA_ERROR_RE.test('RESOLUTION: needs-human-decision\nBLOCKER-TYPE: design-question\nWhich store?'));
});

test('bucket G: BLOCKER-TYPE: infra-error -> clean requeue to adhoc/', async () => {
  const dir = makePipeline();
  held(dir, baseTask('tg1', {
    needsClarification: { reason: 'design-decision', openQuestions: INFRA_ERROR_OQ },
  }));
  const s = await needsClarificationTriage(args(dir));
  assert.deepEqual([s.checked, s.requeued, s.leftForHuman], [1, 1, 0]);
  assert.ok(!exists(at(dir, 'needs-clarification', 'tg1.json')));
  const moved = read(at(dir, 'adhoc', 'tg1.json'));
  assert.equal(moved.needsClarification, undefined);
  assert.equal(moved.ncTriageBucketAttempts.G, 1);
  assert.ok(moved.history.some((h) => h.stage === 'requeued' && /BLOCKER-TYPE: infra-error/.test(h.detail)));
});

test('bucket G skipped: an exhausted history event -> not requeued', async () => {
  const dir = makePipeline();
  held(dir, baseTask('tg2', {
    needsClarification: { reason: 'design-decision', openQuestions: INFRA_ERROR_OQ },
    history: [{ stage: 'exhausted', at: '2026-09-03T00:00:00Z', detail: '2/2 retries used' }],
  }));
  const s = await needsClarificationTriage(args(dir));
  assert.equal(s.requeued, 0);
  assert.ok(exists(at(dir, 'needs-clarification', 'tg2.json')));
});

// --- Bucket M: forced-summary turn ignored RESOLUTION: (2026-09-18) -------------------

test('bucket M: forcedSummaryNonCompliant -> clean requeue to adhoc/', async () => {
  const dir = makePipeline();
  held(dir, baseTask('tm1', {
    forcedSummaryNonCompliant: true,
    needsClarification: { reason: 'design-decision', openQuestions: 'some prior narration, no RESOLUTION: line' },
  }));
  const s = await needsClarificationTriage(args(dir));
  assert.deepEqual([s.checked, s.requeued, s.leftForHuman], [1, 1, 0]);
  assert.ok(!exists(at(dir, 'needs-clarification', 'tm1.json')));
  const moved = read(at(dir, 'adhoc', 'tm1.json'));
  assert.equal(moved.needsClarification, undefined);
  assert.equal(moved.forcedSummaryNonCompliant, undefined, 'the stale flag must not survive into the fresh attempt');
  assert.equal(moved.ncTriageBucketAttempts.M, 1);
  assert.ok(moved.history.some((h) => h.stage === 'requeued' && /forced-summary turn ignored the RESOLUTION:/.test(h.detail)));
});

test('bucket M skipped: an exhausted history event -> not requeued', async () => {
  const dir = makePipeline();
  held(dir, baseTask('tm2', {
    forcedSummaryNonCompliant: true,
    history: [{ stage: 'exhausted', at: '2026-09-03T00:00:00Z', detail: '2/2 retries used' }],
  }));
  const s = await needsClarificationTriage(args(dir));
  assert.equal(s.requeued, 0);
  assert.ok(exists(at(dir, 'needs-clarification', 'tm2.json')));
});

test('bucket M skipped: forcedSummaryNonCompliant not set -> leave for human as before', async () => {
  const dir = makePipeline();
  held(dir, baseTask('tm3', {
    needsClarification: { reason: 'design-decision', openQuestions: 'a genuine, real design question about scope' },
  }));
  const s = await needsClarificationTriage(args(dir));
  assert.equal(s.requeued, 0);
  assert.ok(exists(at(dir, 'needs-clarification', 'tm3.json')));
});

test('bucket M: adhoc/<id>.json already exists -> left in place, not double-requeued', async () => {
  const dir = makePipeline();
  held(dir, baseTask('tm4', { forcedSummaryNonCompliant: true }));
  fs.writeFileSync(at(dir, 'adhoc', 'tm4.json'), JSON.stringify({ id: 'tm4' }));
  const s = await needsClarificationTriage(args(dir));
  assert.equal(s.requeued, 0);
  assert.ok(exists(at(dir, 'needs-clarification', 'tm4.json')));
});

// --- Bucket J: deterministic-truncation-guard false-block signature (2026-09-16) -------

test('bucket J: reviewProvider === deterministic-truncation-guard -> clean requeue to adhoc/', async () => {
  const dir = makePipeline();
  held(dir, baseTask('tj1', {
    reviewProvider: 'deterministic-truncation-guard',
    blockedReason: 'truncated output',
    needsClarification: { reason: 'design-decision', openQuestions: 'could not get this past review after 2 attempts' },
    history: [{ stage: 'exhausted', at: '2026-09-16T00:00:00Z' }],
  }));
  const s = await needsClarificationTriage(args(dir));
  assert.deepEqual([s.checked, s.requeued, s.leftForHuman], [1, 1, 0]);
  assert.ok(!exists(at(dir, 'needs-clarification', 'tj1.json')));
  const moved = read(at(dir, 'adhoc', 'tj1.json'));
  assert.equal(moved.needsClarification, undefined);
  assert.equal(moved.blockedReason, undefined);
  assert.equal(moved.reviewProvider, undefined);
  assert.equal(moved.ncTriageBucketAttempts.J, 1);
  assert.ok(moved.history.some((h) => h.stage === 'requeued' && /deterministic-truncation-guard false-block signature/.test(h.detail)));
});

test('bucket J: previously stamped leave-for-human is NOT frozen against the signature', async () => {
  const dir = makePipeline();
  held(dir, baseTask('tj2', {
    reviewProvider: 'deterministic-truncation-guard',
    blockedReason: 'truncated output',
    ncTriageDecision: 'leave-for-human',
    ncTriageReviewedAt: '2026-09-15T00:00:00Z',
  }));
  const s = await needsClarificationTriage(args(dir));
  assert.equal(s.requeued, 1);
  const moved = read(at(dir, 'adhoc', 'tj2.json'));
  assert.equal(moved.ncTriageDecision, undefined, 'stale leave-for-human stamp cleared on requeue');
});

test('bucket J: a task with no matching reviewProvider stays skipped (checked stays 0)', async () => {
  const dir = makePipeline();
  held(dir, baseTask('tj3', { ncTriageDecision: 'leave-for-human' }));
  const s = await needsClarificationTriage(args(dir));
  assert.equal(s.checked, 0);
  assert.equal(s.requeued, 0);
});

test('bucket J: a genuinely blocked task (real content rejection, not the truncation gate) is untouched', async () => {
  const dir = makePipeline();
  held(dir, baseTask('tj4', {
    reviewProvider: 'majority-vote',
    blockedReason: 'the draft never implements the requested helper',
    needsClarification: { reason: 'design-decision', openQuestions: 'Should the widget default to on or off? I need you to decide the product behaviour.' },
  }));
  const s = await needsClarificationTriage(args(dir));
  assert.equal(s.requeued, 0);
  assert.ok(exists(at(dir, 'needs-clarification', 'tj4.json')));
});

test('bucket J: already at MAX_REQUEUES -> falls through to leave-for-human, not re-requeued', async () => {
  const dir = makePipeline();
  // needsClarification override -- same reasoning as bucket D's own MAX_REQUEUES test above.
  held(dir, baseTask('tj5', {
    reviewProvider: 'deterministic-truncation-guard',
    needsClarification: { reason: 'design-decision', openQuestions: 'This is unrelated to any known signature.' },
    ncTriageBucketAttempts: { J: 1 },
  }));
  const s = await needsClarificationTriage(args(dir));
  assert.equal(s.requeued, 0);
  assert.ok(exists(at(dir, 'needs-clarification', 'tj5.json')));
});

// --- Bucket K: decompose-review-blind signature (2026-09-16) ---------------------------

const REAL_SUB_TASKS = [
  { title: 'Add the allowlist constant', rawText: 'In src/foo.js, add ALLOWLIST = [...].' },
  { title: 'Wire the allowlist into the check', rawText: 'In src/bar.js, reference ALLOWLIST.' },
];

test('bucket K: decompose-review-blind signature -> implementResponse regenerated, sent to queue/review/', async () => {
  const dir = makePipeline();
  fs.mkdirSync(at(dir, 'review'), { recursive: true });
  held(dir, baseTask('tk1', {
    adhocResolution: 'decompose',
    subTaskProposals: REAL_SUB_TASKS,
    implementResponse: 'Auto-decomposed after two implement passes that both chose RESOLUTION: decompose without usable pieces (2 pieces).\n\nAgentic implement pass said RESOLUTION: decompose but no valid JSON array of {title, rawText} sub-tasks followed it',
    needsClarification: { reason: 'design-decision', openQuestions: 'The IMPLEMENT draft contains no actual sub-task JSON array...' },
    blockedReason: 'The IMPLEMENT draft is a degenerate meta-commentary...',
  }));
  const s = await needsClarificationTriage(args(dir));
  assert.deepEqual([s.checked, s.requeued, s.leftForHuman], [1, 1, 0]);
  assert.ok(!exists(at(dir, 'needs-clarification', 'tk1.json')));
  const moved = read(at(dir, 'review', 'tk1.json'));
  assert.equal(moved.status, 'needs-review');
  assert.equal(moved.needsClarification, undefined);
  assert.equal(moved.blockedReason, undefined);
  assert.equal(moved.ncTriageBucketAttempts.K, 1);
  // The real sub-tasks are now genuinely present in implementResponse.
  assert.match(moved.implementResponse, /Add the allowlist constant/);
  assert.match(moved.implementResponse, /Wire the allowlist into the check/);
  // The real, valid decomposition itself is untouched -- this bucket repairs, never redrafts.
  assert.deepEqual(moved.subTaskProposals, REAL_SUB_TASKS);
  assert.equal(moved.adhocResolution, 'decompose');
  assert.ok(moved.history.some((h) => h.stage === 'requeued' && /decompose-review-blind signature/.test(h.detail)));
});

// 2026-09-16, same-day positioning fix: root-caused live via this exact task shape --
// EVERY real bucket K target also carries stalenessFlag.reason === 'decompose-loop', and
// often targets a real oversized file (the give-up backstop's own repeated-decompose
// history is what stamps decompose-loop in the first place). Bucket K originally sat
// AFTER the decompose-loop/oversized-file deferral a few lines below ("autoroute owns
// it"), which silently `continue`s any such task away with no log line -- meaning this
// bucket never actually fired for a single one of its intended targets until moved
// ahead of that deferral. This test reproduces the real shape end-to-end: a
// decompose-loop-flagged task whose rawText names a file file-length-flags.json also
// flags as oversized.
test('bucket K: still fires even when the task is ALSO decompose-loop-flagged with an oversized target file (the real incident shape)', async () => {
  const dir = makePipeline();
  fs.mkdirSync(at(dir, 'review'), { recursive: true });
  fs.writeFileSync(at(dir, 'file-length-flags.json'), JSON.stringify({ findings: [{ file: 'src/local-draft.js' }] }));
  held(dir, baseTask('tk6', {
    promptContext: { rawText: 'In src/local-draft.js, add a short-circuit for critique-degenerate.' },
    adhocResolution: 'decompose',
    subTaskProposals: REAL_SUB_TASKS,
    implementResponse: 'Auto-decomposed after two implement passes that both chose RESOLUTION: decompose without usable pieces (2 pieces).',
    stalenessFlag: { reason: 'decompose-loop', disposition: 're-scope', confidence: 'medium' },
    needsClarification: { reason: 'design-decision', openQuestions: 'The IMPLEMENT draft contains no actual sub-task JSON array...' },
  }));
  const s = await needsClarificationTriage(args(dir));
  assert.deepEqual([s.checked, s.requeued, s.leftForHuman], [1, 1, 0]);
  assert.ok(!exists(at(dir, 'needs-clarification', 'tk6.json')));
  const moved = read(at(dir, 'review', 'tk6.json'));
  assert.equal(moved.status, 'needs-review');
  assert.match(moved.implementResponse, /Add the allowlist constant/);
});

// 2026-09-16, positioning fix 2 (same day as fix 1): root-caused live running the sweep
// for real -- 2 remaining un-recovered targets carry needsClarification.reason ===
// 'infra-error' (a later, unrelated retry's failure masking an earlier attempt's still-
// valid decomposition), which the reason allowlist below excludes before this bucket
// ever runs, unless this bucket is checked ahead of it too.
test('bucket K: still fires when needsClarification.reason is NOT design-decision (e.g. a later infra-error masks an earlier valid decompose)', async () => {
  const dir = makePipeline();
  fs.mkdirSync(at(dir, 'review'), { recursive: true });
  held(dir, baseTask('tk7', {
    adhocResolution: 'decompose',
    subTaskProposals: REAL_SUB_TASKS,
    implementResponse: 'Auto-decomposed after two implement passes that both chose RESOLUTION: decompose without usable pieces (2 pieces).',
    needsClarification: { reason: 'infra-error', openQuestions: 'Agentic implement pass tagged BLOCKER-TYPE: infra-error -- requeued for a clean retry' },
  }));
  const s = await needsClarificationTriage(args(dir));
  assert.deepEqual([s.checked, s.requeued, s.leftForHuman], [1, 1, 0]);
  assert.ok(!exists(at(dir, 'needs-clarification', 'tk7.json')));
  const moved = read(at(dir, 'review', 'tk7.json'));
  assert.equal(moved.status, 'needs-review');
  assert.match(moved.implementResponse, /Add the allowlist constant/);
});

test('bucket K: a decompose task whose implementResponse ALREADY shows the real sub-tasks is left alone', async () => {
  const dir = makePipeline();
  held(dir, baseTask('tk2', {
    adhocResolution: 'decompose',
    subTaskProposals: REAL_SUB_TASKS,
    implementResponse: `Decomposed into 2 sub-task(s).\n\n1. ${REAL_SUB_TASKS[0].title}\n   ${REAL_SUB_TASKS[0].rawText}\n2. ${REAL_SUB_TASKS[1].title}\n   ${REAL_SUB_TASKS[1].rawText}`,
    needsClarification: { reason: 'design-decision', openQuestions: 'Should the widget default to on or off? I need you to decide the product behaviour.' },
  }));
  const s = await needsClarificationTriage(args(dir));
  assert.equal(s.requeued, 0);
  assert.ok(exists(at(dir, 'needs-clarification', 'tk2.json')));
});

test('bucket K: a task with fewer than 2 sub-tasks is left alone (not a real decomposition)', async () => {
  const dir = makePipeline();
  held(dir, baseTask('tk3', {
    adhocResolution: 'decompose',
    subTaskProposals: [REAL_SUB_TASKS[0]],
    implementResponse: 'Auto-decomposed after a turn-budget-exhausted implement pass (1 pieces).',
    needsClarification: { reason: 'design-decision', openQuestions: 'Should the widget default to on or off? I need you to decide the product behaviour.' },
  }));
  const s = await needsClarificationTriage(args(dir));
  assert.equal(s.requeued, 0);
  assert.ok(exists(at(dir, 'needs-clarification', 'tk3.json')));
});

test('bucket K: a genuinely non-decompose task is left alone', async () => {
  const dir = makePipeline();
  held(dir, baseTask('tk4', {
    needsClarification: { reason: 'design-decision', openQuestions: 'Should the widget default to on or off? I need you to decide the product behaviour.' },
  }));
  const s = await needsClarificationTriage(args(dir));
  assert.equal(s.requeued, 0);
  assert.ok(exists(at(dir, 'needs-clarification', 'tk4.json')));
});

test('bucket K: already at MAX_REQUEUES -> falls through to leave-for-human, not re-repaired', async () => {
  const dir = makePipeline();
  // needsClarification override -- same reasoning as bucket D's own MAX_REQUEUES test above.
  held(dir, baseTask('tk5', {
    adhocResolution: 'decompose',
    subTaskProposals: REAL_SUB_TASKS,
    implementResponse: 'Auto-decomposed after two implement passes (2 pieces).',
    needsClarification: { reason: 'design-decision', openQuestions: 'This is unrelated to any known signature.' },
    ncTriageBucketAttempts: { K: 1 },
  }));
  const s = await needsClarificationTriage(args(dir));
  assert.equal(s.requeued, 0);
  assert.ok(exists(at(dir, 'needs-clarification', 'tk5.json')));
});

// 2026-09-16, pipeline hardening (the actual bug this whole per-bucket refactor fixes):
// a task that already burned its ONE shot on an EARLIER, unrelated bucket (D here, standing
// in for whichever generic bucket got there first in production) must not be locked out of
// a LATER bucket whose own, completely different signature it separately matches. Before
// this fix, every bucket shared one flat task.ncTriageAttempts counter, so Bucket K --
// built specifically to rescue tasks with a valid decomposition sitting unused -- could
// never fire on a task some other bucket had already touched once.
test('bucket D being exhausted does NOT block bucket K from firing on the same task (buckets are independent budgets)', async () => {
  const dir = makePipeline();
  fs.mkdirSync(at(dir, 'review'), { recursive: true });
  held(dir, baseTask('tdk1', {
    adhocResolution: 'decompose',
    subTaskProposals: REAL_SUB_TASKS,
    implementResponse: 'Auto-decomposed after two implement passes that both chose RESOLUTION: decompose without usable pieces (2 pieces).\n\nAgentic implement pass said RESOLUTION: decompose but no valid JSON array of {title, rawText} sub-tasks followed it',
    needsClarification: { reason: 'design-decision', openQuestions: 'The IMPLEMENT draft contains no actual sub-task JSON array...' },
    blockedReason: 'The IMPLEMENT draft is a degenerate meta-commentary...',
    // Bucket D's own budget is already spent -- simulates a task an earlier, unrelated
    // requeue bucket already touched once, exactly the production incident this closes.
    ncTriageBucketAttempts: { D: 1 },
  }));
  const s = await needsClarificationTriage(args(dir));
  assert.deepEqual([s.checked, s.requeued, s.leftForHuman], [1, 1, 0]);
  const moved = read(at(dir, 'review', 'tdk1.json'));
  assert.equal(moved.status, 'needs-review');
  assert.equal(moved.ncTriageBucketAttempts.K, 1, 'bucket K got its OWN fresh attempt, unaffected by D already being at its cap');
  assert.equal(moved.ncTriageBucketAttempts.D, 1, 'bucket D\'s own prior count is preserved, not reset by K firing');
  assert.match(moved.implementResponse, /Add the allowlist constant/);
});

// --- Ghost-in-the-Machine: bucket C retry-exhausted -> ghost debt (2026-09-09) ---------

const sfInbox = (dir) => {
  try {
    return fs.readdirSync(at(dir, 'side-findings-inbox'))
      .map((f) => JSON.parse(fs.readFileSync(at(dir, 'side-findings-inbox', f), 'utf8')));
  } catch { return []; }
};

test('bucket C retry-exhausted files a ghost-debt side-finding tagged to the concept', async () => {
  const dir = makePipeline();
  held(dir, baseTask('gd-exh', {
    needsClarification: { reason: 'design-decision', openQuestions: 'The automated handler could not get this past review after 3 attempts: never produced a real diff.' },
    blockedReason: 'never produced a real diff',
    history: [{ stage: 'exhausted', at: '2026-09-01T00:00:00Z' }, { stage: 'needs-clarification', at: '2026-09-01T00:01:00Z' }],
  }));
  const s = await needsClarificationTriage(args(dir));
  assert.equal(s.leftForHuman, 1);
  assert.equal(read(at(dir, 'needs-clarification', 'gd-exh.json')).ncTriageDecision, 'leave-for-human');
  const debt = sfInbox(dir).find((r) => r.stage === 'ghost-debt' && r.taskId === 'gd-exh');
  assert.ok(debt, 'ghost-debt side-finding filed for the retry-exhausted leave-for-human');
  assert.equal(debt.conceptId, 'concept-ghost-in-the-machine-0dbeea');
});

test('bucket C genuine design question does NOT file ghost debt (legitimate human call, not a missing mechanism)', async () => {
  const dir = makePipeline();
  held(dir, baseTask('gd-genuine', {
    needsClarification: { reason: 'design-decision', openQuestions: 'Should the export be CSV or Parquet? This is a real product decision.' },
    history: [{ stage: 'implement-done', at: '2026-09-01T00:00:00Z' }],
  }));
  const s = await needsClarificationTriage(args(dir));
  assert.equal(s.leftForHuman, 1);
  assert.equal(sfInbox(dir).filter((r) => r.stage === 'ghost-debt').length, 0);
});

// --- Bucket H: deterministically-classified invalid-premise (2026-09-11) -----------

function invalidPremiseTask(id, over = {}) {
  return baseTask(id, {
    needsClarification: {
      reason: 'invalid-premise',
      openQuestions: 'Classified as invalid-premise (environment-side), which a blind retry cannot fix -- needs a human decision.',
    },
    blockedReason: 'Invalid premise: the real content in `src/foo.js` does not contain a `plan-done` event.',
    history: [{ stage: 'needs-clarification', at: '2026-09-09T00:00:00Z' }],
    ...over,
  });
}

test('bucket H: reason=invalid-premise used to be silently skipped by the design-decision gate -- now it is checked', async () => {
  const dir = makePipeline();
  held(dir, invalidPremiseTask('h1'));
  const s = await needsClarificationTriage(args(dir, voteOf('DENY', 'still real work here')));
  assert.equal(s.checked, 1, 'no longer skipped as "not ours"');
});

test('bucket H: a confident CONFIRM vote archives it', async () => {
  const dir = makePipeline();
  held(dir, invalidPremiseTask('h2'));
  const s = await needsClarificationTriage(args(dir, voteOf('CONFIRM', 'premise genuinely false, nothing to build')));
  assert.equal(s.archived, 1);
  assert.ok(!exists(at(dir, 'needs-clarification', 'h2.json')));
  const archived = read(at(dir, 'done', '_archived_no_action', 'h2.json'));
  assert.equal(archived.status, 'done');
  assert.ok(archived.history.some((h) => h.stage === 'archived' && /invalid-premise/.test(h.detail)));
});

test('bucket H: a possibly-resolved signal archives without needing a vote', async () => {
  const dir = makePipeline();
  held(dir, invalidPremiseTask('h3', {
    promptContext: { rawText: bigRawText, reasons: ['possibly-resolved'] },
  }));
  const s = await needsClarificationTriage(args(dir)); // no majorityVote wired -- must not be needed
  assert.equal(s.archived, 1);
});

test('bucket H: no resolution signal + DENY/inconclusive vote -> flagged and left, not silently dropped', async () => {
  const dir = makePipeline();
  held(dir, invalidPremiseTask('h4'));
  const s = await needsClarificationTriage(args(dir, voteOf('DENY', 'the premise still holds, real work remains')));
  assert.equal(s.flagged, 1);
  const t = read(at(dir, 'needs-clarification', 'h4.json'));
  assert.equal(t.ncTriageDecision, 'leave-for-human');
  assert.equal(t.stalenessFlag.reason, 'nc-triage-invalid-premise');
});

test('bucket H: idempotent -- a second sweep does not re-check an already-flagged task', async () => {
  const dir = makePipeline();
  held(dir, invalidPremiseTask('h5'));
  const vote = countingVote('DENY', 'still real work');
  await needsClarificationTriage(args(dir, vote));
  await needsClarificationTriage(args(dir, vote));
  assert.equal(vote.box.calls, 1, 'second sweep skips the already-reviewed task entirely');
});

test('bucket H: DRY_RUN=1 reports but does not move or write anything', async () => {
  process.env.AGENT_MANAGER_NC_TRIAGE_DRY_RUN = '1';
  try {
    const dir = makePipeline();
    held(dir, invalidPremiseTask('h6'));
    const before = read(at(dir, 'needs-clarification', 'h6.json'));
    const s = await needsClarificationTriage(args(dir, voteOf('CONFIRM', 'yep')));
    assert.equal(s.archived, 1);
    assert.deepEqual(read(at(dir, 'needs-clarification', 'h6.json')), before, 'file untouched');
  } finally {
    delete process.env.AGENT_MANAGER_NC_TRIAGE_DRY_RUN;
  }
});

// --- Bucket I: deterministically-classified unreliable-grounding (2026-09-11) ------

function unreliableGroundingTask(id, over = {}) {
  return baseTask(id, {
    needsClarification: {
      reason: 'unreliable-grounding',
      openQuestions: 'The grounding for src/bar.js could not be reliably anchored (confidence: none) -- a blind retry re-derives the same search against the same file.',
    },
    blockedReason: 'unreliable grounding: src/bar.js anchor confidence none',
    history: [{ stage: 'needs-clarification', at: '2026-09-09T00:00:00Z' }],
    ...over,
  });
}

test('bucket I: reason=unreliable-grounding used to be silently skipped -- now files ghost debt and leaves it visible', async () => {
  const dir = makePipeline();
  held(dir, unreliableGroundingTask('i1'));
  const s = await needsClarificationTriage(args(dir));
  assert.equal(s.checked, 1);
  assert.equal(s.leftForHuman, 1);
  const t = read(at(dir, 'needs-clarification', 'i1.json'));
  assert.equal(t.ncTriageDecision, 'leave-for-human');
  const debt = sfInbox(dir).find((r) => r.stage === 'ghost-debt' && r.taskId === 'i1');
  assert.ok(debt, 'ghost-debt filed -- no automated recovery for a harness-side anchor failure');
});

test('bucket I: never requeued -- a blind retry would reproduce the identical anchor failure', async () => {
  const dir = makePipeline();
  held(dir, unreliableGroundingTask('i2'));
  const s = await needsClarificationTriage(args(dir));
  assert.equal(s.requeued, 0);
  assert.ok(exists(at(dir, 'needs-clarification', 'i2.json')), 'stays in needs-clarification/, not moved to adhoc/');
});

test('bucket I: idempotent -- a second sweep does not re-file ghost debt or re-append history', async () => {
  const dir = makePipeline();
  held(dir, unreliableGroundingTask('i3'));
  await needsClarificationTriage(args(dir));
  const afterFirst = read(at(dir, 'needs-clarification', 'i3.json'));
  const s2 = await needsClarificationTriage(args(dir));
  assert.equal(s2.checked, 0, 'already-reviewed task skipped on the next tick');
  assert.deepEqual(read(at(dir, 'needs-clarification', 'i3.json')), afterFirst);
});

test('bucket I: DRY_RUN=1 reports but does not write or file ghost debt', async () => {
  process.env.AGENT_MANAGER_NC_TRIAGE_DRY_RUN = '1';
  try {
    const dir = makePipeline();
    held(dir, unreliableGroundingTask('i4'));
    const before = read(at(dir, 'needs-clarification', 'i4.json'));
    const s = await needsClarificationTriage(args(dir));
    assert.equal(s.leftForHuman, 1);
    assert.deepEqual(read(at(dir, 'needs-clarification', 'i4.json')), before);
    assert.equal(sfInbox(dir).length, 0);
  } finally {
    delete process.env.AGENT_MANAGER_NC_TRIAGE_DRY_RUN;
  }
});

test('ambiguous reason is still skipped (out of scope for this fix)', async () => {
  const dir = makePipeline();
  held(dir, baseTask('amb1', {
    needsClarification: { reason: 'ambiguous', openQuestions: 'Which of these 3 candidates did you mean?' },
  }));
  const s = await needsClarificationTriage(args(dir));
  assert.deepEqual([s.checked, s.archived, s.leftForHuman], [0, 0, 0]);
  assert.ok(exists(at(dir, 'needs-clarification', 'amb1.json')), 'left completely untouched, same as before');
});

// --- Bucket L: fabricated-file-path near-miss auto-repair (2026-09-16) -----------------
// Real incident shape: arch-discovery-community-15 ("scripts" community). The model was
// handed 3 real files verbatim (all sharing the "candidates-doc-merge" stem) and cited
// `merge-candidates.js` -- a token-shuffle of the first, not a wholesale invention.

const ARCH_DISCOVERY_REAL_FILES = [
  { path: 'src/candidates-doc-merge.js', degree: 2, content: '// real file' },
  { path: 'scripts/candidates-doc-merge-driver.js', degree: 1, content: '// real file' },
  { path: 'src/candidates-doc-merge.test.js', degree: 1, content: '// real file' },
];

// Bucket L is gated by the source's `groundedPromptFiles` registration flag (arch_discovery sets it in the hygiene plugin);
// core names no plugin source (ADR-0022), so the tests register a stand-in the same way.
{
  const { registerTaskSource, getRegisteredSource } = require('./task-source-registry.js');
  if (!getRegisteredSource('arch_discovery')) registerTaskSource('arch_discovery', { priority: 80, next: () => null, groundedPromptFiles: true });
}

function archDiscoveryTask(id, over = {}) {
  return baseTask(id, {
    source: 'arch_discovery',
    promptContext: { communityId: 15, communityName: 'scripts', files: ARCH_DISCOVERY_REAL_FILES },
    blockedReason: 'Ungrounded draft: fabricated file path(s): merge-candidates.js -- not present anywhere in the target repo. A redraft cannot make an invented path real; re-file with an accurate citation, or archive if nothing applies.',
    needsClarification: { reason: 'fabricated-file-path', openQuestions: 'This candidate cited a destination file path that does not exist.' },
    implementResponse: 'Problem: candidate merge logic duplicated.\n\nFiles: merge-candidates.js\n\nSolution: consolidate in merge-candidates.js.',
    ...over,
  });
}

test('bucket L: fabricated path with a unique near-miss real match -> repaired in place, sent to review', async () => {
  const dir = makePipeline();
  fs.mkdirSync(at(dir, 'review'), { recursive: true });
  held(dir, archDiscoveryTask('l1'));
  const s = await needsClarificationTriage(args(dir));
  assert.deepEqual([s.checked, s.requeued, s.leftForHuman], [1, 1, 0]);
  assert.ok(!exists(at(dir, 'needs-clarification', 'l1.json')));
  const moved = read(at(dir, 'review', 'l1.json'));
  assert.equal(moved.status, 'needs-review');
  assert.equal(moved.needsClarification, undefined);
  assert.equal(moved.blockedReason, undefined);
  assert.equal(moved.ncTriageBucketAttempts.L, 1);
  assert.match(moved.implementResponse, /Files: src\/candidates-doc-merge\.js/);
  assert.doesNotMatch(moved.implementResponse, /merge-candidates\.js/);
  assert.ok(moved.history.some((h) => h.stage === 'requeued' && /fabricated-file-path near-miss/.test(h.detail)));
});

test('bucket L: only a source registering groundedPromptFiles is eligible -- any other task with the same signature is left for a human', async () => {
  const dir = makePipeline();
  held(dir, archDiscoveryTask('l2', { source: 'manual' }));
  const s = await needsClarificationTriage(args(dir));
  assert.equal(s.requeued, 0);
  assert.ok(exists(at(dir, 'needs-clarification', 'l2.json')));
});

test('bucket L: an ambiguous fabricated path (matches 2 real paths with the same extra-token count) is left alone, not guessed', async () => {
  const dir = makePipeline();
  held(dir, archDiscoveryTask('l3', {
    promptContext: {
      communityId: 15, communityName: 'scripts', files: [
        { path: 'src/candidates-doc-merge-a.js', degree: 1, content: 'x' },
        { path: 'src/candidates-doc-merge-b.js', degree: 1, content: 'x' },
      ],
    },
  }));
  const s = await needsClarificationTriage(args(dir));
  assert.equal(s.requeued, 0);
  assert.ok(exists(at(dir, 'needs-clarification', 'l3.json')), 'left in place -- no unique winner to repair to');
});

test('bucket L: a genuinely unrecoverable fabrication (no real path is even a superset) is left for a human', async () => {
  const dir = makePipeline();
  held(dir, archDiscoveryTask('l4', {
    blockedReason: 'Ungrounded draft: fabricated file path(s): src/totally-invented-module.js -- not present anywhere in the target repo. A redraft cannot make an invented path real; re-file with an accurate citation, or archive if nothing applies.',
  }));
  const s = await needsClarificationTriage(args(dir));
  assert.equal(s.requeued, 0);
  assert.ok(exists(at(dir, 'needs-clarification', 'l4.json')));
});

test('bucket L: MAX_REQUEUES cap is respected', async () => {
  const dir = makePipeline();
  held(dir, archDiscoveryTask('l5', { ncTriageBucketAttempts: { L: 1 } }));
  const s = await needsClarificationTriage(args(dir));
  assert.equal(s.requeued, 0);
  assert.ok(exists(at(dir, 'needs-clarification', 'l5.json')));
});
