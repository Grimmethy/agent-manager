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

// 2026-09-14: resetToMain() now pops the auto-stash right back onto the tree after the
// hard reset (see git-runner.js's own header on doResetToMain for why this is safe --
// the dedicated apply worktree it runs against in production is never interactively
// edited, so there's no live human WIP an auto-pop could clobber). These two tests used
// to assert the OLD "stash and never restore" behavior (manually popping themselves at
// the end just to prove the content wasn't destroyed); they now assert the real
// round-trip the fix provides, and the stash list is empty immediately after
// resetToMain() returns -- no manual pop needed, nothing left behind.
test('resetToMain auto-stashes an uncommitted tracked-file edit, then pops it back (round-trip, not a graveyard)', () => {
  const { repoDir } = makeRepoWithOrigin();
  const runner = createRealGitRunner(repoDir);

  fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'v1 + uncommitted local edit\n');

  runner.resetToMain();

  // The destructive reset happened (tree briefly matched origin) AND the edit round-tripped
  // straight back on top of it -- resetToMain() itself is the one place responsible for
  // both halves now, not "reset here, manually pop somewhere else, someday."
  assert.equal(fs.readFileSync(path.join(repoDir, 'tracked.txt'), 'utf8'), 'v1 + uncommitted local edit\n');

  // Nothing left behind -- no abandoned stash entry for a human to ever discover or lose.
  assert.equal(git(['stash', 'list'], repoDir).trim(), '');
});

test('resetToMain auto-stashes an untracked file too (stash -u), then pops it back', () => {
  const { repoDir } = makeRepoWithOrigin();
  const runner = createRealGitRunner(repoDir);

  fs.writeFileSync(path.join(repoDir, 'untracked.txt'), 'new work in progress\n');

  runner.resetToMain();

  assert.equal(fs.readFileSync(path.join(repoDir, 'untracked.txt'), 'utf8'), 'new work in progress\n');
  assert.equal(git(['stash', 'list'], repoDir).trim(), '');
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

test('resetToMain with the explicit ungated opt-in pushes a local-only commit to origin instead of discarding it', () => {
  const { bareDir, repoDir } = makeRepoWithOrigin();
  const savedEnv = process.env.AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH;
  process.env.AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH = 'true';
  const runner = createRealGitRunner(repoDir);

  fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'v2 -- a real local fix\n');
  git(['add', 'tracked.txt'], repoDir);
  git(['commit', '-m', 'a real local fix, not yet pushed'], repoDir);
  const localCommit = git(['rev-parse', 'HEAD'], repoDir).trim();

  try { runner.resetToMain(); } finally { if (savedEnv === undefined) delete process.env.AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH; else process.env.AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH = savedEnv; }

  // The commit is not just still present locally -- it actually reached origin, so a
  // FUTURE resetToMain() elsewhere (or a fresh clone) also sees it.
  assert.equal(fs.readFileSync(path.join(repoDir, 'tracked.txt'), 'utf8'), 'v2 -- a real local fix\n');
  const originTip = git(['rev-parse', 'main'], bareDir).trim();
  assert.equal(originTip, localCommit);
});
test('gated default: resetToMain does NOT push a local-only commit to origin main -- it rescues it to a branch and resets main', () => {
  delete process.env.AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH;
  const { bareDir, repoDir } = makeRepoWithOrigin();
  const originBefore = git(['rev-parse', 'main'], bareDir).trim();
  const runner = createRealGitRunner(repoDir);

  fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'v2 -- a real local fix\n');
  git(['add', 'tracked.txt'], repoDir);
  git(['commit', '-m', 'a real local fix, not yet pushed'], repoDir);
  const localCommit = git(['rev-parse', 'HEAD'], repoDir).trim();

  runner.resetToMain();

  assert.equal(git(['rev-parse', 'main'], bareDir).trim(), originBefore, 'origin main is untouched');
  assert.equal(git(['rev-parse', 'HEAD'], repoDir).trim(), originBefore, 'local main was reset to origin');
  const rescue = git(['branch', '--list', 'agent/rescued-main-*'], repoDir).trim().replace(/^[* ]+/, '');
  assert.ok(rescue, 'a rescue branch exists');
  assert.equal(git(['rev-parse', rescue], repoDir).trim(), localCommit, 'the local commit is preserved on it');
  assert.equal(git(['rev-parse', rescue], bareDir).trim(), localCommit, 'and the rescue BRANCH (not main) was pushed');
});

