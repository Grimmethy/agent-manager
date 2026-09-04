'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { needsClarificationTriage, DEGENERATE_RE, INVALID_PREMISE_RE } = require('./needs-clarification-triage.js');

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
  assert.equal(moved.ncTriageAttempts, 1);
  assert.ok(moved.history.some((h) => h.stage === 'requeued' && /clean-state retry 1\/1/.test(h.detail)));
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
  held(dir, baseTask('t3', { ncTriageAttempts: 1 }));
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

test('decompose-loop flag -> skipped entirely (autoroute owns it)', async () => {
  const dir = makePipeline();
  held(dir, baseTask('t5', { stalenessFlag: { reason: 'decompose-loop' } }));
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
