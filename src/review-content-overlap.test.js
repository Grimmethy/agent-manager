'use strict';

// Tests for the content-overlap check (src/review-content-overlap.js) and its wiring in review-task.js.
// The finder tests build throwaway git repos in the OS temp dir (real commits, real diffs, remote-tracking refs made with update-ref); nothing touches a live
// repo or queue. Run: node --test src/review-content-overlap.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// Same load-time setup as review-task.test.js (review-task.js reads these at require time).
process.env.AGENT_MANAGER_REPO_ROOT = os.tmpdir();
process.env.AGENT_MANAGER_PIPELINE_DIR = process.env.AGENT_MANAGER_REPO_ROOT;
process.env.AGENT_MANAGER_REVIEW_EXECUTED_VERIFY = 'false';
process.env.AGENT_MANAGER_REVIEW_INERT_CHECK = 'false';
process.env.AGENT_MANAGER_REVIEW_SKIPPATH_RULE = 'false';
process.env.AGENT_MANAGER_REVIEW_UNDEFINED_CHECK = 'false';
require('./task-sources.js');
const { findContentOverlap, summariseContentOverlap, formatContentOverlapSection, contentOverlapBlockReason } = require('./review-content-overlap.js');
const { reviewTask } = require('./review-task.js');

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function write(repo, rel, text) { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); }
const body = (n, tag = 'v') => Array.from({ length: n }, (_, i) => `const ${tag}${i} = compute(${i}, 'value-${i}');`).join('\n') + '\n';

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'overlap-test-'));
  git(repo, 'init', '-q', '-b', 'main');
  write(repo, 'src/existing.js', body(10, 'base'));
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'base');
  return repo;
}
// A remote-tracking branch `origin/<name>` ahead of main with the given files.
function remoteBranch(repo, name, files) {
  git(repo, 'checkout', '-q', '-b', 'tmp-' + name.replace(/\W/g, '-'), 'main');
  for (const [rel, text] of Object.entries(files)) write(repo, rel, text);
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', name);
  git(repo, 'update-ref', `refs/remotes/origin/${name}`, 'HEAD');
  git(repo, 'checkout', '-q', 'main');
}
// The unified diff a draft would produce: main..(main + files).
function diffOf(repo, files) {
  git(repo, 'checkout', '-q', '-b', 'tmp-draft', 'main');
  for (const [rel, text] of Object.entries(files)) write(repo, rel, text);
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'draft');
  const diff = git(repo, 'diff', 'main..tmp-draft');
  git(repo, 'checkout', '-q', 'main'); git(repo, 'branch', '-q', '-D', 'tmp-draft');
  return diff;
}
const run = (repo, diff, extra = {}) => findContentOverlap({ rawDiff: diff, repoRoot: repo, baseRef: 'main', ...extra });

test('a new file identical to one on another unmerged branch (different path, same basename) -> identical-file', () => {
  const repo = makeRepo();
  remoteBranch(repo, 'hub-stack', { 'lib/drive_log.py': body(12, 'log') });
  const diff = diffOf(repo, { 'drive_log.py': body(12, 'log') });
  const r = run(repo, diff);
  assert.equal(r.overlaps.length, 1);
  assert.deepEqual([r.overlaps[0].how, r.overlaps[0].ratio, r.overlaps[0].ref, r.overlaps[0].otherFile], ['identical-file', 1, 'origin/hub-stack', 'lib/drive_log.py']);
  assert.equal(r.checkedRefs, 1);
});

test('added lines: 90% shared with another branch counts, 50% does not', () => {
  const repo = makeRepo();
  const ten = body(10, 'n');
  const nineShared = ten.split('\n').slice(0, 9).join('\n') + "\nconst different = other();\n";
  remoteBranch(repo, 'rival-90', { 'src/feature.js': nineShared });
  remoteBranch(repo, 'rival-50', { 'src/feature2.js': ten.split('\n').slice(0, 5).join('\n') + '\n' + body(5, 'z') });
  const r1 = run(repo, diffOf(repo, { 'src/feature.js': ten }));
  assert.equal(r1.overlaps.length, 1);
  assert.deepEqual([r1.overlaps[0].how, r1.overlaps[0].ref, r1.overlaps[0].ratio], ['added-lines', 'origin/rival-90', 0.9]);
  const r2 = run(repo, diffOf(repo, { 'src/feature2.js': ten }));
  assert.deepEqual(r2.overlaps, []);
});

test('a new file identical to a file already on the base is reported against the base', () => {
  const repo = makeRepo();
  const diff = diffOf(repo, { 'copy/existing.js': body(10, 'base') });
  const r = run(repo, diff);
  assert.equal(r.overlaps.length, 1);
  assert.deepEqual([r.overlaps[0].how, r.overlaps[0].ref, r.overlaps[0].otherFile], ['identical-file', 'main', 'src/existing.js']);
});

