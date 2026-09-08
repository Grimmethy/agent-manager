'use strict';

// Unit tests for git-runner.js's REAL adapter (createRealGitRunner), run against a real
// throwaway git repo + bare "origin" in a temp dir -- never against this package's own
// repo. createFakeGitRunner is exercised elsewhere (apply-task.test.js) since it's a pure
// call-log with no real git involved, but the real adapter itself had zero coverage until
// now, despite being the single highest-consequence path in this package: resetToMain()'s
// `git reset --hard` has silently destroyed real uncommitted work twice in one session
// (see docs/pipeline-incident-2026-07-19.md and its 2026-07-21 repeat). This file exists
// specifically to prove the auto-stash safeguard added for the second incident actually
// works against real git, not just that it reads correctly.
//
// Run: node --test src/git-runner.test.js  (or `npm test`)

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { createRealGitRunner, detectDefaultBranch } = require('./git-runner.js');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

// Real bare "origin" + a real clone, with one committed file -- the minimum real-git
// fixture resetToMain() actually needs (a fetchable origin/<branch> ref to reset onto).
function makeRepoWithOrigin() {
  const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-runner-test-origin-'));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-runner-test-repo-'));
  git(['init', '--bare', '-b', 'main', bareDir]);
  git(['clone', bareDir, repoDir]);
  git(['config', 'user.email', 'test@example.com'], repoDir);
  git(['config', 'user.name', 'Test'], repoDir);
  // These tests assert on exact file content round-tripping through stash/checkout --
  // Windows git's core.autocrlf otherwise silently rewrites LF to CRLF on checkout,
  // which is real git behavior but irrelevant noise for what's being verified here.
  git(['config', 'core.autocrlf', 'false'], repoDir);
  fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'v1\n');
  git(['add', 'tracked.txt'], repoDir);
  git(['commit', '-m', 'init'], repoDir);
  git(['push', 'origin', 'main'], repoDir);
  return { bareDir, repoDir };
}

test('detectDefaultBranch resolves the real default branch from origin refs', () => {
  const { repoDir } = makeRepoWithOrigin();
  assert.equal(detectDefaultBranch(repoDir), 'main');
});

test('resetToMain resets a clean working tree onto origin with no stash created', () => {
  const { repoDir } = makeRepoWithOrigin();
  const runner = createRealGitRunner(repoDir);

  runner.resetToMain();

  const stashList = git(['stash', 'list'], repoDir);
  assert.equal(stashList.trim(), '');
  assert.equal(fs.readFileSync(path.join(repoDir, 'tracked.txt'), 'utf8'), 'v1\n');
});

test('resetToMain auto-stashes an uncommitted tracked-file edit instead of destroying it', () => {
  const { repoDir } = makeRepoWithOrigin();
  const runner = createRealGitRunner(repoDir);

  fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'v1 + uncommitted local edit\n');

  runner.resetToMain();

  // The destructive reset happened -- working tree matches origin, not the edit.
  assert.equal(fs.readFileSync(path.join(repoDir, 'tracked.txt'), 'utf8'), 'v1\n');

  // But the edit was NOT destroyed -- it's sitting in the stash, recoverable.
  const stashList = git(['stash', 'list'], repoDir);
  assert.match(stashList, /agent-manager auto-stash before reset/);

  git(['stash', 'pop'], repoDir);
  assert.equal(fs.readFileSync(path.join(repoDir, 'tracked.txt'), 'utf8'), 'v1 + uncommitted local edit\n');
});

test('resetToMain auto-stashes an untracked file too (stash -u), not just tracked edits', () => {
  const { repoDir } = makeRepoWithOrigin();
  const runner = createRealGitRunner(repoDir);

  fs.writeFileSync(path.join(repoDir, 'untracked.txt'), 'new work in progress\n');

  runner.resetToMain();

  assert.equal(fs.existsSync(path.join(repoDir, 'untracked.txt')), false);

  git(['stash', 'pop'], repoDir);
  assert.equal(fs.readFileSync(path.join(repoDir, 'untracked.txt'), 'utf8'), 'new work in progress\n');
});