test('gated default: pushMain refuses outright', () => {
  delete process.env.AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH;
  const { repoDir } = makeRepoWithOrigin();
  assert.throws(() => createRealGitRunner(repoDir).pushMain(), /pushMain refused/);
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

// 2026-09-14: with a genuinely clean starting tree (nothing to stash, nothing to pop
// back), resetToMain() still lands cleanly on the default branch with an empty status --
// the dirty-starting-tree case is covered separately above and, since the auto-pop fix,
// deliberately does NOT end with an empty status (the popped edit is a real modification
// again, not silently discarded).
test('resetToMain lands on a real, clean checkout of the default branch when the tree started clean', () => {
  const { repoDir } = makeRepoWithOrigin();
  const runner = createRealGitRunner(repoDir);

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

test('prepareStackedBranch: remote exists but has diverged from local -> rescues local to a backup branch and resets to origin, discarding nothing', () => {
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
  const otherTip = git(['rev-parse', 'agent/decompose-x'], otherClone).trim();
  runner.checkoutMain();

  assert.doesNotThrow(() => runner.prepareStackedBranch('agent/decompose-x'));
  // The branch itself now matches origin's (the other side's) tip -- the pipeline can keep going.
  assert.equal(git(['rev-parse', 'agent/decompose-x'], repoDir).trim(), otherTip, 'agent/decompose-x resets to origin\'s tip');
  // Local's own unique commit was never dropped -- it lives on a rescue branch, both locally and pushed.
  const rescueBranches = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/agent/decompose-x-rescued-*'], repoDir).trim().split('\n').filter(Boolean);
  assert.equal(rescueBranches.length, 1, 'exactly one rescue branch was created');
  assert.equal(git(['rev-parse', rescueBranches[0]], repoDir).trim(), localTip, 'the rescue branch points at local\'s original tip');
  const remoteRescue = git(['ls-remote', bareDir, `refs/heads/${rescueBranches[0]}`], repoDir).trim();
  assert.ok(remoteRescue.includes(localTip), 'the rescue branch was also pushed to origin');
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

// --- remote copy exists but is itself STALE relative to main (2026-09-22) --------------
// Root-caused live: a rolling branch (TRIAGE_BRANCH) is never explicitly rebased on its
// own (apply-main-batch.js's own header says so) -- every branch of prepareStackedBranch's
// logic above only ever compares LOCAL to REMOTE, never asking whether the REMOTE copy
// itself has fallen behind current main. A human merged the branch (deleting it), but it
// got recreated anchored to a point of main from two days earlier and every apply cycle
// after that just kept stacking onto that same stale lineage -- silently reintroducing
// commits that had ALREADY separately landed on main (one of which was a finding a human
// had explicitly retracted as a false positive after the fact).

test('prepareStackedBranch: remote exists but is based on a stale point of main -> rebases its commits onto current main', () => {
  const { bareDir, repoDir } = makeRepoWithOrigin();
  const runner = createRealGitRunner(repoDir);
  git(['checkout', '-b', 'agent/triage-queue'], repoDir);
  commitFile(repoDir, 'candidate.md', 'entry A\n', 'append entry A');
  git(['push', '-u', 'origin', 'agent/triage-queue'], repoDir);

  // Main moves on independently (no overlap with the rolling branch's own change) --
  // exactly what happens every time a human merges something else into master while the
  // rolling branch sits untouched.
  git(['checkout', 'main'], repoDir);
  commitFile(repoDir, 'unrelated.txt', 'main moved on\n', 'unrelated main change');
  git(['push', 'origin', 'main'], repoDir);
  const newMainTip = git(['rev-parse', 'main'], repoDir).trim();

  assert.doesNotThrow(() => runner.prepareStackedBranch('agent/triage-queue'));
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir).trim(), 'agent/triage-queue');
  assert.doesNotThrow(
    () => execFileSync('git', ['merge-base', '--is-ancestor', newMainTip, 'agent/triage-queue'], { cwd: repoDir, stdio: 'pipe' }),
    'current main must now be an ancestor of the rebuilt branch',
  );
  assert.equal(fs.readFileSync(path.join(repoDir, 'candidate.md'), 'utf8'), 'entry A\n', 'the rolling branch\'s own real content survives the rebase');
  assert.equal(fs.readFileSync(path.join(repoDir, 'unrelated.txt'), 'utf8'), 'main moved on\n', 'current main\'s content is now included too');
});

test('prepareStackedBranch: remote exists, stale relative to main, AND main already carries an equivalent (re-authored) version of the same change -> rebase auto-drops the now-empty duplicate, no human needed', () => {
  const { bareDir, repoDir } = makeRepoWithOrigin();
  const runner = createRealGitRunner(repoDir);
  git(['checkout', '-b', 'agent/triage-queue'], repoDir);
  fs.writeFileSync(path.join(repoDir, 'candidate.md'), 'base\nappend X\n');
  git(['add', 'candidate.md'], repoDir);
  git(['commit', '-m', 'append X'], repoDir);
  git(['push', '-u', 'origin', 'agent/triage-queue'], repoDir);

  // Main incorporates the SAME textual change independently (e.g. a human rebased and
  // merged a copy of this exact commit under a different sha) -- the exact shape of the
  // real incident this test is modeled on.
  git(['checkout', 'main'], repoDir);
  fs.writeFileSync(path.join(repoDir, 'candidate.md'), 'base\nappend X\n');
  git(['add', 'candidate.md'], repoDir);
  git(['commit', '-m', 'append X (re-authored, different sha, already landed on main)'], repoDir);
  git(['push', 'origin', 'main'], repoDir);

  assert.doesNotThrow(() => runner.prepareStackedBranch('agent/triage-queue'));
  assert.equal(fs.readFileSync(path.join(repoDir, 'candidate.md'), 'utf8'), 'base\nappend X\n', 'no duplicate content -- the already-landed change is not reapplied a second time');
});

test('prepareStackedBranch: remote exists, stale relative to main, and rebasing its commits onto main hits a REAL conflict -> throws for a human, discards nothing', () => {
  const { bareDir, repoDir } = makeRepoWithOrigin();
  const runner = createRealGitRunner(repoDir);
  git(['checkout', '-b', 'agent/triage-queue'], repoDir);
  fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'v2 -- from the rolling branch\n');
  git(['add', 'tracked.txt'], repoDir);
  git(['commit', '-m', 'rolling branch edits tracked.txt'], repoDir);
  git(['push', '-u', 'origin', 'agent/triage-queue'], repoDir);
  const branchTip = git(['rev-parse', 'agent/triage-queue'], repoDir).trim();

  // Main independently makes a GENUINELY CONFLICTING edit to the same line.
  git(['checkout', 'main'], repoDir);
  fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'v2 -- from main, a real conflicting edit\n');
  git(['add', 'tracked.txt'], repoDir);
  git(['commit', '-m', 'main edits the same line differently'], repoDir);
  git(['push', 'origin', 'main'], repoDir);

  assert.throws(() => runner.prepareStackedBranch('agent/triage-queue'), /stale point of main/);
  // No rebase left in progress, and the remote-tracking branch's own commit is untouched.
  assert.equal(fs.existsSync(path.join(repoDir, '.git', 'rebase-merge')), false, 'a failed rebase must be aborted, not left in progress');
  assert.equal(git(['rev-parse', 'origin/agent/triage-queue'], repoDir).trim(), branchTip, 'the remote copy itself is never touched by a failed local rebase');
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

// --- early merge of a hub's shared branch (2026-09-20) ----------------------------------------------------------
// A hub is one stacked chain on one branch and is meant to land as ONE final merge, "with the flexibility to merge early". Merging the
// branch after piece 1 (the dashboard merges it into main and deletes the remote branch) must not strand or break pieces 2..N.
function commitFile(repoDir, file, content, msg) {
  fs.writeFileSync(path.join(repoDir, file), content);
  git(['add', file], repoDir);
  git(['commit', '-m', msg], repoDir);
}

test('a hub branch merged EARLY (remote deleted): the next piece starts a fresh branch off main that already carries the earlier pieces, and merges cleanly later', () => {
  const { bareDir, repoDir } = makeRepoWithOrigin();
  const runner = createRealGitRunner(repoDir);
  const B = 'agent/decompose-hub';

  // piece 1 (seq 1): the chain's first step creates the branch and pushes
  git(['checkout', '-b', B], repoDir);
  commitFile(repoDir, 'piece1.txt', 'one\n', 'piece 1');
  git(['push', '-u', 'origin', B], repoDir);

  // the human merges the branch EARLY: into main, remote branch deleted (the local copy lingers, as the pipeline's checkout keeps it)
  git(['checkout', 'main'], repoDir);
  git(['merge', '--no-ff', '-m', 'Merge hub branch early', B], repoDir);
  git(['push', 'origin', 'main'], repoDir);
  git(['push', 'origin', '--delete', B], repoDir);
  assert.equal(runner.remoteBranchExists(B), false, 'the remote copy is really gone');

  // piece 2 (seq 2) runs: prepareStackedBranch finds no remote copy and a local branch that no longer descends from main
  assert.doesNotThrow(() => runner.prepareStackedBranch(B));
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir).trim(), B);
  assert.equal(fs.readFileSync(path.join(repoDir, 'piece1.txt'), 'utf8'), 'one\n', 'piece 1 is present: it came in through main');
  commitFile(repoDir, 'piece2.txt', 'two\n', 'piece 2');
  git(['push', '-u', 'origin', B], repoDir);

  // ...and the second, final merge brings ONLY piece 2 (piece 1 is already in main), with no conflict
  git(['checkout', 'main'], repoDir);
  git(['merge', '--no-ff', '-m', 'Merge hub branch final', B], repoDir);
  const files = git(['ls-files'], repoDir).split('\n').filter(Boolean).sort();
  assert.deepEqual(files, ['piece1.txt', 'piece2.txt', 'tracked.txt']);
  assert.deepEqual(git(['log', '--format=%s', '--no-merges'], repoDir).trim().split('\n').sort(), ['init', 'piece 1', 'piece 2'], 'each piece appears exactly once');
  assert.ok(bareDir);
});

test('a hub branch merged EARLY but the remote branch NOT deleted: the next piece continues on it, and the final merge adds only the new piece', () => {
  const { repoDir } = makeRepoWithOrigin();
  const runner = createRealGitRunner(repoDir);
  const B = 'agent/decompose-hub';

  git(['checkout', '-b', B], repoDir);
  commitFile(repoDir, 'piece1.txt', 'one\n', 'piece 1');
  git(['push', '-u', 'origin', B], repoDir);
  git(['checkout', 'main'], repoDir);
  git(['merge', '--no-ff', '-m', 'Merge hub branch early', B], repoDir);
  git(['push', 'origin', 'main'], repoDir);

  assert.doesNotThrow(() => runner.prepareStackedBranch(B)); // remote exists, local ⊆ origin -> sync to origin's tip (piece 1)
  assert.equal(fs.readFileSync(path.join(repoDir, 'piece1.txt'), 'utf8'), 'one\n');
  commitFile(repoDir, 'piece2.txt', 'two\n', 'piece 2');
  git(['push', 'origin', B], repoDir);

  git(['checkout', 'main'], repoDir);
  git(['merge', '--no-ff', '-m', 'Merge hub branch final', B], repoDir);
  assert.deepEqual(git(['ls-files'], repoDir).split('\n').filter(Boolean).sort(), ['piece1.txt', 'piece2.txt', 'tracked.txt']);
});

// --- remoteHasUnmergedWork (2026-09-20) -------------------------------------------------
// apply-task.js's stacked seq 1 path recreates the branch off main; that is only safe when origin holds nothing on it that main lacks.

test('remoteHasUnmergedWork: false when origin has no such branch', () => {
  const { repoDir } = makeRepoWithOrigin();
  assert.equal(createRealGitRunner(repoDir).remoteHasUnmergedWork('agent/decompose-x'), false);
});

test('remoteHasUnmergedWork: true when origin carries pushed commits main lacks', () => {
  const { repoDir } = makeRepoWithOrigin();
  const runner = createRealGitRunner(repoDir);
  runner.createBranch('agent/decompose-x');
  fs.writeFileSync(path.join(repoDir, 'step1.txt'), 'move 1\n');
  git(['add', 'step1.txt'], repoDir);
  git(['commit', '-m', 'step 1'], repoDir);
  git(['push', '-u', 'origin', 'agent/decompose-x'], repoDir);
  runner.checkoutMain();
  git(['branch', '-D', 'agent/decompose-x'], repoDir);
  assert.equal(runner.remoteHasUnmergedWork('agent/decompose-x'), true);
});

test('remoteHasUnmergedWork: false once origin\'s branch is fully merged into main', () => {
  const { repoDir } = makeRepoWithOrigin();
  const runner = createRealGitRunner(repoDir);
  git(['push', 'origin', 'HEAD:refs/heads/agent/decompose-merged'], repoDir); // same commit as main: nothing main lacks
  assert.equal(runner.remoteHasUnmergedWork('agent/decompose-merged'), false);
});

// 2026-09-23 (change_review backlog incident): in a DEDICATED apply clone (the one
// AGENT_MANAGER_APPLY_REPO_ROOT names) stray uncommitted content must never ride through resetToMain's
// stash/pop -- it re-dirtied the tree every cycle and aborted every checkout/rebase in the triage batch.
function withApplyRoot(root, fn) {
  const saved = process.env.AGENT_MANAGER_APPLY_REPO_ROOT;
  if (root === undefined) delete process.env.AGENT_MANAGER_APPLY_REPO_ROOT; else process.env.AGENT_MANAGER_APPLY_REPO_ROOT = root;
  try { return fn(); } finally {
    if (saved === undefined) delete process.env.AGENT_MANAGER_APPLY_REPO_ROOT; else process.env.AGENT_MANAGER_APPLY_REPO_ROOT = saved;
  }
}

test('dedicated apply clone: resetToMain quarantines stray content to a patch under .git/ and does NOT pop it back', () => {
  const { repoDir } = makeRepoWithOrigin();
  fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'v1\nSTRAY FIXTURE\n');
  fs.writeFileSync(path.join(repoDir, 'stray-untracked.txt'), 'untracked stray\n');
  withApplyRoot(repoDir, () => createRealGitRunner(repoDir).resetToMain());

  assert.equal(git(['status', '--porcelain'], repoDir).trim(), '', 'tree is clean after the reset -- nothing carried forward');
  assert.equal(git(['stash', 'list'], repoDir).trim(), '', 'no stash left behind');
  assert.equal(fs.readFileSync(path.join(repoDir, 'tracked.txt'), 'utf8'), 'v1\n');
  const qdir = path.join(repoDir, '.git', 'agent-manager-quarantine');
  const patches = fs.readdirSync(qdir);
  assert.equal(patches.length, 1, 'the stray content is preserved, recoverably');
  const body = fs.readFileSync(path.join(qdir, patches[0]), 'utf8');
  assert.match(body, /STRAY FIXTURE/);
  assert.match(body, /untracked stray/);
});

test('a NON-dedicated checkout keeps the old round-trip: resetToMain still pops the stash back', () => {
  const { repoDir } = makeRepoWithOrigin();
  fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'v1\nlive WIP\n');
  withApplyRoot(undefined, () => createRealGitRunner(repoDir).resetToMain());
  assert.equal(fs.readFileSync(path.join(repoDir, 'tracked.txt'), 'utf8'), 'v1\nlive WIP\n');
  assert.equal(fs.existsSync(path.join(repoDir, '.git', 'agent-manager-quarantine')), false);
});