test('the task\'s own ref, merged branches, test files, docs and tiny diffs are ignored', () => {
  const repo = makeRepo();
  remoteBranch(repo, 'agent/mine', { 'src/mine.js': body(12, 'm') });
  remoteBranch(repo, 'other', { 'tests/test_x.py': body(12, 't'), 'docs/notes.md': body(12, 'd'), 'src/tiny.js': body(4, 'y') });
  git(repo, 'update-ref', 'refs/remotes/origin/already-merged', 'main');
  const own = run(repo, diffOf(repo, { 'src/mine.js': body(12, 'm') }), { ownRefs: ['origin/agent/mine'] });
  assert.deepEqual(own.overlaps, [], 'own ref excluded');
  assert.deepEqual(run(repo, diffOf(repo, { 'tests/test_x.py': body(12, 't') })).overlaps, [], 'test file ignored');
  assert.deepEqual(run(repo, diffOf(repo, { 'docs/notes.md': body(12, 'd') })).overlaps, [], 'docs ignored');
  assert.deepEqual(run(repo, diffOf(repo, { 'src/tiny.js': body(4, 'y') })).overlaps, [], 'fewer than 8 meaningful lines');
});

test('lines the same diff also removes (a move or reformat) are not counted as a duplicate', () => {
  const repo = makeRepo();
  const moved = body(10, 'base');
  remoteBranch(repo, 'rival', { 'src/existing.js': moved + "const extra = 1 + extraCall();\n" });
  // the draft rewrites existing.js, removing every old line and re-adding the same lines in a new order
  const reordered = moved.split('\n').filter(Boolean).reverse().join('\n') + '\n';
  const r = run(repo, diffOf(repo, { 'src/existing.js': reordered }));
  assert.deepEqual(r.overlaps, []);
});

test('never throws: a missing repo, no base ref and a garbage diff all mean no overlap', () => {
  assert.deepEqual(findContentOverlap({ rawDiff: 'nonsense', repoRoot: '/nonexistent/for/test', baseRef: 'main' }).overlaps, []);
  assert.deepEqual(findContentOverlap({ rawDiff: '', repoRoot: os.tmpdir(), baseRef: null }).overlaps, []);
  assert.deepEqual(findContentOverlap({ rawDiff: diffLike(), repoRoot: '/nonexistent/for/test', baseRef: 'main', git: () => { throw new Error('boom'); } }).overlaps, []);
});
function diffLike() { return 'diff --git a/src/a.js b/src/a.js\nnew file mode 100644\n--- /dev/null\n+++ b/src/a.js\n@@ -0,0 +1,9 @@\n' + body(9, 'q').split('\n').filter(Boolean).map((l) => '+' + l).join('\n') + '\n'; }

// --- wiring in review-task.js (injected finder, like the inert-addition tests) ----------------------------------------------------------------------------
const FOUND = { checkedRefs: 7, overlaps: [{ file: 'drive_log.py', ref: 'origin/hub-stack', how: 'identical-file', ratio: 1, otherFile: 'lib/drive_log.py' }, { file: 'src/feature.js', ref: 'origin/rival-90', how: 'added-lines', ratio: 0.9 }] };

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlap-review-test-'));
  const repoRoot = path.join(dir, 'repo'); fs.mkdirSync(repoRoot, { recursive: true });
  const domainsPath = path.join(dir, 'task-domains.json');
  fs.writeFileSync(domainsPath, JSON.stringify({ default: { workDirKind: 'repoRoot', successCheck: 'git-branch-diff' } }));
  return { repoRoot, domainsPath };
}
function adhocTask(overrides = {}) {
  return {
    id: 'overlap-task', domain: 'default', source: 'manual', title: 'Add a helper', planResponse: '1. Add helper.', implementResponse: '{"mode":"edit","file":"foo.js","find":"doThing()","replace":"if (ok) doThing()"}', adhocResolution: 'implemented',
    acceptanceCriteria: ['the helper works'],
    acceptanceResults: [{ criterion: 'the helper works', check: '`node --test src/a.test.js`', result: 'PASS', pass: true }],
    rawDiff: 'diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n-a\n+b\n',
    ...overrides,
  };
}
const approve = (captured) => async ({ prompt }) => { captured.push(prompt); return { confident: true, verdict: 'APPROVE', votes: [{ verdict: 'APPROVE', reasoning: 'looks correct and complete' }], realVoteCount: 3, requestedVotes: 3 }; };
async function withMode(mode, fn) {
  const prev = process.env.AGENT_MANAGER_REVIEW_OVERLAP_CHECK;
  if (mode === undefined) delete process.env.AGENT_MANAGER_REVIEW_OVERLAP_CHECK; else process.env.AGENT_MANAGER_REVIEW_OVERLAP_CHECK = mode;
  try { await fn(); } finally { if (prev === undefined) delete process.env.AGENT_MANAGER_REVIEW_OVERLAP_CHECK; else process.env.AGENT_MANAGER_REVIEW_OVERLAP_CHECK = prev; }
}

