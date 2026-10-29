'use strict';

// Tests for the "not reproduced" check: review-verify.js checkFailsOnBase (real throwaway git repo, real node:test files, a plain spawn as the runner), the
// small module src/review-repro.js, and its wiring in review-task.js (injected verifier). Nothing touches a live repo or queue.
// Run: node --test src/review-repro.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

process.env.AGENT_MANAGER_REPO_ROOT = os.tmpdir();
process.env.AGENT_MANAGER_PIPELINE_DIR = process.env.AGENT_MANAGER_REPO_ROOT;
process.env.AGENT_MANAGER_REVIEW_EXECUTED_VERIFY = 'false';
process.env.AGENT_MANAGER_REVIEW_INERT_CHECK = 'false';
process.env.AGENT_MANAGER_REVIEW_SKIPPATH_RULE = 'false';
process.env.AGENT_MANAGER_REVIEW_UNDEFINED_CHECK = 'false';
process.env.AGENT_MANAGER_REVIEW_OVERLAP_CHECK = 'false';
require('./task-sources.js');
const { checkFailsOnBase, unapplyPartialDiff } = require('./review-verify.js');
const { applyPartialDiff } = require('./agentic-draft-common.js');
const repro = require('./review-repro.js');
const { reviewTask } = require('./review-task.js');

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function write(repo, rel, text) { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); }

// A repo at `base` files; returns { repo, diffFor(files) } where the diff is what a draft with those files would produce against base.
function makeRepo(baseFiles) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'repro-test-'));
  git(repo, 'init', '-q', '-b', 'main');
  for (const [rel, text] of Object.entries(baseFiles)) write(repo, rel, text);
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'base');
  const diffFor = (files) => {
    git(repo, 'checkout', '-q', '-b', 'draft', 'main');
    for (const [rel, text] of Object.entries(files)) write(repo, rel, text);
    git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'draft');
    const diff = git(repo, 'diff', 'main..draft');
    git(repo, 'checkout', '-q', 'main'); git(repo, 'branch', '-q', '-D', 'draft');
    return diff;
  };
  return { repo, diffFor };
}

// The tree a reviewer has when verification reaches this check: the diff applied in the worktree.
function applied(repo, diff) { const r = applyPartialDiff(repo, diff); assert.equal(r.applied, true, `the draft diff must apply: ${r.reason}`); }
// The nested `node --test` must not inherit NODE_TEST_CONTEXT from the runner executing THIS file (it would report as a child test and exit 0); the review sandbox has a clean env.
const cleanEnv = () => { const e = { ...process.env }; delete e.NODE_TEST_CONTEXT; return e; };
const realRun = ({ worktreeDir, bin, args, timeoutMs, cwd }) => {
  const r = spawnSync(bin === 'python' ? 'python3' : process.execPath, args, { cwd: cwd ? path.join(worktreeDir, cwd) : worktreeDir, encoding: 'utf8', timeout: timeoutMs, env: cleanEnv() });
  const timedOut = !!(r.error && r.error.code === 'ETIMEDOUT');
  return { ran: true, exitCode: timedOut ? null : (typeof r.status === 'number' ? r.status : 1), timedOut, output: `${r.stdout || ''}${r.stderr || ''}` };
};
const D = { unapplyDiff: unapplyPartialDiff, applyDiff: applyPartialDiff };
const jsSuite = (files) => [{ label: 'js', bin: 'node', buildArgs: (f) => ['--test', ...f], files, parse: (out) => [...String(out).matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]) }];
const check = (repo, diff, suites, extra = {}) => checkFailsOnBase({ worktreeDir: repo, rawDiff: diff, suites, run: realRun, d: { ...D, ...(extra.d || {}) }, deadline: Date.now() + 120000, py: null, repoRoot: repo, ...(extra.run ? { run: extra.run } : {}) });

const BUGGY = "'use strict';\nfunction inc(x) { return x; }\nmodule.exports = { inc };\n";
const FIXED = "'use strict';\nfunction inc(x) { return x + 1; }\nmodule.exports = { inc };\n";
const GUARDED = "'use strict';\nfunction inc(x) { if (x === undefined) { x = 0; } return x + 1; }\nmodule.exports = { inc };\n";
const TEST_HEAD = "'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert/strict');\nconst { inc } = require('./foo.js');\n";
const BASE_TEST = TEST_HEAD + "test('inc exists', () => assert.equal(typeof inc, 'function'));\n";