// resetToMain: local-only COMMITS on mainBranch -----------------------------------------
// 2026-08-27, root-caused live: unlike the uncommitted-edit case above (protected by the
// auto-stash since the second 2026-07 incident), a real local COMMIT on mainBranch that
// was never pushed got silently discarded by the plain `git reset --hard
// origin/<mainBranch>` -- confirmed live losing 5 real commits in one incident, including
// a same-day critical fix that had to be recovered from the reflog by hand. resetToMain()
// now pushes mainBranch to origin before the hard reset, so a real commit either survives
// (the common case: local was strictly ahead) or the operation fails loudly instead of
// discarding either side (local and origin had genuinely diverged).

test('resetToMain pushes a local-only commit to origin instead of discarding it', () => {
  const { bareDir, repoDir } = makeRepoWithOrigin();
  const runner = createRealGitRunner(repoDir);

  fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'v2 -- a real local fix\n');
  git(['add', 'tracked.txt'], repoDir);
  git(['commit', '-m', 'a real local fix, not yet pushed'], repoDir);
  const localCommit = git(['rev-parse', 'HEAD'], repoDir).trim();

  runner.resetToMain();

  // The commit is not just still present locally -- it actually reached origin, so a
  // FUTURE resetToMain() elsewhere (or a fresh clone) also sees it.
  assert.equal(fs.readFileSync(path.join(repoDir, 'tracked.txt'), 'utf8'), 'v2 -- a real local fix\n');
  const originTip = git(['rev-parse', 'main'], bareDir).trim();
  assert.equal(originTip, localCommit);
});

test('resetToMain throws instead of discarding history when local and origin have genuinely diverged', () => {
  const { bareDir, repoDir } = makeRepoWithOrigin();
  const runner = createRealGitRunner(repoDir);

  // Local commits a fix...
  fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'local fix\n');
  git(['add', 'tracked.txt'], repoDir);
  git(['commit', '-m', 'local fix'], repoDir);

  // ...while origin independently received a DIFFERENT commit in the meantime (e.g. a
  // human pushed straight to GitHub) -- a genuine divergence, not a simple fast-forward.
  const otherClone = fs.mkdtempSync(path.join(os.tmpdir(), 'git-runner-test-other-clone-'));
  git(['clone', bareDir, otherClone]);
  git(['config', 'user.email', 'test@example.com'], otherClone);
  git(['config', 'user.name', 'Test'], otherClone);
  fs.writeFileSync(path.join(otherClone, 'tracked.txt'), 'someone else\'s change\n');
  git(['commit', '-am', 'a different change pushed independently'], otherClone);
  git(['push', 'origin', 'main'], otherClone);

  assert.throws(() => runner.resetToMain(), /diverged/);

  // Neither side got silently thrown away -- the local commit is still right there.
  const log = git(['log', '--oneline', 'main'], repoDir);
  assert.match(log, /local fix/);
});

test('resetToMain fast-forwards when local is simply behind origin (an out-of-band push to master)', () => {
  // Regression: resetToMain() used to `git push origin main:main` unconditionally, which a
  // strictly-behind local fails with a non-fast-forward rejection -- and the catch then
  // mislabeled it "genuinely diverged" and threw, wedging the apply loop crash-looping.
  // A behind local has nothing to preserve; it should just reset forward. (Confirmed live
  // 2026-09-01 after pushing a fix straight to origin/master out of band.)
  const { bareDir, repoDir } = makeRepoWithOrigin();
  const runner = createRealGitRunner(repoDir);

  // Someone pushes a new commit straight to origin/main; this clone knows nothing of it.
  const otherClone = fs.mkdtempSync(path.join(os.tmpdir(), 'git-runner-test-other-clone-'));
  git(['clone', bareDir, otherClone]);
  git(['config', 'user.email', 'test@example.com'], otherClone);
  git(['config', 'user.name', 'Test'], otherClone);
  fs.writeFileSync(path.join(otherClone, 'tracked.txt'), 'v2 pushed out of band\n');
  git(['commit', '-am', 'out-of-band push straight to master'], otherClone);
  git(['push', 'origin', 'main'], otherClone);
  const originTip = git(['rev-parse', 'main'], bareDir).trim();

  assert.doesNotThrow(() => runner.resetToMain());

  assert.equal(git(['rev-parse', 'HEAD'], repoDir).trim(), originTip);
  assert.equal(fs.readFileSync(path.join(repoDir, 'tracked.txt'), 'utf8'), 'v2 pushed out of band\n');
  assert.equal(git(['stash', 'list'], repoDir).trim(), '');
});

