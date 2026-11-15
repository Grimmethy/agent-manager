'use strict';

// The executed-verification stage moved out of runReview (roadmap P6.1): its gates, the pinning escape and the helpers, tested directly with a fake verifier.

const test = require('node:test');
const assert = require('node:assert/strict');
process.env.AGENT_MANAGER_REPO_ROOT = process.env.AGENT_MANAGER_REPO_ROOT || require('node:os').tmpdir();
process.env.AGENT_MANAGER_PIPELINE_DIR = process.env.AGENT_MANAGER_PIPELINE_DIR || require('node:os').tmpdir();
const stage = require('./review-executed-verification.js');
const reviewTask = require('./review-task.js');
const { reviewTask: runReviewTask } = reviewTask;

class Fx {
  static task(over = {}) {
    return { id: 't1', source: 'adhoc', domain: 'adhoc', adhocResolution: 'implemented', history: [],
      rawDiff: 'diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n-x\n+y\n', acceptanceResults: [], ...over };
  }

  static run(task, verdictOrFn, extra = {}) {
    const calls = { outcomes: [], verify: [] };
    const verifyDiffFn = typeof verdictOrFn === 'function' ? verdictOrFn : (a) => { calls.verify.push(a); return verdictOrFn; };
    const result = stage.runExecutedVerificationStage({ task, repoRoot: '/nonexistent-repo', pipelineDir: '/p', verifyDiffFn,
      recordModelOutcome: (o) => calls.outcomes.push(o), factCheckVerdict: 'pass', ...extra });
    return { result, calls };
  }
}

test('a failed verification blocks before any vote and records why', () => {
  const task = Fx.task();
  const { result, calls } = Fx.run(task, { status: 'failed', reasons: ['covering tests failed'], tests: { ran: ['a.test.js'], passed: false, failures: ['x'] }, commands: [] });
  assert.equal(result.verdict, 'blocked');
  assert.equal(result.blockedStage, 'review');
  assert.equal(result.factCheckVerdict, 'pass');
  assert.equal(task.reviewProvider, 'deterministic-executed-verification');
  assert.equal(calls.outcomes[0].outcome, 'rejected');
  assert.equal(task.executedVerification.result, 'failed');
});

test('the verifier is handed the task id, the diff, the repo root and the pipeline dir', () => {
  const task = Fx.task();
  const { calls } = Fx.run(task, { status: 'passed', reasons: [], tests: { ran: [], passed: true, failures: [] }, commands: [] });
  assert.equal(calls.verify.length, 1);
  assert.equal(calls.verify[0].taskId, 't1');
  assert.equal(calls.verify[0].rawDiff, task.rawDiff);
  assert.equal(calls.verify[0].repoRoot, '/nonexistent-repo');
  assert.equal(calls.verify[0].pipelineDir, '/p');
});

test('passed and inconclusive let the review carry on (null) and are recorded', () => {
  for (const status of ['passed', 'inconclusive']) {
    const task = Fx.task();
    const { result } = Fx.run(task, { status, reasons: [], tests: { ran: [], passed: true, failures: [] }, commands: [] });
    assert.equal(result, null, status);
    assert.equal(task.executedVerification.result, status);
  }
});

test('no diff, or the kill switch, skips the stage without calling the verifier', () => {
  const noDiff = Fx.task({ rawDiff: '' });
  let calls = 0;
  const counting = () => { calls += 1; return { status: 'passed', reasons: [], tests: { ran: [], passed: true, failures: [] }, commands: [] }; };
  assert.equal(Fx.run(noDiff, counting).result, null);
  assert.equal(calls, 0, 'no diff: the verifier is not called');
  const saved = process.env.AGENT_MANAGER_REVIEW_EXECUTED_VERIFY;
  process.env.AGENT_MANAGER_REVIEW_EXECUTED_VERIFY = 'false';
  try {
    assert.equal(Fx.run(Fx.task(), counting).result, null);
    assert.equal(calls, 0, 'kill switch: the verifier is not called');
  } finally {
    if (saved === undefined) delete process.env.AGENT_MANAGER_REVIEW_EXECUTED_VERIFY;
    else process.env.AGENT_MANAGER_REVIEW_EXECUTED_VERIFY = saved;
  }
});