test('a real bug fix: the added test FAILS on the base -> failedOnBase true, tree restored', () => {
  const { repo, diffFor } = makeRepo({ 'src/foo.js': BUGGY, 'src/foo.test.js': BASE_TEST });
  const diff = diffFor({ 'src/foo.js': FIXED, 'src/foo.test.js': BASE_TEST + "test('inc adds one', () => assert.equal(inc(1), 2));\n" });
  applied(repo, diff);
  const r = check(repo, diff, jsSuite(['src/foo.test.js']));
  assert.deepEqual([r.ran, r.failedOnBase], [true, true]);
  assert.deepEqual(r.tests, ['src/foo.test.js']);
  assert.ok(r.failures.some((f) => /inc adds one/.test(f)), `failures: ${JSON.stringify(r.failures)}`);
  assert.equal(fs.readFileSync(path.join(repo, 'src/foo.js'), 'utf8'), FIXED, 'the production change is put back');
});

test('a guard against a case that cannot happen: the added test PASSES on the base -> failedOnBase false', () => {
  const { repo, diffFor } = makeRepo({ 'src/foo.js': FIXED, 'src/foo.test.js': BASE_TEST });
  const diff = diffFor({ 'src/foo.js': GUARDED, 'src/foo.test.js': BASE_TEST + "test('inc handles a number', () => assert.equal(inc(1), 2));\n" });
  applied(repo, diff);
  const r = check(repo, diff, jsSuite(['src/foo.test.js']));
  assert.deepEqual([r.ran, r.failedOnBase], [true, false]);
  assert.equal(fs.readFileSync(path.join(repo, 'src/foo.js'), 'utf8'), GUARDED);
});

test('not run (never "not reproduced") when there is nothing to compare', () => {
  const { repo, diffFor } = makeRepo({ 'src/foo.js': BUGGY, 'src/foo.test.js': BASE_TEST });
  const noTest = diffFor({ 'src/foo.js': FIXED });
  assert.match(check(repo, noTest, jsSuite([])).reason, /adds no test/);
  const newProd = diffFor({ 'src/bar.js': FIXED, 'src/foo.test.js': BASE_TEST + "test('x', () => {});\n" });
  assert.match(check(repo, newProd, jsSuite(['src/foo.test.js'])).reason, /new production file/);
  const noProd = diffFor({ 'src/foo.test.js': BASE_TEST + "test('only a test', () => {});\n" });
  assert.match(check(repo, noProd, jsSuite(['src/foo.test.js'])).reason, /no production change/);
  const sameTestNames = diffFor({ 'src/foo.js': FIXED, 'src/foo.test.js': BASE_TEST.replace('exists', 'exists too') });
  assert.equal(check(repo, sameTestNames, jsSuite(['src/foo.test.js'])).ran, false);
});

test('a revert that cannot be applied, a timed-out run and a run that cannot start are not-run results', () => {
  const { repo, diffFor } = makeRepo({ 'src/foo.js': BUGGY, 'src/foo.test.js': BASE_TEST });
  const diff = diffFor({ 'src/foo.js': FIXED, 'src/foo.test.js': BASE_TEST + "test('inc adds one', () => assert.equal(inc(1), 2));\n" });
  // tree does NOT have the diff applied, so reverting it fails
  const notApplied = check(repo, diff, jsSuite(['src/foo.test.js']));
  assert.equal(notApplied.ran, false);
  assert.match(notApplied.reason, /could not revert/);
  applied(repo, diff);
  const timedOut = check(repo, diff, jsSuite(['src/foo.test.js']), { run: (a) => (a.args[0] === '--check' ? realRun(a) : { ran: true, timedOut: true, exitCode: null, output: '' }) });
  assert.deepEqual([timedOut.ran, /could not finish/.test(timedOut.reason)], [false, true]);
  const cannotRun = check(repo, diff, jsSuite(['src/foo.test.js']), { run: () => ({ ran: false, reason: 'bwrap sandbox unavailable' }) });
  assert.equal(cannotRun.ran, false);
  assert.equal(fs.readFileSync(path.join(repo, 'src/foo.js'), 'utf8'), FIXED, 'the production change is put back after a not-run result too');
});

test('returns null when the production change cannot be put back', () => {
  const { repo, diffFor } = makeRepo({ 'src/foo.js': BUGGY, 'src/foo.test.js': BASE_TEST });
  const diff = diffFor({ 'src/foo.js': FIXED, 'src/foo.test.js': BASE_TEST + "test('inc adds one', () => assert.equal(inc(1), 2));\n" });
  applied(repo, diff);
  assert.equal(check(repo, diff, jsSuite(['src/foo.test.js']), { d: { applyDiff: () => ({ applied: false }) } }), null);
});

