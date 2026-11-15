'use strict';

// The advisory checks moved out of runReview (roadmap P6.2). The existing review-task tests cover each check's behaviour; these tests cover what the move
// can break silently: the call site must hand every injected finder and the repo root through, the exports must be the same functions, and no import cycle.

process.env.AGENT_MANAGER_REPO_ROOT = process.env.AGENT_MANAGER_REPO_ROOT || require('node:os').tmpdir();
process.env.AGENT_MANAGER_PIPELINE_DIR = process.env.AGENT_MANAGER_PIPELINE_DIR || require('node:os').tmpdir();
process.env.AGENT_MANAGER_REVIEW_EXECUTED_VERIFY = 'false';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const advisory = require('./review-advisory-checks.js');
const reviewTask = require('./review-task.js');

class Fx {
  static fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-advisory-'));
    const repoRoot = path.join(dir, 'repo');
    fs.mkdirSync(repoRoot);
    const domainsPath = path.join(dir, 'task-domains.json');
    fs.writeFileSync(domainsPath, JSON.stringify({ default: { workDirKind: 'repoRoot', successCheck: 'git-branch-diff' } }));
    return { repoRoot, domainsPath };
  }

  static task() {
    return { id: 'adv-1', domain: 'default', source: 'manual', title: 'Fix the thing', adhocResolution: 'implemented', planResponse: '1. Change a.js.',
      implementResponse: '{"mode":"edit","file":"src/a.js","find":"a","replace":"b"}', acceptanceCriteria: ['the helper works'],
      acceptanceResults: [{ criterion: 'the helper works', check: '`node --test src/a.test.js`', result: 'PASS', pass: true }],
      rawDiff: 'diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n-a\n+b\n', history: [] };
  }

  static approve() {
    return async () => ({ confident: true, verdict: 'APPROVE', votes: [{ verdict: 'APPROVE', reasoning: 'ok' }], realVoteCount: 3, requestedVotes: 3 });
  }
}

test('end to end through reviewTask: every injected finder is called with the repo root runReview was given', async () => {
  const { repoRoot, domainsPath } = Fx.fixture();
  const seen = {};
  const finder = (name, result) => (a) => { seen[name] = a; return result; };
  await reviewTask.reviewTask(Fx.task(), { repoRoot, domainsPath, pipelineDir: '/p', recordModelOutcome: () => {}, localMajorityVote: Fx.approve(),
    findInertFn: finder('inert', { inert: [] }), findOverlapFn: finder('overlap', { overlaps: [] }),
    findUndefinedFn: finder('undefined', { uses: [] }), findSkipPathsFn: finder('skip', { paths: [] }) });
  for (const name of ['inert', 'overlap', 'undefined']) {
    assert.ok(seen[name], `${name} finder was called through runReview`);
    assert.equal(seen[name].repoRoot, repoRoot, `${name} finder got the repo root`);
    assert.match(seen[name].rawDiff, /diff --git/, `${name} finder got the diff`);
  }
  assert.ok(seen.skip, 'skip-path finder was called');
  assert.match(seen.skip.rawDiff, /diff --git/);
});

test('a blocking finder result reaches the review result with the factCheckVerdict (the ctx is complete)', async () => {
  const { repoRoot, domainsPath } = Fx.fixture();
  const task = Fx.task();
  const outcomes = [];
  const result = await reviewTask.reviewTask(task, { repoRoot, domainsPath, pipelineDir: '/p', recordModelOutcome: (o) => outcomes.push(o), localMajorityVote: Fx.approve(),
    findUndefinedFn: () => ({ considered: 1, unknown: 0, uses: [{ file: 'src/a.js', name: 'GONE', lines: [{ line: 3, text: 'use(GONE)' }] }] }),
    findInertFn: () => ({ inert: [] }), findOverlapFn: () => ({ overlaps: [] }), findSkipPathsFn: () => ({ paths: [] }) });
  assert.equal(result.verdict, 'blocked');
  assert.equal(result.blockedStage, 'review');
  assert.ok(result.factCheckVerdict);
  assert.equal(task.reviewProvider, 'deterministic-undefined-after-removal');
  assert.equal(outcomes[0].outcome, 'rejected');
});

test('skipPathCheck records the finding on the task and never blocks; it is skipped by its switch', () => {
  const task = Fx.task();
  const found = { paths: [{ kind: 'return-early', file: 'src/a.js', line: 2, text: 'return;' }] };
  assert.equal(advisory.skipPathCheck({ task, findSkipPathsFn: () => found }), null);
  assert.equal(task.skipPaths.total, 1);
  const saved = process.env.AGENT_MANAGER_REVIEW_SKIPPATH_RULE;
  process.env.AGENT_MANAGER_REVIEW_SKIPPATH_RULE = 'false';
  try {
    const other = Fx.task();
    let called = 0;
    advisory.skipPathCheck({ task: other, findSkipPathsFn: () => { called += 1; return found; } });
    assert.equal(called, 0);
  } finally {
    if (saved === undefined) delete process.env.AGENT_MANAGER_REVIEW_SKIPPATH_RULE;
    else process.env.AGENT_MANAGER_REVIEW_SKIPPATH_RULE = saved;
  }
});

test('runAdvisoryChecks runs the six checks and returns null for a task with nothing to report', () => {
  const task = Fx.task();
  const none = () => ({ inert: [], overlaps: [], uses: [], paths: [] });
  assert.equal(advisory.runAdvisoryChecks({ task, repoRoot: '/nonexistent', factCheckVerdict: 'pass', recordModelOutcome: () => {},
    findInertFn: none, findOverlapFn: none, findUndefinedFn: none, findSkipPathsFn: none }), null);
});

test('review-task.js still exports the same helpers that moved', () => {
  for (const name of ['INERT_MAX_ITEMS', 'summariseInertAdditions', 'summariseSkipPaths', 'summariseUndefinedRemoval', 'undefinedRemovalBlockReason', 'editsOfImplementResponse']) {
    assert.strictEqual(reviewTask[name], advisory[name], name);
  }
});

test('the advisory module does not require review-task.js (no import cycle)', () => {
  const { buildGraph } = require('../scripts/import-cycles.js');
  const graph = buildGraph(path.join(__dirname, '..'));
  assert.equal(graph.all['src/review-advisory-checks.js'].includes('src/review-task.js'), false);
});

test('editsOfImplementResponse reads a fenced or bare edit array and returns null for anything else', () => {
  const edit = { mode: 'edit', file: 'src/a.js', find: 'a', replace: 'b' };
  assert.deepEqual(advisory.editsOfImplementResponse({ implementResponse: JSON.stringify([edit]) }), [edit]);
  assert.deepEqual(advisory.editsOfImplementResponse({ implementResponse: `\`\`\`json\n${JSON.stringify(edit)}\n\`\`\`` }), [edit]);
  assert.equal(advisory.editsOfImplementResponse({ implementResponse: 'plain prose' }), null);
  assert.equal(advisory.editsOfImplementResponse({ implementResponse: '[{"mode":"edit"}]' }), null);
  assert.equal(advisory.editsOfImplementResponse(null), null);
});
