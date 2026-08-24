'use strict';

// Unit tests for task-repo-sync.js -- real throwaway git repo used as a stand-in for the
// dedicated task-data repo (a real local bare repo works fine as a git remote for `git
// clone`/`git push`, same fixture pattern this codebase's other real-git tests already use).
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

// A bare repo with an initial commit on main, standing in for the dedicated task-data
// repo -- `git clone`/`git push` work against it identically to a real GitHub remote.
function makeTaskDataRepo() {
  const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-sync-test-remote-'));
  git(['init', '--bare', '-b', 'main', bareDir]);
  const seedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-sync-test-seed-'));
  git(['clone', bareDir, seedDir]);
  git(['config', 'user.email', 'test@example.com'], seedDir);
  git(['config', 'user.name', 'Test'], seedDir);
  fs.writeFileSync(path.join(seedDir, 'README.md'), 'task data repo\n');
  git(['add', 'README.md'], seedDir);
  git(['commit', '-m', 'init'], seedDir);
  git(['push', 'origin', 'main'], seedDir);
  return bareDir;
}

// Read back the current content of a file at the remote's tip, via a fresh clone -- avoids
// asserting against local clone state task-repo-sync.js itself already deleted.
function readAtRemoteTip(taskRepoUrl, relPath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-sync-test-read-'));
  git(['clone', taskRepoUrl, dir]);
  return fs.readFileSync(path.join(dir, relPath), 'utf8');
}

function logAtRemoteTip(taskRepoUrl, args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-sync-test-read-'));
  git(['clone', taskRepoUrl, dir]);
  return git(['log', ...args], dir);
}

test('syncTaskToRepo writes tasks/<id>.json and produces a real commit on the task-data repo', () => {
  const taskRepoUrl = makeTaskDataRepo();
  const task = { id: 'sync-1', title: 'Test task', status: 'pending' };

  const result = syncTaskToRepo(task, { taskRepoUrl });

  assert.equal(result.relPath, path.join('tasks', 'sync-1.json'));
  assert.equal(result.committed, true);

  const content = JSON.parse(readAtRemoteTip(taskRepoUrl, result.relPath));
  assert.equal(content.status, 'pending');
  const log = logAtRemoteTip(taskRepoUrl, ['--oneline', '-1']);
  assert.match(log, /task: Test task \(pending\)/);
});

test('syncTaskToRepo updates the SAME file in place on a second call, not a new one', () => {
  const taskRepoUrl = makeTaskDataRepo();
  const task = { id: 'sync-2', title: 'Test task', status: 'pending' };
  syncTaskToRepo(task, { taskRepoUrl });

  task.status = 'blocked';
  const result2 = syncTaskToRepo(task, { taskRepoUrl });

  assert.equal(result2.committed, true);
  const history = logAtRemoteTip(taskRepoUrl, ['--follow', '--oneline', '--', result2.relPath]).trim().split('\n');
  assert.equal(history.length, 2, 'both the create and the update must show up in the same file\'s history');
  const content = JSON.parse(readAtRemoteTip(taskRepoUrl, result2.relPath));
  assert.equal(content.status, 'blocked');
});

test('syncTaskToRepo reports committed:false (not an error) when the record is unchanged', () => {
  const taskRepoUrl = makeTaskDataRepo();
  const task = { id: 'sync-4', title: 'Test task', status: 'pending' };
  syncTaskToRepo(task, { taskRepoUrl });

  // Same task object, unchanged -- nothing new to commit.
  const result2 = syncTaskToRepo(task, { taskRepoUrl });
  assert.equal(result2.committed, false);
  assert.equal(result2.error, undefined);
});

test('syncTaskToRepo cleans up its own clone directory even after a successful commit', () => {
  const taskRepoUrl = makeTaskDataRepo();
  const before = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('agent-manager-task-sync-')).length;
  syncTaskToRepo({ id: 'sync-5', title: 'x', status: 'pending' }, { taskRepoUrl });
  const after = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('agent-manager-task-sync-')).length;
  assert.equal(after, before, 'the throwaway clone directory must be removed');
});

test('syncTaskToRepo returns a no-op result (not a throw) when taskRepoUrl or task.id is missing', () => {
  assert.deepEqual(syncTaskToRepo({ title: 'no id' }, { taskRepoUrl: '/tmp/whatever' }), { relPath: null, committed: false });
  assert.deepEqual(syncTaskToRepo({ id: 'x' }, {}), { relPath: null, committed: false });
});

test('syncTaskToRepo returns an error (not a throw) when the remote does not exist', () => {
  const result = syncTaskToRepo({ id: 'sync-6', title: 'x' }, { taskRepoUrl: '/nonexistent/remote/path' });
  assert.equal(result.committed, false);
  assert.match(result.error, /could not clone task-data repo/);
});
