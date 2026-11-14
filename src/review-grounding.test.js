'use strict';

// review-grounding.js: the grounding + fact-check stage moved out of runReview (P6.3b). Unit tests per function, plus end-to-end calls
// through reviewTask() that pin the arguments the call site passes (a missing argument is swallowed by the stage's try/catch blocks).

process.env.AGENT_MANAGER_REPO_ROOT = process.env.AGENT_MANAGER_REPO_ROOT || require('node:os').tmpdir();
process.env.AGENT_MANAGER_PIPELINE_DIR = process.env.AGENT_MANAGER_PIPELINE_DIR || require('node:os').tmpdir();

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const grounding = require('./review-grounding.js');
const reviewTask = require('./review-task.js');
const { clearRegistry, registerTaskSource } = require('./task-source-registry.js');

class Fx {
  static task(over = {}) {
    return { id: 'rg-1', domain: 'default', source: 'trouble_log', title: 't', planResponse: 'p', implementResponse: 'Nothing cited here.', history: [], promptContext: {}, ...over };
  }

  static fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-grounding-'));
    const repoRoot = path.join(dir, 'repo');
    const secondBrainDir = path.join(dir, 'sb');
    const pipelineDir = path.join(dir, 'pipeline');
    for (const d of [repoRoot, secondBrainDir, pipelineDir]) fs.mkdirSync(d);
    const domainsPath = path.join(dir, 'task-domains.json');
    fs.writeFileSync(domainsPath, JSON.stringify({ default: { workDirKind: 'repoRoot', successCheck: 'git-branch-diff' }, sb: { workDirKind: 'secondBrainDir', successCheck: 'git-branch-diff' } }));
    return { dir, repoRoot, secondBrainDir, pipelineDir, domainsPath };
  }

  static auditLines(pipelineDir) {
    const out = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        for (const line of fs.readFileSync(full, 'utf8').split('\n')) if (line.includes('fact-check-block')) out.push(line);
      }
    };
    walk(pipelineDir);
    return out;
  }
}

test('getWorkDir picks the repo root or the second brain by workDirKind and throws on an unknown kind', () => {
  assert.equal(grounding.getWorkDir({ workDirKind: 'repoRoot' }, { repoRoot: '/r', secondBrainDir: '/s' }), '/r');
  assert.equal(grounding.getWorkDir({ workDirKind: 'secondBrainDir' }, { repoRoot: '/r', secondBrainDir: '/s' }), '/s');
  assert.throws(() => grounding.getWorkDir({ workDirKind: 'nope' }, { repoRoot: '/r', secondBrainDir: '/s' }), /Unknown workDirKind/);
});

test('getDomainConfig returns a known domain and names the file for an unknown one', () => {
  const { domainsPath } = Fx.fixture();
  assert.equal(grounding.getDomainConfig(domainsPath, 'sb').workDirKind, 'secondBrainDir');
  assert.throws(() => grounding.getDomainConfig(domainsPath, 'zzz_not_a_domain'), /Unknown task domain: zzz_not_a_domain/);
});

test('resolveRepoRootForCheck keeps the work dir, and swaps in a deep_dive clone path from the coverage file', () => {
  const { dir } = Fx.fixture();
  assert.equal(grounding.resolveRepoRootForCheck({ task: Fx.task(), workDir: '/w', deepDiveCoveragePath: null }), '/w');
  const cov = path.join(dir, 'coverage.json');
  fs.writeFileSync(cov, JSON.stringify({ projects: { proj1: { clonePath: '/clone/proj1' } } }));
  const dd = Fx.task({ source: 'deep_dive', promptContext: { projectSlug: 'proj1' } });
  assert.equal(grounding.resolveRepoRootForCheck({ task: dd, workDir: '/w', deepDiveCoveragePath: cov }), '/clone/proj1');
  assert.equal(grounding.resolveRepoRootForCheck({ task: Fx.task({ source: 'deep_dive', promptContext: { projectSlug: 'other' } }), workDir: '/w', deepDiveCoveragePath: cov }), '/w');
  assert.equal(grounding.resolveRepoRootForCheck({ task: Fx.task({ source: 'deep_dive', promptContext: { projectSlug: 'proj1' } }), workDir: '/w', deepDiveCoveragePath: path.join(dir, 'missing.json') }), '/w');
});

test('resolveExtraRoots returns nothing when the fact-check root is not the work dir', () => {
  assert.deepEqual(grounding.resolveExtraRoots({ repoRootForCheck: '/clone', workDir: '/w' }), []);
  assert.ok(Array.isArray(grounding.resolveExtraRoots({ repoRootForCheck: '/w', workDir: '/w' })));
});

