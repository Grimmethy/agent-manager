'use strict';

// review-vote-decision.js: the vote and the approve/block decision of runReview (P6.5b). The four helpers that stay in review-task.js are injected, so the
// unit tests drive runVoteAndDecide with stubs and watch the order of calls and what is handed on; the end-to-end tests go through reviewTask() with a
// fake majority vote and pin the call site (every outer variable reaches the module, the result keeps the fact-check label).

process.env.AGENT_MANAGER_REPO_ROOT = process.env.AGENT_MANAGER_REPO_ROOT || require('node:os').tmpdir();
process.env.AGENT_MANAGER_PIPELINE_DIR = process.env.AGENT_MANAGER_PIPELINE_DIR || require('node:os').tmpdir();

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const voteDecision = require('./review-vote-decision.js');
const reviewTask = require('./review-task.js');
const { clearRegistry, registerTaskSource } = require('./task-source-registry.js');

class Fx {
  static task(over = {}) {
    return { id: 'vd-1', domain: 'default', source: 'trouble_log', title: 't', planResponse: 'p', abCallId: 'call-vd', history: [], promptContext: {}, ...over };
  }

  // A ctx whose helpers record the order of calls; vote is what the fake majority vote answers.
  static ctx(vote, over = {}) {
    const calls = [];
    const outcomes = [];
    const task = over.task || Fx.task();
    const ctx = {
      task, factCheck: { checked: 1 }, groundingText: 'GROUND', factCheckVerdict: 'flagged', instancesDir: '/instances',
      recordModelOutcome: (o) => outcomes.push(o),
      waitForLocalAvailability: async (dir) => { calls.push(['wait', dir]); },
      buildVerdictPrompt: (t, fc, g) => { calls.push(['prompt', t.id, fc, g]); return 'THE PROMPT'; },
      classifyVote: (markers, min) => { calls.push(['classify', markers, min]); return 'CLASSIFIER'; },
      decideInconclusiveOutcome: (name, v) => { calls.push(['decide', name, v === vote]); return { passThrough: false }; },
      resolvedMajorityVote: async (opts) => { calls.push(['vote', opts]); return vote; },
      calls, outcomes, ...over,
    };
    return ctx;
  }

  static votes(verdicts, responses) {
    return verdicts.map((v, i) => ({ verdict: v, response: responses[i] }));
  }

  static fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-vote-'));
    const repoRoot = path.join(dir, 'repo');
    const secondBrainDir = path.join(dir, 'sb');
    const pipelineDir = path.join(dir, 'pipeline');
    const instancesDir = path.join(dir, 'instances');
    for (const d of [repoRoot, secondBrainDir, pipelineDir, instancesDir]) fs.mkdirSync(d);
    const domainsPath = path.join(dir, 'task-domains.json');
    fs.writeFileSync(domainsPath, JSON.stringify({ default: { workDirKind: 'repoRoot', successCheck: 'git-branch-diff' } }));
    return { dir, repoRoot, secondBrainDir, pipelineDir, instancesDir, domainsPath };
  }
}

const GOOD_EDIT = '[{"mode":"create","file":"good.js","content":"module.exports = 1;\\n"}]';

test('runVoteAndDecide waits for the local model first, then builds the prompt from the grounding and votes 3 with a 2-agree minimum', async () => {
  const vote = { confident: true, verdict: 'APPROVE', votes: Fx.votes(['APPROVE', 'APPROVE', 'REJECT'], ['ok', 'ok2', 'REJECT: no']), realVoteCount: 3, requestedVotes: 3, voteErrors: [] };
  const ctx = Fx.ctx(vote);
  await voteDecision.runVoteAndDecide(ctx);
  assert.deepEqual(ctx.calls.map((c) => c[0]), ['wait', 'prompt', 'classify', 'vote']);
  assert.deepEqual(ctx.calls[0], ['wait', '/instances']);
  assert.deepEqual(ctx.calls[1], ['prompt', 'vd-1', { checked: 1 }, 'GROUND']);
  assert.deepEqual(ctx.calls[2], ['classify', ['APPROVE', 'REJECT'], 20]);
  const opts = ctx.calls[3][1];
  assert.equal(opts.prompt, 'THE PROMPT');
  assert.equal(opts.classify, 'CLASSIFIER');
  assert.equal(opts.n, 3);
  assert.equal(opts.minAgreeing, 2);
  assert.equal(opts.temperature, 0.2);
  assert.equal(opts.source, 'trouble_log');
  assert.equal(opts.taskId, 'vd-1');
  assert.equal(opts.stage, 'review-vote');
});

