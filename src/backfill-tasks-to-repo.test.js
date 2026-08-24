'use strict';

// Unit tests for backfill-tasks-to-repo.js. findAllTaskFiles is tested directly against
// real fixture directories (no git involved); backfillTasksToRepo's real commit path is
// tested against a real throwaway bare repo standing in for the dedicated task-data repo,
// same fixture pattern task-repo-sync.test.js uses.
//
// Run: node --test src/backfill-tasks-to-repo.test.js  (or `npm test`)

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { backfillTasksToRepo, findAllTaskFiles } = require('./backfill-tasks-to-repo.js');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

function makeQueueFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-test-queue-'));
  const queueDir = path.join(dir, 'queue');
  fs.mkdirSync(queueDir, { recursive: true });
  return { dir, queueDir };
}

function writeTaskFile(queueDir, relDir, id) {
  const full = path.join(queueDir, relDir);
  fs.mkdirSync(full, { recursive: true });
  fs.writeFileSync(path.join(full, `${id}.json`), JSON.stringify({ id, title: id, status: 'x' }));
}

function makeTaskDataRepo() {
  const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-test-remote-'));
  git(['init', '--bare', '-b', 'main', bareDir]);
  const seedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-test-seed-'));
  git(['clone', bareDir, seedDir]);
  git(['config', 'user.email', 'test@example.com'], seedDir);
  git(['config', 'user.name', 'Test'], seedDir);
  fs.writeFileSync(path.join(seedDir, 'README.md'), 'task data repo\n');
  git(['add', 'README.md'], seedDir);
  git(['commit', '-m', 'init'], seedDir);
  git(['push', 'origin', 'main'], seedDir);
  return bareDir;
}

function cloneAtTip(taskRepoUrl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-test-read-'));
  git(['clone', taskRepoUrl, dir]);
  return dir;
}

test('findAllTaskFiles finds every flat state directory', () => {
  const { queueDir } = makeQueueFixture();
  writeTaskFile(queueDir, 'pending', 'p1');
  writeTaskFile(queueDir, 'blocked', 'b1');
  writeTaskFile(queueDir, 'adhoc', 'a1');
  writeTaskFile(queueDir, 'research', 'r1');
  writeTaskFile(queueDir, 'needs-clarification', 'nc1');

  const files = findAllTaskFiles(queueDir);
  const ids = files.map((f) => path.basename(f, '.json')).sort();
  assert.deepEqual(ids, ['a1', 'b1', 'nc1', 'p1', 'r1']);
});

test('findAllTaskFiles recurses into drafting/<instance>/ subfolders and the legacy flat fallback', () => {
  const { queueDir } = makeQueueFixture();
  writeTaskFile(queueDir, 'drafting/worker-1', 'd1');
  writeTaskFile(queueDir, 'drafting', 'd2'); // legacy: no subfolder

  const files = findAllTaskFiles(queueDir);
  const ids = files.map((f) => path.basename(f, '.json')).sort();
  assert.deepEqual(ids, ['d1', 'd2']);
});

test('findAllTaskFiles includes done/, done/_archived_no_action/, and dated done/_archived/<YYYY-MM>/ buckets', () => {
  const { queueDir } = makeQueueFixture();
  writeTaskFile(queueDir, 'done', 'done1');
  writeTaskFile(queueDir, 'done/_archived_no_action', 'archived-manual-1');
  writeTaskFile(queueDir, 'done/_archived/2026-01', 'archived-auto-1');

  const files = findAllTaskFiles(queueDir);
  const ids = files.map((f) => path.basename(f, '.json')).sort();
  assert.deepEqual(ids, ['archived-auto-1', 'archived-manual-1', 'done1']);
});

test('findAllTaskFiles returns an empty array, not a throw, when queue/ does not exist yet', () => {
  const { queueDir } = makeQueueFixture();
  fs.rmSync(queueDir, { recursive: true });
  assert.deepEqual(findAllTaskFiles(queueDir), []);
});

test('backfillTasksToRepo(dryRun: true) reports counts without touching git at all', () => {
  const { queueDir } = makeQueueFixture();
  writeTaskFile(queueDir, 'pending', 'p1');
  writeTaskFile(queueDir, 'blocked', 'b1');

  const result = backfillTasksToRepo({ pipelineDir: path.dirname(queueDir), taskRepoUrl: '/nonexistent-never-touched', dryRun: true });

  assert.equal(result.scanned, 2);
  assert.equal(result.written, 2);
  assert.equal(result.committed, false);
  assert.equal(result.dryRun, true);
});

test('backfillTasksToRepo makes ONE real commit covering every scanned task', () => {
  const taskRepoUrl = makeTaskDataRepo();
  const { queueDir } = makeQueueFixture();
  writeTaskFile(queueDir, 'pending', 'p1');
  writeTaskFile(queueDir, 'done', 'd1');
  writeTaskFile(queueDir, 'done', 'd2');

  const result = backfillTasksToRepo({ pipelineDir: path.dirname(queueDir), taskRepoUrl });

  assert.equal(result.scanned, 3);
  assert.equal(result.written, 3);
  assert.equal(result.committed, true);

  const readDir = cloneAtTip(taskRepoUrl);
  const log = git(['log', '--oneline', '-1'], readDir);
  assert.match(log, /backfill 3 existing task record/);
  for (const id of ['p1', 'd1', 'd2']) {
    assert.equal(fs.existsSync(path.join(readDir, 'tasks', `${id}.json`)), true);
  }
});

test('backfillTasksToRepo skips a malformed task file without failing the whole batch', () => {
  const taskRepoUrl = makeTaskDataRepo();
  const { queueDir } = makeQueueFixture();
  writeTaskFile(queueDir, 'pending', 'p1');
  fs.mkdirSync(path.join(queueDir, 'blocked'), { recursive: true });
  fs.writeFileSync(path.join(queueDir, 'blocked', 'broken.json'), 'not valid json{{{');

  const result = backfillTasksToRepo({ pipelineDir: path.dirname(queueDir), taskRepoUrl });

  assert.equal(result.scanned, 2);
  assert.equal(result.written, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.committed, true);
});

test('backfillTasksToRepo reports committed:false when queue/ has nothing to sync', () => {
  const { queueDir } = makeQueueFixture();
  const result = backfillTasksToRepo({ pipelineDir: path.dirname(queueDir), taskRepoUrl: '/nonexistent-never-touched' });
  assert.equal(result.scanned, 0);
  assert.equal(result.committed, false);
});