test('resetToMain still lands on a real, clean checkout of the default branch', () => {
  const { repoDir } = makeRepoWithOrigin();
  const runner = createRealGitRunner(repoDir);

  fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'dirty\n');
  runner.resetToMain();

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir).trim();
  assert.equal(branch, 'main');
  const status = git(['status', '--porcelain'], repoDir);
  assert.equal(status.trim(), '');
});

// --- stacked file-decompose helpers (apply-task.js stacked branch path) ---------------

test('branchExists / checkoutBranch / checkoutTracking round-trip against a real repo', () => {
  const { repoDir } = makeRepoWithOrigin();
  const runner = createRealGitRunner(repoDir);

  assert.equal(runner.branchExists('agent/decompose-x'), false);
  runner.createBranch('agent/decompose-x');
  fs.writeFileSync(path.join(repoDir, 'step1.txt'), 'move 1\n');
  git(['add', 'step1.txt'], repoDir);
  git(['commit', '-m', 'step 1'], repoDir);
  git(['push', '-u', 'origin', 'agent/decompose-x'], repoDir);
  runner.checkoutMain();

  assert.equal(runner.branchExists('agent/decompose-x'), true);
  assert.doesNotThrow(() => runner.checkoutBranch('agent/decompose-x'));
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir).trim(), 'agent/decompose-x');
  assert.equal(fs.existsSync(path.join(repoDir, 'step1.txt')), true);

  // Local ref gone but origin still has it -> checkoutTracking rebuilds it from origin.
  runner.checkoutMain();
  git(['branch', '-D', 'agent/decompose-x'], repoDir);
  assert.equal(runner.branchExists('agent/decompose-x'), false);
  runner.fetchBranch('agent/decompose-x');
  assert.doesNotThrow(() => runner.checkoutTracking('agent/decompose-x'));
  assert.equal(fs.readFileSync(path.join(repoDir, 'step1.txt'), 'utf8'), 'move 1\n');
});

test('fetchBranch never throws for an unknown branch', () => {
  const { repoDir } = makeRepoWithOrigin();
  const runner = createRealGitRunner(repoDir);
  assert.doesNotThrow(() => runner.fetchBranch('agent/decompose-does-not-exist'));
});

// --- prepareStackedBranch (2026-09-08) --------------------------------------------------
// Grimmethy: "harden it properly with tests" -- root-caused live: the OLD apply-task.js
// logic trusted branchExists(name) (LOCAL-only) as proof a stacked branch was safe to
// check out, with no check that the local copy was actually current. A stale local
// branch -- same name, unrelated ancient content, origin's real copy long since merged
// and deleted -- made every apply attempt check out that stale tree and then fail to
// apply a diff computed against current main, identically, every retry. prepareStackedBranch
// replaces the old branchExists/checkoutBranch/checkoutTracking/try-catch dance with the
// same ahead/behind/diverged discipline resetToMain() already applies to mainBranch
// itself, now applied to a per-hub scratch branch too.

test('prepareStackedBranch: remote exists, no local ref -> syncs from origin', () => {
  const { repoDir } = makeRepoWithOrigin();
  const runner = createRealGitRunner(repoDir);
  runner.createBranch('agent/decompose-x');
  fs.writeFileSync(path.join(repoDir, 'step1.txt'), 'move 1\n');
  git(['add', 'step1.txt'], repoDir);
  git(['commit', '-m', 'step 1'], repoDir);
  git(['push', '-u', 'origin', 'agent/decompose-x'], repoDir);
  runner.checkoutMain();
  git(['branch', '-D', 'agent/decompose-x'], repoDir);

  assert.doesNotThrow(() => runner.prepareStackedBranch('agent/decompose-x'));
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir).trim(), 'agent/decompose-x');
  assert.equal(fs.readFileSync(path.join(repoDir, 'step1.txt'), 'utf8'), 'move 1\n');
});

