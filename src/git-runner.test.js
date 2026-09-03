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