// --- review-repro.js -----------------------------------------------------------------------------------------------------------------------------
const FAILED_ON_BASE = { ran: true, failedOnBase: true, tests: ['src/foo.test.js'], failures: ['inc adds one'] };
const PASSED_ON_BASE = { ran: true, failedOnBase: false, tests: ['src/foo.test.js'], failures: [] };

test('mode and wantsRepro: brain-dump-derived, not a hub slice, not switched off', () => {
  assert.equal(repro.mode({}), 'advisory');
  assert.equal(repro.mode({ AGENT_MANAGER_REVIEW_REPRO_CHECK: 'block' }), 'block');
  assert.equal(repro.mode({ AGENT_MANAGER_REVIEW_REPRO_CHECK: 'false' }), 'false');
  const bd = { promptContext: { brainDumpEntryId: 'bd-1' } };
  assert.equal(repro.wantsRepro(bd, { env: {} }), true);
  assert.equal(repro.wantsRepro({ promptContext: {} }, { env: {} }), false);
  assert.equal(repro.wantsRepro(null, { env: {} }), false);
  assert.equal(repro.wantsRepro(bd, { hubChild: true, env: {} }), false);
  assert.equal(repro.wantsRepro(bd, { env: { AGENT_MANAGER_REVIEW_REPRO_CHECK: 'false' } }), false);
});

test('summary, blockReason (block mode and not-reproduced only) and the voter section', () => {
  assert.equal(repro.summariseRepro(null), null);
  assert.deepEqual(repro.summariseRepro({ ran: false, reason: 'x'.repeat(500) }).reason.length, 200);
  assert.equal(repro.blockReason(PASSED_ON_BASE, {}), '', 'advisory never blocks');
  assert.equal(repro.blockReason(FAILED_ON_BASE, { AGENT_MANAGER_REVIEW_REPRO_CHECK: 'block' }), '', 'a reproduced defect never blocks');
  assert.equal(repro.blockReason({ ran: false, reason: 'no test' }, { AGENT_MANAGER_REVIEW_REPRO_CHECK: 'block' }), '', 'a not-run result never blocks');
  assert.match(repro.blockReason(PASSED_ON_BASE, { AGENT_MANAGER_REVIEW_REPRO_CHECK: 'block' }), /defect not reproduced.*src\/foo\.test\.js/);
  assert.match(repro.formatReproSection(PASSED_ON_BASE), /still PASS on the base/);
  assert.match(repro.formatReproSection(FAILED_ON_BASE), /FAIL on the base \(inc adds one\)/);
  for (const none of [null, undefined, {}, { ran: false, reason: 'x' }]) assert.equal(repro.formatReproSection(none), '');
});

