'use strict';

// HUB0761: test the diverged main recovery in resetToMain. Two cases:
// 1. Reconcilable: local and origin/main have diverged, rescue can be created -> rescue branch
//    contains the old local commit, main matches origin.
// 2. Unreconcilable: pre-make rescue branch creation fail (by removing write perms on .git) ->
//    DivergedMainError is thrown with SHA lists, local commit still reachable.
// Run: node --test test/git-runner-diverged-main.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createRealGitRunner, DivergedMainError } = require('../src/git-runner.js');

const git = (args, cwd) => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' });

function setup() {
  const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diverged-origin-'));
  const repoDir = path.join(os.tmpdir(), `diverged-repo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  git(['init', '--bare', '-b', 'main', bareDir]);
  git(['clone', bareDir, repoDir]);
  git(['config', 'user.email', 't@x'], repoDir);
  git(['config', 'user.name', 'T'], repoDir);
  return { bareDir, repoDir };
}

const localCommit = (repoDir, text) => {
  fs.writeFileSync(path.join(repoDir, 'a.txt'), text);
  git(['add', 'a.txt'], repoDir);
  git(['commit', '-m', text.trim()], repoDir);
  return git(['rev-parse', 'HEAD'], repoDir).trim();
};

const originCommit = (bareDir, text) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diverged-tmp-'));
  try {
    git(['clone', bareDir, tmpDir]);
    git(['config', 'user.email', 't@x'], tmpDir);
    git(['config', 'user.name', 'T'], tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), text);
    git(['add', 'a.txt'], tmpDir);
    git(['commit', '-m', text.trim()], tmpDir);
    git(['push', 'origin', 'main'], tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
};

const originMain = (bareDir) => git(['rev-parse', 'main'], bareDir).trim();
const localMain = (repoDir) => git(['rev-parse', 'HEAD'], repoDir).trim();
const hasBranch = (repoDir, name) => {
  try {
    git(['rev-parse', '--verify', `refs/heads/${name}`], repoDir);
    return true;
  } catch {
    return false;
  }
};

const branchTip = (repoDir, name) => git(['rev-parse', `refs/heads/${name}`], repoDir).trim();

test('reconcilable: diverged main is rescued and main aligns to origin', () => {
  const { bareDir, repoDir } = setup();
  const localSha = localCommit(repoDir, 'local v2\n');
  originCommit(bareDir, 'remote v2\n');

  const runner = createRealGitRunner(repoDir);
  runner.resetToMain();

  // main should now match origin
  assert.equal(localMain(repoDir), originMain(bareDir));

  // rescue branch should exist and contain the old local commit
  const rescueBranches = git(['branch', '--list', 'agent/rescued-main-*'], repoDir).trim().split('\n').filter(Boolean);
  assert.ok(rescueBranches.length > 0, 'rescue branch was created');
  const rescueName = rescueBranches[0].trim().replace(/^\*?\s*/, '');
  assert.equal(branchTip(repoDir, rescueName), localSha, 'rescue branch contains the old local commit');
});

test('unreconcilable: failed rescue throws DivergedMainError with SHA lists', () => {
  const { bareDir, repoDir } = setup();
  const localSha = localCommit(repoDir, 'local v2\n');
  originCommit(bareDir, 'remote v2\n');

  // Make .git/refs/heads read-only to force git branch to fail, but keep fetch working
  const headsDir = path.join(repoDir, '.git', 'refs', 'heads');
  fs.chmodSync(headsDir, 0o555);

  try {
    const runner = createRealGitRunner(repoDir);
    try {
      runner.resetToMain();
      assert.fail('resetToMain should have thrown');
    } catch (e) {
      assert.ok(e instanceof DivergedMainError, `DivergedMainError should be thrown, got ${e.constructor.name}: ${e.message}`);
      assert.ok(Array.isArray(e.localOnly) && e.localOnly.length > 0, 'localOnly should have SHAs');
      assert.ok(Array.isArray(e.remoteOnly) && e.remoteOnly.length > 0, 'remoteOnly should have SHAs');
      // Verify the SHAs are in the localOnly array
      assert.ok(e.localOnly.includes(localSha), 'localOnly should include the local SHA');

      // Local commit should still be reachable
      try {
        git(['rev-parse', localSha], repoDir);
      } catch {
        assert.fail('local commit should still be reachable');
      }
    }
  } finally {
    // Restore permissions for cleanup
    fs.chmodSync(headsDir, 0o755);
  }
});