test('dedicated apply clone: a resetToMain with nothing dirty quarantines nothing', () => {
  const { repoDir } = makeRepoWithOrigin();
  withApplyRoot(repoDir, () => createRealGitRunner(repoDir).resetToMain());
  assert.equal(fs.existsSync(path.join(repoDir, '.git', 'agent-manager-quarantine')), false);
});

test('quarantineDirtyTree self-heals a dedicated apply clone (the batch pre-flight), and is a no-op anywhere else', () => {
  const { repoDir } = makeRepoWithOrigin();
  fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'v1\nSTRAY\n');
  assert.equal(withApplyRoot(undefined, () => createRealGitRunner(repoDir).quarantineDirtyTree()), null);
  assert.match(git(['status', '--porcelain'], repoDir), /tracked\.txt/, 'not dedicated -> left alone');

  const patch = withApplyRoot(repoDir, () => createRealGitRunner(repoDir).quarantineDirtyTree());
  assert.ok(patch && fs.existsSync(patch));
  assert.equal(git(['status', '--porcelain'], repoDir).trim(), '');
  assert.equal(git(['stash', 'list'], repoDir).trim(), '');
});

test('assertCleanTree passes on a clean tree and throws the stable DIRTY_CLONE_ERROR_PREFIX naming the files on a dirty one', () => {
  const { DIRTY_CLONE_ERROR_PREFIX } = require('./git-runner.js');
  const { repoDir } = makeRepoWithOrigin();
  const runner = withApplyRoot(undefined, () => createRealGitRunner(repoDir));
  assert.doesNotThrow(() => runner.assertCleanTree());
  fs.writeFileSync(path.join(repoDir, 'untracked-only.txt'), 'x');
  assert.doesNotThrow(() => runner.assertCleanTree(), 'untracked files never block checkout/rebase');
  fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'v1\ndirty\n');
  assert.throws(() => runner.assertCleanTree(), (e) => e.message.startsWith(DIRTY_CLONE_ERROR_PREFIX) && /tracked\.txt/.test(e.message));
});

