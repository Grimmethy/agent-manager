'use strict';

// The early deterministic gates moved out of runReview (roadmap P6.3a). The review-task tests cover each gate's behaviour; these tests cover what the move can
// break silently: each gate directly, the order of runEarlyGates, and the call site handing the validator its secondBrainDir and repoRoot.

process.env.AGENT_MANAGER_REPO_ROOT = process.env.AGENT_MANAGER_REPO_ROOT || require('node:os').tmpdir();
process.env.AGENT_MANAGER_PIPELINE_DIR = process.env.AGENT_MANAGER_PIPELINE_DIR || require('node:os').tmpdir();
process.env.AGENT_MANAGER_REVIEW_EXECUTED_VERIFY = 'false';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const gates = require('./review-early-gates.js');
const reviewTask = require('./review-task.js');
const { clearRegistry, registerTaskSource } = require('./task-source-registry.js');

class Fx {
  static task(over = {}) {
    return { id: 'eg-1', domain: 'default', source: 'trouble_log', title: 't', planResponse: 'p', implementResponse: '{"mode":"edit","file":"a.js","find":"a","replace":"b"}', history: [], ...over };
  }

  static ctx(over = {}) {
    const outcomes = [];
    return { task: Fx.task(), recordModelOutcome: (o) => outcomes.push(o), secondBrainDir: '/sb', repoRoot: '/repo', outcomes, ...over };
  }

  static fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-early-'));
    const repoRoot = path.join(dir, 'repo');
    const secondBrainDir = path.join(dir, 'sb');
    fs.mkdirSync(repoRoot);
    fs.mkdirSync(secondBrainDir);
    const domainsPath = path.join(dir, 'task-domains.json');
    fs.writeFileSync(domainsPath, JSON.stringify({ default: { workDirKind: 'repoRoot', successCheck: 'git-branch-diff' } }));
    return { repoRoot, secondBrainDir, domainsPath };
  }
}

test('truncationGuard blocks a refusal followed by a cut-off code fragment and records it; a normal draft passes', () => {
  const ctx = Fx.ctx({ task: Fx.task({ implementResponse: 'I could not find the pattern:\nfunction example() {\n  return "Topology' }) });
  const result = gates.truncationGuard(ctx);
  assert.equal(result.verdict, 'blocked');
  assert.equal(result.factCheckVerdict, 'skipped');
  assert.equal(ctx.task.reviewProvider, 'deterministic-truncation-guard');
  assert.equal(ctx.outcomes[0].outcome, 'rejected');
  assert.equal(gates.truncationGuard(Fx.ctx()), null);
});

test('deterministicValidatorGate hands the validator the task, secondBrainDir and repoRoot and acts on its answer', () => {
  clearRegistry();
  const seen = [];
  let answer = { ok: true };
  registerTaskSource('eg_source', { priority: 5, next: () => null, deterministicReviewValidate: (task, opts) => { seen.push(opts); return answer; } });
  const ok = Fx.ctx({ task: Fx.task({ source: 'eg_source' }) });
  assert.equal(gates.deterministicValidatorGate(ok).verdict, 'approved');
  assert.deepEqual(seen[0], { secondBrainDir: '/sb', repoRoot: '/repo' });
  assert.equal(ok.task.reviewProvider, 'deterministic-brain-dump-sort');
  answer = { ok: false, reason: 'bad folder' };
  const bad = gates.deterministicValidatorGate(Fx.ctx({ task: Fx.task({ source: 'eg_source' }) }));
  assert.equal(bad.verdict, 'blocked');
  assert.match(bad.blockedReason, /Deterministic review: bad folder/);
  answer = null;
  assert.match(gates.deterministicValidatorGate(Fx.ctx({ task: Fx.task({ source: 'eg_source' }) })).blockedReason, /validation failed/);
  clearRegistry();
  assert.equal(gates.deterministicValidatorGate(Fx.ctx()), null, 'a source without a validator is skipped');
});

