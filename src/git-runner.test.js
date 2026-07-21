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