test('prepareStackedBranch: remote exists, local is behind (⊆ origin) -> resets local to origin\'s tip', () => {
  const { bareDir, repoDir } = makeRepoWithOrigin();
  const runner = createRealGitRunner(repoDir);
  runner.createBranch('agent/decompose-x');
  fs.writeFileSync(path.join(repoDir, 'step1.txt'), 'move 1\n');
  git(['add', 'step1.txt'], repoDir);
  git(['commit', '-m', 'step 1'], repoDir);
  git(['push', '-u', 'origin', 'agent/decompose-x'], repoDir);
  // A second host pushes step 2 to origin; THIS clone's local copy is now behind.
  const otherClone = fs.mkdtempSync(path.join(os.tmpdir(), 'git-runner-test-other-clone-'));
  git(['clone', bareDir, otherClone]);
  git(['config', 'user.email', 'test@example.com'], otherClone);
  git(['config', 'user.name', 'Test'], otherClone);
  git(['fetch', 'origin', 'agent/decompose-x'], otherClone);
  git(['checkout', 'agent/decompose-x'], otherClone);
  fs.writeFileSync(path.join(otherClone, 'step2.txt'), 'move 2\n');
  git(['add', 'step2.txt'], otherClone);
  git(['commit', '-m', 'step 2'], otherClone);
  git(['push', 'origin', 'agent/decompose-x'], otherClone);

  runner.checkoutMain();
  assert.doesNotThrow(() => runner.prepareStackedBranch('agent/decompose-x'));
  assert.equal(fs.existsSync(path.join(repoDir, 'step2.txt')), true, 'local must have synced forward to origin\'s tip');
});

test('prepareStackedBranch: remote exists, local is STRICTLY AHEAD (a prior push failed) -> trusts local, never discards the unpushed commit', () => {
  const { bareDir, repoDir } = makeRepoWithOrigin();
  const runner = createRealGitRunner(repoDir);
  runner.createBranch('agent/decompose-x');
  fs.writeFileSync(path.join(repoDir, 'step1.txt'), 'move 1\n');
  git(['add', 'step1.txt'], repoDir);
  git(['commit', '-m', 'step 1'], repoDir);
  git(['push', '-u', 'origin', 'agent/decompose-x'], repoDir);
  // Step 2 commits locally, but its OWN push never happened (network blip, etc).
  fs.writeFileSync(path.join(repoDir, 'step2.txt'), 'move 2 -- never pushed\n');
  git(['add', 'step2.txt'], repoDir);
  git(['commit', '-m', 'step 2, unpushed'], repoDir);
  const localTip = git(['rev-parse', 'HEAD'], repoDir).trim();
  runner.checkoutMain();

  assert.doesNotThrow(() => runner.prepareStackedBranch('agent/decompose-x'));
  assert.equal(git(['rev-parse', 'agent/decompose-x'], repoDir).trim(), localTip, 'the unpushed commit must not be discarded');
  assert.equal(fs.existsSync(path.join(repoDir, 'step2.txt')), true);
});

test('prepareStackedBranch: remote exists but has diverged from local -> throws, discards neither side', () => {
  const { bareDir, repoDir } = makeRepoWithOrigin();
  const runner = createRealGitRunner(repoDir);
  runner.createBranch('agent/decompose-x');
  fs.writeFileSync(path.join(repoDir, 'step1.txt'), 'move 1\n');
  git(['add', 'step1.txt'], repoDir);
  git(['commit', '-m', 'step 1'], repoDir);
  git(['push', '-u', 'origin', 'agent/decompose-x'], repoDir);
  // Local commits its own step 2...
  fs.writeFileSync(path.join(repoDir, 'step2-local.txt'), 'local version\n');
  git(['add', 'step2-local.txt'], repoDir);
  git(['commit', '-m', 'local step 2'], repoDir);
  const localTip = git(['rev-parse', 'HEAD'], repoDir).trim();
  // ...while a DIFFERENT step 2 landed on origin independently.
  const otherClone = fs.mkdtempSync(path.join(os.tmpdir(), 'git-runner-test-other-clone-'));
  git(['clone', bareDir, otherClone]);
  git(['config', 'user.email', 'test@example.com'], otherClone);
  git(['config', 'user.name', 'Test'], otherClone);
  git(['fetch', 'origin', 'agent/decompose-x'], otherClone);
  git(['checkout', 'agent/decompose-x'], otherClone);
  fs.writeFileSync(path.join(otherClone, 'step2-other.txt'), 'other version\n');
  git(['add', 'step2-other.txt'], otherClone);
  git(['commit', '-m', 'a different step 2, pushed independently'], otherClone);
  git(['push', 'origin', 'agent/decompose-x'], otherClone);
  runner.checkoutMain();

  assert.throws(() => runner.prepareStackedBranch('agent/decompose-x'), /diverged/);
  assert.equal(git(['rev-parse', 'agent/decompose-x'], repoDir).trim(), localTip, 'local commit must still be right there, untouched');
});

