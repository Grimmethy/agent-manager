'use strict';

// review-prevote-checks.js: the checks that run just before the vote (P6.5a): the edit-set syntax gate, the hit-count gate and the runner that also calls
// the executed-verification stage and the advisory checks. The stages' own argument plumbing is pinned by review-executed-verification.test.js and
// review-advisory-checks.test.js through reviewTask(); here: each gate directly, the runner's order, and end-to-end calls for the two gates.

process.env.AGENT_MANAGER_REPO_ROOT = process.env.AGENT_MANAGER_REPO_ROOT || require('node:os').tmpdir();
process.env.AGENT_MANAGER_PIPELINE_DIR = process.env.AGENT_MANAGER_PIPELINE_DIR || require('node:os').tmpdir();

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const prevote = require('./review-prevote-checks.js');
const reviewTask = require('./review-task.js');
const { clearRegistry, registerTaskSource } = require('./task-source-registry.js');

class Fx {
  static task(over = {}) {
    return { id: 'pv-1', domain: 'default', source: 'trouble_log', title: 't', planResponse: 'p', abCallId: 'call-pv', history: [], promptContext: {},
      implementResponse: '[{"mode":"create","file":"good.js","content":"module.exports = 1;\\n"}]', ...over };
  }

  static ctx(over = {}) {
    const outcomes = [];
    const task = over.task || Fx.task();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-repo-'));
    return { task, repoRoot: dir, repoRootForCheck: dir, pipelineDir: '/p', factCheckVerdict: 'pass', recordModelOutcome: (o) => outcomes.push(o), outcomes,
      trimmedImplResponse: (task.implementResponse || '').trim(), ...over };
  }

  static withEnv(name, value, fn) {
    const saved = process.env[name];
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
    try { return fn(); } finally { if (saved === undefined) delete process.env[name]; else process.env[name] = saved; }
  }

  static fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-prevote-'));
    const repoRoot = path.join(dir, 'repo');
    const secondBrainDir = path.join(dir, 'sb');
    const pipelineDir = path.join(dir, 'pipeline');
    for (const d of [repoRoot, secondBrainDir, pipelineDir]) fs.mkdirSync(d);
    const domainsPath = path.join(dir, 'task-domains.json');
    fs.writeFileSync(domainsPath, JSON.stringify({ default: { workDirKind: 'repoRoot', successCheck: 'git-branch-diff' } }));
    return { dir, repoRoot, secondBrainDir, pipelineDir, domainsPath };
  }
}

const BAD_JS = '[{"mode":"create","file":"bad.js","content":"function ( {{\\n"}]';

test('editSetSyntaxGate blocks an edit set that does not parse, stamps the coverage on the task and records the outcome', () => {
  clearRegistry();
  const ctx = Fx.ctx({ task: Fx.task({ implementResponse: BAD_JS }), factCheckVerdict: 'flagged' });
  const r = prevote.editSetSyntaxGate(ctx);
  assert.equal(r.verdict, 'blocked');
  assert.equal(r.blockedStage, 'review');
  assert.equal(r.factCheckVerdict, 'flagged');
  assert.match(r.blockedReason, /^Deterministic gate: edit-set-syntax -- /);
  assert.equal(ctx.task.reviewProvider, 'deterministic-edit-set-syntax');
  assert.deepEqual(ctx.task.editSetSyntax.failed, ['bad.js']);
  assert.equal(ctx.outcomes.length, 1);
  assert.equal(ctx.outcomes[0].callId, 'call-pv');
  assert.equal(ctx.outcomes[0].outcome, 'rejected');
  assert.equal(ctx.task.history.some((h) => h.stage === 'blocked'), true);
});

test('editSetSyntaxGate passes a parsing edit set (and stamps it), is advisory or off by environment, and ignores prose and tasks with their own apply', () => {
  clearRegistry();
  const good = Fx.ctx();
  assert.equal(prevote.editSetSyntaxGate(good), null);
  assert.deepEqual(good.task.editSetSyntax.checked, ['good.js']);
  Fx.withEnv('AGENT_MANAGER_EDIT_SYNTAX_GATE', 'advisory', () => {
    const adv = Fx.ctx({ task: Fx.task({ implementResponse: BAD_JS }) });
    assert.equal(prevote.editSetSyntaxGate(adv), null);
    assert.equal(adv.task.history.some((h) => h.stage === 'advisory'), true);
    assert.equal(adv.outcomes.length, 0);
  });
  Fx.withEnv('AGENT_MANAGER_EDIT_SYNTAX_GATE', 'off', () => {
    const off = Fx.ctx({ task: Fx.task({ implementResponse: BAD_JS }) });
    assert.equal(prevote.editSetSyntaxGate(off), null);
    assert.equal(off.task.editSetSyntax, undefined);
  });
  assert.equal(prevote.editSetSyntaxGate(Fx.ctx({ task: Fx.task({ implementResponse: 'Just prose, no edit set.' }) })), null);
  registerTaskSource('pv_applies', { priority: 5, next: () => null, apply: () => {} });
  const own = Fx.ctx({ task: Fx.task({ source: 'pv_applies', implementResponse: BAD_JS }) });
  assert.equal(prevote.editSetSyntaxGate(own), null);
  assert.equal(own.task.editSetSyntax, undefined);
  clearRegistry();
});