test('a confident APPROVE approves: verdict text with the first approving response, votes and errors stamped, outcome and history recorded', async () => {
  const vote = { confident: true, verdict: 'APPROVE', votes: Fx.votes(['REJECT', 'APPROVE', 'APPROVE'], ['REJECT: x', 'first approval', 'second']), realVoteCount: 3, requestedVotes: 3, voteErrors: [] };
  const ctx = Fx.ctx(vote);
  const r = await voteDecision.runVoteAndDecide(ctx);
  assert.deepEqual(r, { succeeded: true, verdict: 'approved', factCheckVerdict: 'flagged' });
  assert.equal(ctx.task.reviewProvider, 'local');
  assert.equal(ctx.task.localVerdict, 'Confident majority APPROVE (votes: 3/3 real)\n\nfirst approval');
  assert.equal(ctx.task.localVotes, vote.votes);
  assert.equal(ctx.task.voteErrors, vote.voteErrors);
  assert.ok(!Number.isNaN(Date.parse(ctx.task.reviewedAt)));
  assert.deepEqual(ctx.outcomes, [{ callId: 'call-vd', outcome: 'approved', outcomeStage: 'review', outcomeReason: null }]);
  const ev = ctx.task.history[ctx.task.history.length - 1];
  assert.equal(ev.stage, 'approved');
  assert.equal(ev.detail, 'votes: 3/3 real');
});

test('hard-failed votes are named in the summary', async () => {
  const vote = { confident: true, verdict: 'APPROVE', votes: Fx.votes(['APPROVE', 'APPROVE'], ['a', 'b']), realVoteCount: 2, requestedVotes: 3, voteErrors: ['boom'] };
  const ctx = Fx.ctx(vote);
  await voteDecision.runVoteAndDecide(ctx);
  assert.match(ctx.task.localVerdict, /^Confident majority APPROVE \(votes: 2\/3 real, 1 vote\(s\) hard-failed\)/);
});

test('a confident REJECT blocks with the reason after the first REJECT: marker, and without one falls back to the summary', async () => {
  const withReason = { confident: true, verdict: 'REJECT', votes: Fx.votes(['APPROVE', 'REJECT', 'REJECT'], ['ok', 'REJECT: the claim is stale', 'REJECT: other']), realVoteCount: 3, requestedVotes: 3, voteErrors: [] };
  const ctx1 = Fx.ctx(withReason);
  const r1 = await voteDecision.runVoteAndDecide(ctx1);
  assert.deepEqual(r1, { succeeded: true, verdict: 'blocked', blockedReason: 'the claim is stale', blockedStage: 'review', factCheckVerdict: 'flagged' });
  assert.equal(ctx1.task.reviewProvider, 'local');
  assert.equal(ctx1.task.localVotes, withReason.votes);
  assert.deepEqual(ctx1.outcomes, [{ callId: 'call-vd', outcome: 'rejected', outcomeStage: 'review', outcomeReason: 'the claim is stale' }]);
  assert.equal(ctx1.task.history[ctx1.task.history.length - 1].stage, 'blocked');
  assert.equal(ctx1.task.localVerdict, undefined);

  const noReason = { confident: true, verdict: 'REJECT', votes: Fx.votes(['REJECT', 'REJECT'], ['no marker here', 'nor here']), realVoteCount: 2, requestedVotes: 3, voteErrors: [] };
  const r2 = await voteDecision.runVoteAndDecide(Fx.ctx(noReason));
  assert.equal(r2.blockedReason, 'REJECT (votes: 2/3 real)');
});

test('no confident majority blocks as inconclusive; a vote that is confident but names no verdict is treated the same', async () => {
  const split = { confident: false, verdict: null, votes: Fx.votes([null, null, null], ['?', '?', '?']), realVoteCount: 0, requestedVotes: 3, voteErrors: ['e1', 'e2'] };
  const ctx = Fx.ctx(split);
  const r = await voteDecision.runVoteAndDecide(ctx);
  assert.equal(r.verdict, 'blocked');
  assert.equal(r.blockedStage, 'review');
  assert.equal(r.blockedReason, 'Local-model review inconclusive, no confident majority (votes: 0/3 real, 2 vote(s) hard-failed)');
  assert.deepEqual(ctx.outcomes, [{ callId: 'call-vd', outcome: 'rejected', outcomeStage: 'review', outcomeReason: r.blockedReason }]);
  assert.equal(ctx.task.voteErrors, split.voteErrors);

  const noVerdict = { confident: true, verdict: null, votes: [], realVoteCount: 3, requestedVotes: 3, voteErrors: [] };
  const r2 = await voteDecision.runVoteAndDecide(Fx.ctx(noVerdict));
  assert.match(r2.blockedReason, /^Local-model review inconclusive/);
});