// --- wiring in review-task.js ----------------------------------------------------------------------------------------------------------------------
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repro-review-test-'));
  const repoRoot = path.join(dir, 'repo'); fs.mkdirSync(repoRoot, { recursive: true });
  const domainsPath = path.join(dir, 'task-domains.json');
  fs.writeFileSync(domainsPath, JSON.stringify({ default: { workDirKind: 'repoRoot', successCheck: 'git-branch-diff' } }));
  return { repoRoot, domainsPath };
}
function task(overrides = {}) {
  return {
    id: 'repro-task', domain: 'default', source: 'manual', title: 'Fix the thing', planResponse: '1. Fix.', adhocResolution: 'implemented',
    implementResponse: '{"mode":"edit","file":"foo.js","find":"doThing()","replace":"if (ok) doThing()"}',
    acceptanceCriteria: ['it works'], acceptanceResults: [{ criterion: 'it works', check: '`node --test src/a.test.js`', result: 'PASS', pass: true }],
    rawDiff: 'diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n-a\n+b\n',
    promptContext: { brainDumpEntryId: 'bd-1' }, ...overrides,
  };
}
const approve = (captured) => async ({ prompt }) => { captured.push(prompt); return { confident: true, verdict: 'APPROVE', votes: [{ verdict: 'APPROVE', reasoning: 'looks correct and complete' }], realVoteCount: 3, requestedVotes: 3 }; };
const passedWith = (rp) => (args) => { passedWith.seen = args; return { status: 'passed', reasons: [], tests: { ran: ['src/a.test.js'], passed: true, failures: [] }, commands: [], ...(rp ? { repro: rp } : {}) }; };
async function withEnv(vars, fn) {
  const prev = {}; for (const k of Object.keys(vars)) { prev[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { await fn(); } finally { for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } }
}

test('advisory: the check is requested for a brain-dump task, recorded, noted in the history, shown to the voters, and the vote still happens', async () => {
  await withEnv({ AGENT_MANAGER_REVIEW_EXECUTED_VERIFY: 'true', AGENT_MANAGER_REVIEW_REPRO_CHECK: undefined }, async () => {
    const { repoRoot, domainsPath } = fixture(); const t = task(); const captured = [];
    const result = await reviewTask(t, { repoRoot, domainsPath, localMajorityVote: approve(captured), recordModelOutcome: () => {}, verifyDiffFn: passedWith(PASSED_ON_BASE) });
    assert.equal(result.verdict, 'approved');
    assert.equal(passedWith.seen.checkRepro, true);
    assert.deepEqual(t.executedVerification.repro, { ran: true, failedOnBase: false, tests: ['src/foo.test.js'], failures: [] });
    assert.match(t.history.find((h) => h.stage === 'advisory' && /repro check/.test(h.detail)).detail, /PASS without its production change.*not reproduced/);
    assert.equal(captured.length, 1);
    assert.match(captured[0], /Defect reproduction \(deterministic check; advisory\)/);
    assert.match(captured[0], /still PASS on the base/);
  });
});

test('block mode: the new tests passing on the base is a deterministic block, a reproduced defect is not', async () => {
  await withEnv({ AGENT_MANAGER_REVIEW_EXECUTED_VERIFY: 'true', AGENT_MANAGER_REVIEW_REPRO_CHECK: 'block' }, async () => {
    const a = fixture(); const t1 = task({ id: 'repro-block' }); const cap1 = [];
    const r1 = await reviewTask(t1, { repoRoot: a.repoRoot, domainsPath: a.domainsPath, localMajorityVote: approve(cap1), recordModelOutcome: () => {}, verifyDiffFn: passedWith(PASSED_ON_BASE) });
    assert.equal(r1.verdict, 'blocked');
    assert.equal(r1.blockedStage, 'review');
    assert.match(r1.blockedReason, /defect not reproduced/);
    assert.equal(cap1.length, 0, 'no vote spent');
    assert.equal(t1.reviewProvider, 'deterministic-repro-check');
    const b = fixture(); const t2 = task({ id: 'repro-pinned' }); const cap2 = [];
    const r2 = await reviewTask(t2, { repoRoot: b.repoRoot, domainsPath: b.domainsPath, localMajorityVote: approve(cap2), recordModelOutcome: () => {}, verifyDiffFn: passedWith(FAILED_ON_BASE) });
    assert.equal(r2.verdict, 'approved');
    const c = fixture(); const t3 = task({ id: 'repro-notrun' }); const cap3 = [];
    const r3 = await reviewTask(t3, { repoRoot: c.repoRoot, domainsPath: c.domainsPath, localMajorityVote: approve(cap3), recordModelOutcome: () => {}, verifyDiffFn: passedWith({ ran: false, reason: 'the diff adds no test' }) });
    assert.equal(r3.verdict, 'approved');
    assert.deepEqual(t3.executedVerification.repro, { ran: false, reason: 'the diff adds no test' });
  });
});

test('the check is not requested for a task without a brain-dump entry, for a hub slice, or when switched off', async () => {
  await withEnv({ AGENT_MANAGER_REVIEW_EXECUTED_VERIFY: 'true', AGENT_MANAGER_REVIEW_REPRO_CHECK: undefined }, async () => {
    for (const [label, overrides, env] of [['plain', { promptContext: {} }, undefined], ['hub', { stacked: { branch: 'agent/decompose-x', seq: 2, total: 2 }, dependsOn: ['HUB0001-01-a'] }, undefined], ['off', {}, 'false']]) {
      process.env.AGENT_MANAGER_REVIEW_REPRO_CHECK = env === undefined ? '' : env;
      if (env === undefined) delete process.env.AGENT_MANAGER_REVIEW_REPRO_CHECK;
      const { repoRoot, domainsPath } = fixture(); passedWith.seen = null;
      await reviewTask(task({ id: `repro-${label}`, ...overrides }), { repoRoot, domainsPath, localMajorityVote: approve([]), recordModelOutcome: () => {}, verifyDiffFn: passedWith(null) });
      assert.ok(passedWith.seen, `${label}: the verifier ran`);
      assert.notEqual(passedWith.seen.checkRepro, true, `${label}: checkRepro must not be requested`);
    }
  });
});