test('nullOutcomeGate approves a well-formed honest null and ignores everything else', () => {
  const text = 'ROOT CAUSE 1: cap is 2.\n\nNO CLEAR ROOT CAUSE -- for the second failure the evidence gives no trace to rank against at all here, only the one missing signal.';
  const ctx = Fx.ctx({ task: Fx.task({ source: 'pipeline_forensics', implementResponse: 'NO CLEAR ROOT CAUSE -- the bundle has zero model_calls rows and zero contrast winners, so a counterfactual cannot be grounded; the trace of the subject is the one missing signal.' }) });
  const result = gates.nullOutcomeGate(ctx);
  assert.equal(result.verdict, 'approved');
  assert.equal(ctx.task.reviewProvider, 'deterministic-null-outcome');
  assert.equal(gates.nullOutcomeGate(Fx.ctx({ task: Fx.task({ source: 'pipeline_forensics', implementResponse: text.split('\n\n')[0] }) })), null);
  assert.equal(gates.nullOutcomeGate(Fx.ctx()), null);
});

test('commentOnlyGate closes a comment-only brain-dump fix as a no-op and keeps the diff; a hub child or a code change falls through', () => {
  const comment = ['diff --git a/test/s.test.js b/test/s.test.js', '--- a/test/s.test.js', '+++ b/test/s.test.js', '@@ -10,3 +10,4 @@', '   const defs = makeDefs()', '+  // intentional: deep clone for immutability check', '   const original = 1', ''].join('\n');
  const make = (over = {}) => Fx.ctx({ task: Fx.task({ source: 'adhoc', domain: 'default', adhocResolution: 'implemented', promptContext: { brainDumpEntryId: 'bd-1', rawText: 'x' }, rawDiff: comment, ...over }) });
  const ctx = make();
  const result = gates.commentOnlyGate(ctx);
  assert.equal(result.verdict, 'approved');
  assert.equal(ctx.task.rawDiff, '');
  assert.equal(ctx.task.commentOnlyDiff, comment);
  assert.equal(ctx.task.adhocResolution, 'no-changes-needed');
  assert.equal(gates.commentOnlyGate(make({ stacked: { branch: 'agent/x', seq: 1, total: 2 } })), null, 'hub child');
  assert.equal(gates.commentOnlyGate(make({ rawDiff: comment.replace('+  // intentional', '+  doIt() // intentional') })), null, 'a code change');
});

test('runEarlyGates runs the gates in order and returns null when none applies', () => {
  assert.equal(gates.runEarlyGates(Fx.ctx()), null);
  const truncated = Fx.ctx({ task: Fx.task({ implementResponse: 'I could not find it:\nfunction e() {\n  return "Topology' }) });
  assert.equal(gates.runEarlyGates(truncated).blockedReason, 'truncated output');
});

test('end to end through reviewTask: the registered validator receives the secondBrainDir and repoRoot runReview was given', async () => {
  const { repoRoot, secondBrainDir, domainsPath } = Fx.fixture();
  clearRegistry();
  let seen = null;
  registerTaskSource('eg_e2e', { priority: 5, next: () => null, deterministicReviewValidate: (task, opts) => { seen = opts; return { ok: true }; } });
  const result = await reviewTask.reviewTask(Fx.task({ source: 'eg_e2e' }), { repoRoot, secondBrainDir, domainsPath, recordModelOutcome: () => {},
    localMajorityVote: async () => { throw new Error('no vote expected'); } });
  clearRegistry();
  assert.equal(result.verdict, 'approved');
  assert.deepEqual(seen, { secondBrainDir, repoRoot });
});

test('the early-gates module does not require review-task.js (no import cycle)', () => {
  const { buildGraph } = require('../scripts/import-cycles.js');
  const graph = buildGraph(path.join(__dirname, '..'));
  assert.equal(graph.all['src/review-early-gates.js'].includes('src/review-task.js'), false);
});