test('the inconclusive decision is asked with the resolved source name and the vote result; a pass-through approves with the caveat', async () => {
  const split = { confident: false, verdict: null, votes: [], realVoteCount: 0, requestedVotes: 3, voteErrors: [] };
  const ctx = Fx.ctx(split, { task: Fx.task({ source: 'adhoc' }) });
  ctx.decideInconclusiveOutcome = (name, v) => { ctx.calls.push(['decide', name, v === split]); return { passThrough: true }; };
  const r = await voteDecision.runVoteAndDecide(ctx);
  assert.deepEqual(ctx.calls.find((c) => c[0] === 'decide'), ['decide', 'adhoc', true]);
  assert.deepEqual(r, { succeeded: true, verdict: 'approved', factCheckVerdict: 'flagged' });
  assert.equal(ctx.task.reviewProvider, 'local');
  assert.equal(ctx.task.localVotes, split.votes);
  assert.equal(ctx.outcomes[0].outcome, 'approved');
  assert.match(ctx.outcomes[0].outcomeReason, /^pass-with-caveat: inconclusive votes on adhoc source \(adhoc\)$/);
  const ev = ctx.task.history[ctx.task.history.length - 1];
  assert.equal(ev.stage, 'approved');
  assert.match(ev.detail, /^pass-with-caveat: inconclusive votes \(votes: 0\/3 real\), adhoc pass-through$/);
});

test('end to end through reviewTask(): a confident approve reaches the module with the fact-check label and the vote options the caller path builds', async () => {
  const f = Fx.fixture();
  clearRegistry();
  registerTaskSource('vd_e2e', { priority: 5, next: () => null });
  const seen = [];
  const outcomes = [];
  const vote = { confident: true, verdict: 'APPROVE', votes: Fx.votes(['APPROVE', 'APPROVE', 'APPROVE'], ['fine', 'fine', 'fine']), realVoteCount: 3, requestedVotes: 3, voteErrors: [] };
  const task = Fx.task({ id: 'vd-e2e', source: 'vd_e2e', implementResponse: GOOD_EDIT });
  const result = await reviewTask.reviewTask(task, { repoRoot: f.repoRoot, secondBrainDir: f.secondBrainDir, domainsPath: f.domainsPath, pipelineDir: f.pipelineDir,
    instancesDir: f.instancesDir, recordModelOutcome: (o) => outcomes.push(o), localMajorityVote: async (opts) => { seen.push(opts); return vote; } });
  clearRegistry();
  assert.equal(result.verdict, 'approved');
  assert.equal(typeof result.factCheckVerdict, 'string');
  assert.equal(task.status, 'approved');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].taskId, 'vd-e2e');
  assert.equal(seen[0].source, 'vd_e2e');
  assert.equal(seen[0].stage, 'review-vote');
  assert.equal(seen[0].minAgreeing, 2);
  assert.match(seen[0].prompt, /vd-e2e|good\.js/);
  assert.equal(typeof seen[0].classify, 'function');
  assert.equal(seen[0].classify('APPROVE: fine and sound reasoning here, definitely'), 'APPROVE');
  assert.deepEqual(outcomes.map((o) => o.outcome), ['approved']);
});

test('end to end through reviewTask(): a confident reject blocks the task with the reviewer reason and an inconclusive vote on a non-adhoc source blocks it too', async () => {
  const f = Fx.fixture();
  clearRegistry();
  registerTaskSource('vd_e2e2', { priority: 5, next: () => null });
  const reject = { confident: true, verdict: 'REJECT', votes: Fx.votes(['REJECT', 'REJECT', 'APPROVE'], ['REJECT: it deletes the wrong file', 'REJECT: same', 'ok']), realVoteCount: 3, requestedVotes: 3, voteErrors: [] };
  const base = { repoRoot: f.repoRoot, secondBrainDir: f.secondBrainDir, domainsPath: f.domainsPath, pipelineDir: f.pipelineDir, instancesDir: f.instancesDir, recordModelOutcome: () => {} };
  const t1 = Fx.task({ id: 'vd-e2e-r', source: 'vd_e2e2', implementResponse: GOOD_EDIT });
  const r1 = await reviewTask.reviewTask(t1, { ...base, localMajorityVote: async () => reject });
  assert.equal(r1.verdict, 'blocked');
  assert.equal(r1.blockedReason, 'it deletes the wrong file');
  assert.equal(t1.status, 'blocked');

  const split = { confident: false, verdict: null, votes: [], realVoteCount: 0, requestedVotes: 3, voteErrors: [] };
  const t2 = Fx.task({ id: 'vd-e2e-i', source: 'vd_e2e2', implementResponse: GOOD_EDIT });
  const r2 = await reviewTask.reviewTask(t2, { ...base, localMajorityVote: async () => split });
  clearRegistry();
  assert.equal(r2.verdict, 'blocked');
  assert.match(r2.blockedReason, /^Local-model review inconclusive, no confident majority/);
});

test('the vote module does not require review-task.js (no import cycle)', () => {
  const { buildGraph } = require('../scripts/import-cycles.js');
  const graph = buildGraph(path.join(__dirname, '..'));
  assert.equal(graph.all['src/review-vote-decision.js'].includes('src/review-task.js'), false);
});