test('advisory (the default): the overlap is recorded, noted in the history and shown to the voters, and the vote still happens', async () => {
  await withMode(undefined, async () => {
    const { repoRoot, domainsPath } = fixture(); const task = adhocTask(); const captured = []; let seen = null;
    const result = await reviewTask(task, { repoRoot, domainsPath, localMajorityVote: approve(captured), recordModelOutcome: () => {}, findOverlapFn: (a) => { seen = a; return FOUND; } });
    assert.equal(result.verdict, 'approved');
    assert.equal(captured.length, 1);
    assert.equal(seen.rawDiff, task.rawDiff);
    assert.deepEqual(seen.ownRefs, ['origin/agent/overlap-task']);
    assert.equal(task.contentOverlap.total, 2);
    assert.match(task.history.find((h) => h.stage === 'advisory' && /content-overlap check/.test(h.detail)).detail, /2 overlap\(s\) \(drive_log\.py <- origin\/hub-stack; src\/feature\.js <- origin\/rival-90\)/);
    assert.match(captured[0], /Content already on another branch or on the base \(deterministic check; advisory\)/);
    assert.match(captured[0], /drive_log\.py is identical to lib\/drive_log\.py on origin\/hub-stack/);
    assert.match(captured[0], /90% of the lines added to src\/feature\.js are also added on origin\/rival-90/);
  });
});

test('block mode: a deterministic blocked verdict names the overlapping refs and no vote is spent', async () => {
  await withMode('block', async () => {
    const { repoRoot, domainsPath } = fixture(); const task = adhocTask({ id: 'overlap-block' }); const captured = [];
    const result = await reviewTask(task, { repoRoot, domainsPath, localMajorityVote: approve(captured), recordModelOutcome: () => {}, findOverlapFn: () => FOUND });
    assert.equal(result.verdict, 'blocked');
    assert.equal(result.blockedStage, 'review');
    assert.match(result.blockedReason, /content overlap/);
    assert.match(result.blockedReason, /origin\/hub-stack/);
    assert.equal(captured.length, 0);
    assert.equal(task.reviewProvider, 'deterministic-content-overlap');
  });
});

test("'false' skips the finder; a task that is not an implemented adhoc diff never reaches it; a finder that throws or returns junk cannot break the review", async () => {
  let calls = 0; const finder = () => { calls += 1; return FOUND; };
  const go = async (task, f = finder) => { const { repoRoot, domainsPath } = fixture(); return reviewTask(task, { repoRoot, domainsPath, localMajorityVote: approve([]), recordModelOutcome: () => {}, findOverlapFn: f }); };
  await withMode('false', async () => { await go(adhocTask({ id: 'ov-off' })); });
  assert.equal(calls, 0);
  await withMode(undefined, async () => {
    await go(adhocTask({ id: 'ov-nodiff', rawDiff: '' }));
    await go(adhocTask({ id: 'ov-notimpl', adhocResolution: 'no-changes-needed' }));
    assert.equal(calls, 0);
    const t1 = adhocTask({ id: 'ov-throws' }); const r1 = await go(t1, () => { throw new Error('git exploded'); });
    const t2 = adhocTask({ id: 'ov-junk' }); const r2 = await go(t2, () => 'nope');
    assert.equal(r1.verdict, 'approved'); assert.equal(r2.verdict, 'approved');
    assert.equal(t1.contentOverlap, undefined); assert.equal(t2.contentOverlap, undefined);
  });
});

test('summary and section: capped, clamped and empty when there is nothing', () => {
  const many = summariseContentOverlap({ checkedRefs: -3, overlaps: Array.from({ length: 9 }, (_, i) => ({ file: `f${i}.js`.padEnd(300, 'x'), ref: 'origin/r', how: 'weird', ratio: 7 })) });
  assert.deepEqual([many.checkedRefs, many.total, many.overlaps.length, many.overlaps[0].how, many.overlaps[0].ratio, many.overlaps[0].file.length], [0, 9, 6, 'added-lines', 1, 160]);
  assert.match(formatContentOverlapSection(many), /\(\+3 more\)/);
  for (const none of [undefined, null, {}, 'x', summariseContentOverlap({ checkedRefs: 4, overlaps: [] })]) assert.equal(formatContentOverlapSection(none), '');
  assert.match(contentOverlapBlockReason(summariseContentOverlap(FOUND)), /re-creates work that already exists elsewhere/);
});