// --- retryPushAfterRebase (2026-09-24) ---------------------------------------------------
// Reproduces the ordinary case behind the divergence incidents above one level earlier: a
// push rejected non-fast-forward because someone else pushed to the SAME branch first, on a
// change that doesn't actually conflict (a real triage-batch append only ever touches the
// end of a shared candidate doc). retryPushAfterRebase should recover from this without any
// human involvement.
test('retryPushAfterRebase: a non-conflicting push rejection recovers via fetch+rebase+push', () => {
  const { bareDir, repoDir } = makeRepoWithOrigin();
  const runner = createRealGitRunner(repoDir);
  runner.createBranch('agent/triage-queue');
  git(['push', '-u', 'origin', 'agent/triage-queue'], repoDir);
  // Someone else pushes first...
  const otherClone = fs.mkdtempSync(path.join(os.tmpdir(), 'git-runner-test-other-clone-'));
  git(['clone', bareDir, otherClone]);
  git(['config', 'user.email', 'test@example.com'], otherClone);
  git(['config', 'user.name', 'Test'], otherClone);
  git(['checkout', 'agent/triage-queue'], otherClone);
  fs.writeFileSync(path.join(otherClone, 'other-entry.txt'), 'someone else\'s batch\n');
  git(['add', 'other-entry.txt'], otherClone);
  git(['commit', '-m', 'their triage batch'], otherClone);
  git(['push', 'origin', 'agent/triage-queue'], otherClone);
  // ...then local commits its own, non-overlapping batch and its push is rejected.
  fs.writeFileSync(path.join(repoDir, 'my-entry.txt'), 'my batch\n');
  git(['add', 'my-entry.txt'], repoDir);
  git(['commit', '-m', 'my triage batch'], repoDir);
  const myTip = git(['rev-parse', 'HEAD'], repoDir).trim();
  assert.throws(() => git(['push', 'origin', 'agent/triage-queue'], repoDir), /rejected|non-fast-forward/);

  assert.equal(runner.retryPushAfterRebase('agent/triage-queue'), true);
  assert.equal(git(['status', '--porcelain'], repoDir).trim(), '', 'rebase left a clean tree');
  assert.ok(fs.existsSync(path.join(repoDir, 'other-entry.txt')), 'their entry is present');
  assert.ok(fs.existsSync(path.join(repoDir, 'my-entry.txt')), 'my entry is present');
  const remoteTip = git(['ls-remote', bareDir, 'refs/heads/agent/triage-queue'], repoDir).trim().split(/\s+/)[0];
  assert.equal(remoteTip, git(['rev-parse', 'agent/triage-queue'], repoDir).trim(), 'the rebased commit actually landed on origin');
  assert.notEqual(remoteTip, myTip, 'the commit was rebased onto a new base, so its own SHA changed');
});