test('buildGroundingText returns a string and leaves no temp file behind', () => {
  const task = Fx.task({ id: 'rg-tmpfile-check' });
  const text = grounding.buildGroundingText(task);
  assert.equal(typeof text, 'string');
  assert.equal(fs.existsSync(path.join(os.tmpdir(), 'review-grounding-rg-tmpfile-check.json')), false);
});

test('preValidationGate blocks a fabricated cited path for a source that registers it, logs to the pipeline dir and records the outcome', () => {
  const { repoRoot, pipelineDir } = Fx.fixture();
  clearRegistry();
  registerTaskSource('rg_pre', { priority: 5, next: () => null, preValidateCitedPaths: true });
  const outcomes = [];
  const task = Fx.task({ id: 'rg-pre', source: 'rg_pre', abCallId: 'call-9', implementResponse: 'The bug is in `src/definitely/not/here.js` line 12.' });
  const early = grounding.preValidationGate({ task, repoRootForCheck: repoRoot, factCheckExtraRoots: [], pipelineDir, recordModelOutcome: (o) => outcomes.push(o) });
  clearRegistry();
  assert.equal(early.verdict, 'blocked');
  assert.equal(early.factCheckVerdict, 'skipped');
  assert.match(early.blockedReason, /^ungrounded draft: fabricated file path -- pre-validation:/);
  assert.equal(task.reviewProvider, 'deterministic-pre-validation');
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].callId, 'call-9');
  assert.equal(outcomes[0].outcome, 'rejected');
  assert.equal(Fx.auditLines(pipelineDir).length, 1);
});

test('preValidationGate passes a source that does not register the pre-validation', () => {
  const { repoRoot, pipelineDir } = Fx.fixture();
  clearRegistry();
  registerTaskSource('rg_plain', { priority: 5, next: () => null });
  const task = Fx.task({ source: 'rg_plain', implementResponse: 'See `src/definitely/not/here.js`.' });
  assert.equal(grounding.preValidationGate({ task, repoRootForCheck: repoRoot, factCheckExtraRoots: [], pipelineDir, recordModelOutcome: () => {} }), null);
  clearRegistry();
});

test('prepareFactCheck returns the fact-check, its verdict label and the values the vote needs', () => {
  const f = Fx.fixture();
  clearRegistry();
  const out = grounding.prepareFactCheck({ task: Fx.task(), repoRoot: f.repoRoot, secondBrainDir: f.secondBrainDir, domainsPath: f.domainsPath, deepDiveCoveragePath: null, pipelineDir: f.pipelineDir, recordModelOutcome: () => {} });
  assert.equal(out.early, undefined);
  assert.equal(out.factCheckVerdict, 'pass');
  assert.equal(out.repoRootForCheck, f.repoRoot);
  assert.equal(typeof out.groundingText, 'string');
  assert.equal(out.groundingRef, null);
  assert.ok(Array.isArray(out.factCheck.flags));
});

test('prepareFactCheck uses the second brain as the root for a secondBrainDir domain', () => {
  const f = Fx.fixture();
  clearRegistry();
  const out = grounding.prepareFactCheck({ task: Fx.task({ domain: 'sb' }), repoRoot: f.repoRoot, secondBrainDir: f.secondBrainDir, domainsPath: f.domainsPath, deepDiveCoveragePath: null, pipelineDir: f.pipelineDir, recordModelOutcome: () => {} });
  assert.equal(out.repoRootForCheck, f.secondBrainDir);
});

test('end to end through reviewTask: the pre-validation block reaches the caller and logs under the pipelineDir runReview was given', async () => {
  const f = Fx.fixture();
  clearRegistry();
  registerTaskSource('rg_e2e', { priority: 5, next: () => null, preValidateCitedPaths: true });
  const outcomes = [];
  const result = await reviewTask.reviewTask(Fx.task({ id: 'rg-e2e', source: 'rg_e2e', abCallId: 'call-e2e', implementResponse: 'The bug is in `src/definitely/not/here.js` line 12.' }), {
    repoRoot: f.repoRoot, secondBrainDir: f.secondBrainDir, domainsPath: f.domainsPath, pipelineDir: f.pipelineDir,
    recordModelOutcome: (o) => outcomes.push(o), localMajorityVote: async () => { throw new Error('no vote expected'); },
  });
  clearRegistry();
  assert.equal(result.verdict, 'blocked');
  assert.match(result.blockedReason, /^ungrounded draft: fabricated file path/);
  assert.equal(outcomes.some((o) => o.callId === 'call-e2e' && o.outcome === 'rejected'), true);
  assert.equal(Fx.auditLines(f.pipelineDir).length, 1);
});