test('a verifier that throws is non-fatal: the stage returns null', () => {
  const task = Fx.task();
  const { result } = Fx.run(task, () => { throw new Error('sandbox missing'); });
  assert.equal(result, null);
  assert.equal(task.executedVerification, undefined);
});

test('diffTouchesOnlyTestFiles: test-only, mixed, empty and header-less diffs', () => {
  const d = (...files) => files.map((f) => `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n`).join('');
  assert.equal(stage.diffTouchesOnlyTestFiles(d('src/a.test.js', 'tests/b.js')), true);
  assert.equal(stage.diffTouchesOnlyTestFiles(d('src/a.test.js', 'src/a.js')), false);
  assert.equal(stage.diffTouchesOnlyTestFiles(''), false);
  assert.equal(stage.diffTouchesOnlyTestFiles(null), false);
  assert.equal(stage.diffTouchesOnlyTestFiles('some text with no diff headers'), false);
  assert.equal(stage.diffTouchesOnlyTestFiles('--- a/x.spec.js\n+++ b/x.spec.js\n'), true);
});

test('review-task.js still exports the helpers that moved', () => {
  for (const name of ['extractTaskDiff', 'summariseExecutedVerification', 'executedVerificationBlockReason', 'isHubChildTask', 'summariseGateReplay', 'EXECUTED_VERIFY_BUDGET_MS']) {
    assert.strictEqual(reviewTask[name], stage[name], name);
  }
});

test('review-task.js and the stage module do not require each other', () => {
  const path = require('node:path');
  const { buildGraph } = require('../scripts/import-cycles.js');
  const graph = buildGraph(path.join(__dirname, '..'));
  assert.equal(graph.all['src/review-executed-verification.js'].includes('src/review-task.js'), false);
});

test('end to end through reviewTask: the verifier is handed the pipeline dir runReview was given', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-ev-e2e-'));
  const repoRoot = path.join(dir, 'repo');
  fs.mkdirSync(repoRoot);
  const domainsPath = path.join(dir, 'task-domains.json');
  fs.writeFileSync(domainsPath, JSON.stringify({ default: { workDirKind: 'repoRoot', successCheck: 'git-branch-diff' } }));
  const task = { id: 'e2e-1', domain: 'default', source: 'manual', title: 'Fix the thing', adhocResolution: 'implemented', planResponse: '1. Change a.js.',
    implementResponse: '{"mode":"edit","file":"src/a.js","find":"a","replace":"b"}', acceptanceCriteria: ['the helper works'],
    acceptanceResults: [{ criterion: 'the helper works', check: '`node --test src/a.test.js`', result: 'PASS', pass: true }],
    rawDiff: 'diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n-a\n+b\n', history: [] };
  let seen = null;
  const saved = process.env.AGENT_MANAGER_REVIEW_EXECUTED_VERIFY;
  process.env.AGENT_MANAGER_REVIEW_EXECUTED_VERIFY = 'true';
  try {
    await runReviewTask(task, { repoRoot, domainsPath, pipelineDir: '/the/pipeline/dir', recordModelOutcome: () => {},
      localMajorityVote: async () => ({ confident: true, verdict: 'APPROVE', votes: [{ verdict: 'APPROVE', reasoning: 'ok' }], realVoteCount: 3, requestedVotes: 3 }),
      verifyDiffFn: (a) => { seen = a; return { status: 'passed', reasons: [], tests: { ran: [], passed: true, failures: [] }, commands: [] }; } });
  } finally {
    if (saved === undefined) delete process.env.AGENT_MANAGER_REVIEW_EXECUTED_VERIFY;
    else process.env.AGENT_MANAGER_REVIEW_EXECUTED_VERIFY = saved;
  }
  assert.ok(seen, 'the verifier was called through runReview');
  assert.equal(seen.pipelineDir, '/the/pipeline/dir');
  assert.equal(seen.repoRoot, repoRoot);
});