test('retryPushAfterRebase: a REAL conflict aborts cleanly and returns false, leaving local as it was', () => {
  const { bareDir, repoDir } = makeRepoWithOrigin();
  const runner = createRealGitRunner(repoDir);
  runner.createBranch('agent/triage-queue');
  git(['push', '-u', 'origin', 'agent/triage-queue'], repoDir);
  const otherClone = fs.mkdtempSync(path.join(os.tmpdir(), 'git-runner-test-other-clone-'));
  git(['clone', bareDir, otherClone]);
  git(['config', 'user.email', 'test@example.com'], otherClone);
  git(['config', 'user.name', 'Test'], otherClone);
  git(['checkout', 'agent/triage-queue'], otherClone);
  fs.writeFileSync(path.join(otherClone, 'tracked.txt'), 'v1\ntheir conflicting line\n');
  git(['add', 'tracked.txt'], otherClone);
  git(['commit', '-m', 'their conflicting edit'], otherClone);
  git(['push', 'origin', 'agent/triage-queue'], otherClone);
  fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'v1\nmy conflicting line\n');
  git(['add', 'tracked.txt'], repoDir);
  git(['commit', '-m', 'my conflicting edit'], repoDir);
  const myTip = git(['rev-parse', 'HEAD'], repoDir).trim();
  assert.throws(() => git(['push', 'origin', 'agent/triage-queue'], repoDir), /rejected|non-fast-forward/);

  assert.equal(runner.retryPushAfterRebase('agent/triage-queue'), false);
  assert.equal(git(['status', '--porcelain'], repoDir).trim(), '', 'the aborted rebase leaves a clean tree');
  assert.equal(git(['rev-parse', 'agent/triage-queue'], repoDir).trim(), myTip, 'local is untouched -- the failed rebase changed nothing');
});