test('hitCountGate blocks a mismatched asserted grep count using the fact-check root, honours the kill switch, and passes a matching or missing assertion', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-hit-'));
  fs.writeFileSync(path.join(root, 'sample.js'), 'foo\nbar\nfoo\n');
  const mk = (criteria, over = {}) => Fx.ctx({ task: Fx.task({ acceptanceCriteria: criteria, rawDiff: '' }), repoRoot: '/not/the/root', repoRootForCheck: root, ...over });
  const bad = mk(['`grep -n foo sample.js` returns exactly 3 hits']);
  const r = prevote.hitCountGate(bad);
  assert.equal(r.verdict, 'blocked');
  assert.match(r.blockedReason, /actual 2, expected 3/);
  assert.equal(bad.task.reviewProvider, 'deterministic-hit-count');
  assert.equal(bad.outcomes[0].outcome, 'rejected');
  assert.equal(prevote.hitCountGate(mk(['`grep -n foo sample.js` returns exactly 2 hits'])), null);
  assert.equal(prevote.hitCountGate(mk(['just a prose criterion'])), null);
  assert.equal(prevote.hitCountGate(mk([])), null);
  Fx.withEnv('AGENT_MANAGER_HIT_COUNT_GATE', 'false', () => assert.equal(prevote.hitCountGate(mk(['`grep -n foo sample.js` returns exactly 3 hits'])), null));
});

test('runPreVoteChecks runs the edit-set gate first, then the stages, then the hit-count gate, and returns null when nothing fires', () => {
  clearRegistry();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-run-'));
  fs.writeFileSync(path.join(root, 'sample.js'), 'foo\n');
  const none = () => ({ inert: [], overlaps: [], uses: [], paths: [] });
  const base = (over) => { const c = Fx.ctx({ repoRoot: root, repoRootForCheck: root, verifyDiffFn: none, findInertFn: none, findOverlapFn: none, findUndefinedFn: none, findSkipPathsFn: none, ...over }); return c; };
  assert.equal(prevote.runPreVoteChecks(base({})), null);
  const both = base({ task: Fx.task({ implementResponse: BAD_JS, acceptanceCriteria: ['`grep -n foo sample.js` returns exactly 9 hits'] }) });
  prevote.runPreVoteChecks(both);
  assert.equal(both.task.reviewProvider, 'deterministic-edit-set-syntax', 'the edit-set gate runs before the hit-count gate');
  const hitOnly = base({ task: Fx.task({ acceptanceCriteria: ['`grep -n foo sample.js` returns exactly 9 hits'] }) });
  assert.equal(prevote.runPreVoteChecks(hitOnly).verdict, 'blocked');
  assert.equal(hitOnly.task.reviewProvider, 'deterministic-hit-count');
});

test('end to end through reviewTask(): a syntax-broken edit set is blocked with the recorded outcome and the fact-check label', async () => {
  const f = Fx.fixture();
  clearRegistry();
  registerTaskSource('pv_e2e', { priority: 5, next: () => null });
  const outcomes = [];
  const task = Fx.task({ id: 'pv-e2e', source: 'pv_e2e', implementResponse: BAD_JS });
  const result = await reviewTask.reviewTask(task, { repoRoot: f.repoRoot, secondBrainDir: f.secondBrainDir, domainsPath: f.domainsPath, pipelineDir: f.pipelineDir,
    recordModelOutcome: (o) => outcomes.push(o), localMajorityVote: async () => { throw new Error('no vote expected'); } });
  clearRegistry();
  assert.equal(result.verdict, 'blocked');
  assert.match(result.blockedReason, /edit-set-syntax/);
  assert.equal(task.reviewProvider, 'deterministic-edit-set-syntax');
  assert.equal(typeof result.factCheckVerdict, 'string');
  assert.equal(outcomes.length, 1);
});

test('end to end through reviewTask(): the hit-count gate checks the repo the fact-check used, not the caller repoRoot', async () => {
  const f = Fx.fixture();
  fs.writeFileSync(path.join(f.repoRoot, 'sample.js'), 'foo\n');
  clearRegistry();
  registerTaskSource('pv_e2e_hit', { priority: 5, next: () => null });
  const task = Fx.task({ id: 'pv-e2e2', source: 'pv_e2e_hit', implementResponse: '```diff\n--- a/sample.js\n+++ b/sample.js\n@@ -1 +1 @@\n-foo\n+foo\n```',
    acceptanceCriteria: ['`grep -n foo sample.js` returns exactly 4 hits'], rawDiff: '' });
  const result = await reviewTask.reviewTask(task, { repoRoot: f.repoRoot, secondBrainDir: f.secondBrainDir, domainsPath: f.domainsPath, pipelineDir: f.pipelineDir,
    recordModelOutcome: () => {}, localMajorityVote: async () => { throw new Error('no vote expected'); } });
  clearRegistry();
  assert.equal(result.verdict, 'blocked');
  assert.match(result.blockedReason, /actual 1, expected 4/);
});

test('the pre-vote module does not require review-task.js (no import cycle)', () => {
  const { buildGraph } = require('../scripts/import-cycles.js');
  const graph = buildGraph(path.join(__dirname, '..'));
  assert.equal(graph.all['src/review-prevote-checks.js'].includes('src/review-task.js'), false);
});