// 2026-09-07 real incident + 2026-09-08 fix -- the two scenarios that matter when origin
// no longer has the branch at all (already merged + cleaned up, e.g. GitHub's own
// auto-delete-merged-branches).
test('prepareStackedBranch: no remote copy, local descends from CURRENT main -> trusts local as real unpushed work', () => {
  const { repoDir } = makeRepoWithOrigin();
  const runner = createRealGitRunner(repoDir);
  // Branch off current main, commit, but NEVER push it anywhere.
  runner.createBranch('agent/decompose-x');
  fs.writeFileSync(path.join(repoDir, 'step1.txt'), 'move 1, never pushed\n');
  git(['add', 'step1.txt'], repoDir);
  git(['commit', '-m', 'step 1, never pushed'], repoDir);
  const localTip = git(['rev-parse', 'HEAD'], repoDir).trim();
  runner.checkoutMain();

  assert.doesNotThrow(() => runner.prepareStackedBranch('agent/decompose-x'));
  assert.equal(git(['rev-parse', 'agent/decompose-x'], repoDir).trim(), localTip, 'real never-pushed work must not be discarded');
});

test('prepareStackedBranch: no remote copy AND local is stale (does not descend from current main) -> discards it and starts fresh off main', () => {
  const { bareDir, repoDir } = makeRepoWithOrigin();
  const runner = createRealGitRunner(repoDir);

  // A stale local branch under the SAME name, from an ancient, unrelated point in
  // history -- exactly the incident: a 5-day-old leftover local branch, unrelated
  // content, origin's real copy long since merged and deleted.
  git(['branch', 'agent/decompose-x'], repoDir); // branches off the current (soon-to-be-stale) tip
  const staleTip = git(['rev-parse', 'agent/decompose-x'], repoDir).trim();

  // Main moves forward with real new commits AFTER the stale branch was created.
  fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'v2 -- main moved on\n');
  git(['add', 'tracked.txt'], repoDir);
  git(['commit', '-m', 'main moved on'], repoDir);
  git(['push', 'origin', 'main'], repoDir);
  const newMainTip = git(['rev-parse', 'main'], repoDir).trim();

  assert.doesNotThrow(() => runner.prepareStackedBranch('agent/decompose-x'));
  const finalTip = git(['rev-parse', 'agent/decompose-x'], repoDir).trim();
  assert.notEqual(finalTip, staleTip, 'the stale local branch must be discarded, not trusted');
  assert.equal(finalTip, newMainTip, 'a fresh branch must be created off CURRENT main');
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir).trim(), 'agent/decompose-x');
});

test('prepareStackedBranch: no remote copy and no local branch at all -> creates fresh off main, no delete attempted', () => {
  const { repoDir } = makeRepoWithOrigin();
  const runner = createRealGitRunner(repoDir);
  const mainTip = git(['rev-parse', 'main'], repoDir).trim();

  assert.doesNotThrow(() => runner.prepareStackedBranch('agent/decompose-brand-new'));
  assert.equal(git(['rev-parse', 'agent/decompose-brand-new'], repoDir).trim(), mainTip);
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir).trim(), 'agent/decompose-brand-new');
});

test('remoteBranchExists reflects the real remote-tracking ref, independent of a same-named local branch', () => {
  const { repoDir } = makeRepoWithOrigin();
  const runner = createRealGitRunner(repoDir);
  assert.equal(runner.remoteBranchExists('agent/decompose-x'), false);

  // A local-only branch exists, but origin never got it -- must still read false.
  git(['branch', 'agent/decompose-x'], repoDir);
  assert.equal(runner.remoteBranchExists('agent/decompose-x'), false);

  git(['checkout', 'agent/decompose-x'], repoDir);
  git(['push', '-u', 'origin', 'agent/decompose-x'], repoDir);
  assert.equal(runner.remoteBranchExists('agent/decompose-x'), true);
});