test('end to end through reviewTask: a clean draft passes the grounding stage and its fact-check verdict reaches the result', async () => {
  const f = Fx.fixture();
  clearRegistry();
  registerTaskSource('rg_pass', { priority: 5, next: () => null });
  const result = await reviewTask.reviewTask(Fx.task({ id: 'rg-pass', source: 'rg_pass' }), {
    repoRoot: f.repoRoot, secondBrainDir: f.secondBrainDir, domainsPath: f.domainsPath, pipelineDir: f.pipelineDir, recordModelOutcome: () => {},
    localMajorityVote: async () => { throw new Error('no vote expected'); },
  });
  clearRegistry();
  // A later deterministic gate stops this trivial draft; the verdict label it carries is the one prepareFactCheck computed.
  assert.equal(result.factCheckVerdict, 'pass');
  assert.equal(Fx.auditLines(f.pipelineDir).length, 0);
});

test('prepareFactCheck labels a draft with a real flag "flagged" (not only imprecise-path notes)', () => {
  const f = Fx.fixture();
  clearRegistry();
  const draft = JSON.stringify({ mode: 'edit', file: 'src/definitely/missing-file.js', find: 'a', replace: 'b' });
  const out = grounding.prepareFactCheck({ task: Fx.task({ implementResponse: draft }), repoRoot: f.repoRoot, secondBrainDir: f.secondBrainDir, domainsPath: f.domainsPath, deepDiveCoveragePath: null, pipelineDir: f.pipelineDir, recordModelOutcome: () => {} });
  assert.ok(out.factCheck.flags.some((x) => x.type !== 'imprecise-file-path'), JSON.stringify(out.factCheck.flags));
  assert.equal(out.factCheckVerdict, 'flagged');
});

test('prepareFactCheck resolves the stacked grounding ref from the shared branch on origin', () => {
  const { execFileSync } = require('node:child_process');
  const f = Fx.fixture();
  const remote = path.join(f.dir, 'remote.git');
  const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' });
  git(f.dir, 'init', '--bare', '-q', remote);
  git(f.repoRoot, 'init', '-q', '-b', 'main');
  git(f.repoRoot, 'config', 'user.email', 't@t'); git(f.repoRoot, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(f.repoRoot, 'a.txt'), 'x');
  git(f.repoRoot, 'add', '.'); git(f.repoRoot, 'commit', '-qm', 'c');
  git(f.repoRoot, 'remote', 'add', 'origin', remote);
  git(f.repoRoot, 'push', '-q', 'origin', 'main:agent/stk-branch');
  clearRegistry();
  const base = { repoRoot: f.repoRoot, secondBrainDir: f.secondBrainDir, domainsPath: f.domainsPath, deepDiveCoveragePath: null, pipelineDir: f.pipelineDir, recordModelOutcome: () => {} };
  const stacked = grounding.prepareFactCheck({ ...base, task: Fx.task({ stacked: { branch: 'agent/stk-branch', seq: 2, total: 3 } }) });
  assert.equal(stacked.groundingRef, 'agent/stk-branch');
  assert.equal(grounding.prepareFactCheck({ ...base, task: Fx.task() }).groundingRef, null);
});

test('end to end through reviewTask: a deep_dive draft is checked against the clone path from the coverage file runReview was given', async () => {
  const f = Fx.fixture();
  const clone = path.join(f.dir, 'clone');
  fs.mkdirSync(path.join(clone, 'src'), { recursive: true });
  fs.writeFileSync(path.join(clone, 'src', 'real-in-clone.js'), 'module.exports = 1;\n');
  const cov = path.join(f.dir, 'coverage.json');
  fs.writeFileSync(cov, JSON.stringify({ projects: { projx: { clonePath: clone } } }));
  const task = () => Fx.task({ id: 'rg-dd', source: 'deep_dive', promptContext: { projectSlug: 'projx' }, implementResponse: 'The bug is in `src/real-in-clone.js` line 1.' });
  const run = async (deepDiveCoveragePath) => {
    clearRegistry();
    registerTaskSource('deep_dive', { priority: 5, next: () => null, preValidateCitedPaths: true });
    const r = await reviewTask.reviewTask(task(), { repoRoot: f.repoRoot, secondBrainDir: f.secondBrainDir, domainsPath: f.domainsPath, pipelineDir: f.pipelineDir, deepDiveCoveragePath,
      recordModelOutcome: () => {}, localMajorityVote: async () => { throw new Error('no vote expected'); } });
    clearRegistry();
    return r;
  };
  assert.doesNotMatch(String((await run(cov)).blockedReason), /^ungrounded draft: fabricated file path/);
  assert.match(String((await run(undefined)).blockedReason), /^ungrounded draft: fabricated file path/);
});

test('the grounding module does not require review-task.js (no import cycle)', () => {
  const { buildGraph } = require('../scripts/import-cycles.js');
  const graph = buildGraph(path.join(__dirname, '..'));
  assert.equal(graph.all['src/review-grounding.js'].includes('src/review-task.js'), false);
});
