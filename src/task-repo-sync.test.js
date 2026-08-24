'use strict';

// Unit tests for task-repo-sync.js -- real throwaway git repo + bare "origin" (same
// fixture pattern as adhoc-agentic-draft.test.js/git-runner.test.js), never against this
// package's own repo.
//
// Run: node --test src/task-repo-sync.test.js  (or `npm test`)

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { syncTaskToRepo, relativeTaskPath } = require('./task-repo-sync.js');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

function makeRepoWithOrigin() {
  const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-sync-test-origin-'));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-sync-test-repo-'));
  git(['init', '--bare', '-b', 'main', bareDir]);
  git(['clone', bareDir, repoDir]);
  git(['config', 'user.email', 'test@example.com'], repoDir);
  git(['config', 'user.name', 'Test'], repoDir);
  fs.writeFileSync(path.join(repoDir, 'f.txt'), 'v1\n');
  git(['add', 'f.txt'], repoDir);
  git(['commit', '-m', 'init'], repoDir);
  git(['push', 'origin', 'main'], repoDir);
  return { bareDir, repoDir };
}

test('syncTaskToRepo(commit: true) writes .agent-manager/tasks/<id>.json and produces a real commit on main', () => {
  const { repoDir } = makeRepoWithOrigin();
  const task = { id: 'sync-1', title: 'Test task', status: 'pending' };

  const result = syncTaskToRepo(task, { repoRoot: repoDir, commit: true });

  assert.equal(result.relPath, '.agent-manager/tasks/sync-1.json');
  assert.equal(result.committed, true);

  git(['pull'], repoDir);
  const content = JSON.parse(fs.readFileSync(path.join(repoDir, result.relPath), 'utf8'));
  assert.equal(content.status, 'pending');
  const log = git(['log', '--oneline', '-1'], repoDir);
  assert.match(log, /task: Test task \(pending\)/);
});

test('syncTaskToRepo(commit: true) updates the SAME file in place on a second call, not a new one', () => {
  const { repoDir } = makeRepoWithOrigin();
  const task = { id: 'sync-2', title: 'Test task', status: 'pending' };
  syncTaskToRepo(task, { repoRoot: repoDir, commit: true });

  task.status = 'blocked';
  const result2 = syncTaskToRepo(task, { repoRoot: repoDir, commit: true });

  assert.equal(result2.committed, true);
  git(['pull'], repoDir);
  const history = git(['log', '--follow', '--oneline', '--', result2.relPath], repoDir).trim().split('\n');
  assert.equal(history.length, 2, 'both the create and the update must show up in the same file\'s history');
  const content = JSON.parse(fs.readFileSync(path.join(repoDir, result2.relPath), 'utf8'));
  assert.equal(content.status, 'blocked');
});

test('syncTaskToRepo(commit: false) writes the file without creating a commit, for the caller to piggyback', () => {
  const { repoDir } = makeRepoWithOrigin();
  const task = { id: 'sync-3', title: 'Test task', status: 'pending' };

  const result = syncTaskToRepo(task, { repoRoot: repoDir, commit: false });

  assert.equal(result.relPath, '.agent-manager/tasks/sync-3.json');
  assert.equal(result.committed, false);
  assert.equal(fs.existsSync(path.join(repoDir, result.relPath)), true, 'file must exist in the CALLER\'s own working tree (repoRoot), ready to be added to its own commit');
  const status = git(['status', '--porcelain'], repoDir);
  assert.match(status, /\.agent-manager\//, 'must show as an untracked/uncommitted change in repoRoot -- nothing here commits it');
});

test('syncTaskToRepo(commit: true) reports committed:false (not an error) when the record is unchanged', () => {
  const { repoDir } = makeRepoWithOrigin();
  const task = { id: 'sync-4', title: 'Test task', status: 'pending' };
  syncTaskToRepo(task, { repoRoot: repoDir, commit: true });

  // Same task object, unchanged -- nothing new to commit.
  const result2 = syncTaskToRepo(task, { repoRoot: repoDir, commit: true });
  assert.equal(result2.committed, false);
  assert.equal(result2.error, undefined);
});

test('syncTaskToRepo cleans up its own worktree even after a successful commit', () => {
  const { repoDir } = makeRepoWithOrigin();
  syncTaskToRepo({ id: 'sync-5', title: 'x', status: 'pending' }, { repoRoot: repoDir, commit: true });
  const worktreeList = git(['worktree', 'list'], repoDir);
  assert.equal(worktreeList.split('\n').filter(Boolean).length, 1, 'only the main worktree should remain');
});

test('syncTaskToRepo returns a no-op result (not a throw) when repoRoot or task.id is missing', () => {
  assert.deepEqual(syncTaskToRepo({ title: 'no id' }, { repoRoot: '/tmp/whatever' }), { relPath: null, committed: false });
  assert.deepEqual(syncTaskToRepo({ id: 'x' }, {}), { relPath: null, committed: false });
});