test('prepareStackedBranch: branch deleted on origin but stale local tracking ref remains -> not resurrected', () => {
  const { bareDir, repoDir } = makeRepoWithOrigin();
  const runner = createRealGitRunner(repoDir);
  runner.createBranch('agent/triage-x');
  fs.writeFileSync(path.join(repoDir, 'discarded.txt'), 'rejected candidate\n');
  git(['add', 'discarded.txt'], repoDir);
  git(['commit', '-m', 'Triage batch'], repoDir);
  git(['push', '-u', 'origin', 'agent/triage-x'], repoDir);
  runner.checkoutMain();
  git(['branch', '-D', 'agent/triage-x'], repoDir);
  // A human discards the branch on the remote; this clone is never `fetch --prune`d, so its
  // refs/remotes/origin/agent/triage-x survives (the live 2026-09-25 resurrection trigger).
  git(['branch', '-D', 'agent/triage-x'], bareDir);
  assert.ok(git(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/agent/triage-x'], repoDir).trim());

  runner.prepareStackedBranch('agent/triage-x');

  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir).trim(), 'agent/triage-x');
  assert.equal(fs.existsSync(path.join(repoDir, 'discarded.txt')), false, 'discarded commits must not come back');
  assert.throws(() => git(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/agent/triage-x'], repoDir));
});

test('prepareStackedBranch: fetch failing for a NON-missing-ref reason leaves the tracking ref alone', () => {
  const { repoDir } = makeRepoWithOrigin();
  const runner = createRealGitRunner(repoDir);
  runner.createBranch('agent/triage-y');
  fs.writeFileSync(path.join(repoDir, 'keep.txt'), 'real\n');
  git(['add', 'keep.txt'], repoDir);
  git(['commit', '-m', 'Triage batch'], repoDir);
  git(['push', '-u', 'origin', 'agent/triage-y'], repoDir);
  runner.checkoutMain();
  git(['branch', '-D', 'agent/triage-y'], repoDir);
  // Point origin at an unreachable path: fetch and ls-remote both fail, neither says "gone".
  git(['remote', 'set-url', 'origin', path.join(os.tmpdir(), 'no-such-remote-dir-xyz')], repoDir);

  try { runner.prepareStackedBranch('agent/triage-y'); } catch { /* downstream steps may fail offline; only the ref matters */ }

  assert.ok(git(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/agent/triage-y'], repoDir).trim());
});

test('annotateGitTimeout: a timed-out git call names the command and the cap, and keeps the original message', () => {
  const { annotateGitTimeout } = require('./git-runner.js');
  const err = Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' });
  const out = annotateGitTimeout(err, ['push', '-u', 'origin', 'agent/triage-queue', '--verbose'], 60000);
  assert.equal(out, err, 'same error object, so e.status / e.code checks elsewhere still work');
  assert.match(err.message, /^git push -u origin agent\/triage-queue timed out after 60000ms \(ETIMEDOUT\): spawnSync git ETIMEDOUT$/);
  assert.equal(annotateGitTimeout(err, ['push'], 60000).message, err.message, 'annotating twice does not stack');
});

test('annotateGitTimeout: non-timeout errors are left untouched', () => {
  const { annotateGitTimeout } = require('./git-runner.js');
  const err = Object.assign(new Error('fatal: not a git repository'), { status: 128 });
  assert.equal(annotateGitTimeout(err, ['status'], 60000).message, 'fatal: not a git repository');
});
