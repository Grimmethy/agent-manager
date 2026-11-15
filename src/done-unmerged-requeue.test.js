'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Sandbox tests for the done-unmerged-branch requeue path.
// These tests use isolated pipeline directories (never live queues) and verify
// the six scenarios described in HUB0191.

const { sweepDoneUnmerged, SETTLE_MS } = require('./done-unmerged-requeue.js');

function makePipelineDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'done-unmerged-'));
  const pipelineDir = path.join(root, 'pipeline');
  fs.mkdirSync(path.join(pipelineDir, 'queue', 'done'), { recursive: true });
  fs.mkdirSync(path.join(pipelineDir, 'queue', 'pending'), { recursive: true });
  fs.mkdirSync(path.join(pipelineDir, 'queue', 'review'), { recursive: true });
  return pipelineDir;
}

function putTask(pipelineDir, id, state, extra = {}) {
  const task = {
    id,
    domain: 'adhoc',
    source: 'derived_task',
    status: state,
    promptContext: { rawText: 'fix it' },
    history: [{ stage: 'applied', at: new Date().toISOString(), detail: 'agent/branch' }],
    ...extra,
  };
  const dir = path.join(pipelineDir, 'queue', state);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(task, null, 2));
  return task;
}

const readTask = (pipelineDir, id) => JSON.parse(
  fs.readFileSync(path.join(pipelineDir, 'queue', 'done', `${id}.json`), 'utf8')
);

test('a DONE needs-work task matching a shipped entry is requeued once with premium kept and feedback attached', () => {
  const pipelineDir = makePipelineDir();
  const task = putTask(pipelineDir, 'HUB-SANDBOX-1', 'done', {
    status: 'needs-work',
    premium: { priority: 'high', reason: 'test' },
    promptContext: { rawText: 'Files: src/a.js' },
    history: [
      { stage: 'applied', at: new Date().toISOString(), detail: 'agent/fix-1' },
      { stage: 'review', at: new Date().toISOString(), verdict: 'needs-work', reason: 'missing tests' },
    ],
  });

  const result = sweepDoneUnmerged({
    pipelineDir,
    now: Date.now() + SETTLE_MS + 1000,
    shippedEntries: [{ taskId: 'HUB-SANDBOX-1', branch: 'agent/fix-1' }],
  });

  assert.equal(result.requeued, 1);
  assert.equal(result.unchanged, 0);
  assert.equal(result.discarded, 0);

  const requeued = JSON.parse(
    fs.readFileSync(path.join(pipelineDir, 'queue', 'pending', 'HUB-SANDBOX-1.json'), 'utf8')
  );
  assert.equal(requeued.status, 'pending');
  assert.deepEqual(requeued.premium, { priority: 'high', reason: 'test' });
  assert.match(requeued.promptContext.rawText, /REQUEUE FEEDBACK/);
  assert.match(requeued.history[requeued.history.length - 1].stage, /requeued/);
});

test('a second sweep does nothing to an already-requeued card', () => {
  const pipelineDir = makePipelineDir();
  putTask(pipelineDir, 'HUB-SANDBOX-2', 'pending', {
    status: 'pending',
    premium: { priority: 'medium' },
    promptContext: { rawText: 'Files: src/b.js' },
    history: [{ stage: 'requeued', at: new Date().toISOString(), source: 'sweep' }],
  });

  const result = sweepDoneUnmerged({
    pipelineDir,
    now: Date.now() + SETTLE_MS + 1000,
    shippedEntries: [{ taskId: 'HUB-SANDBOX-2', branch: 'agent/fix-2' }],
  });

  assert.equal(result.requeued, 0);
  assert.equal(result.unchanged, 0);
  assert.equal(result.discarded, 0);

  // Verify the task in pending/ is unchanged
  const pending = JSON.parse(
    fs.readFileSync(path.join(pipelineDir, 'queue', 'pending', 'HUB-SANDBOX-2.json'), 'utf8')
  );
  assert.equal(pending.status, 'pending');
  assert.equal(pending.history.length, 1);
});

test('a non-matching card is untouched', () => {
  const pipelineDir = makePipelineDir();
  putTask(pipelineDir, 'HUB-SANDBOX-3', 'done', {
    status: 'needs-work',
    premium: { priority: 'low' },
    promptContext: { rawText: 'Files: src/c.js' },
    history: [{ stage: 'applied', at: new Date().toISOString(), detail: 'agent/other' }],
  });

  const result = sweepDoneUnmerged({
    pipelineDir,
    now: Date.now() + SETTLE_MS + 1000,
    shippedEntries: [{ taskId: 'HUB-SANDBOX-99', branch: 'agent/different' }],
  });

  assert.equal(result.requeued, 0);
  assert.equal(result.unchanged, 1);
  assert.equal(result.discarded, 0);

  const task = readTask(pipelineDir, 'HUB-SANDBOX-3');
  assert.equal(task.status, 'needs-work');
});

test('an inert half whose siblings are all merged is not requeued', () => {
  const pipelineDir = makePipelineDir();
  putTask(pipelineDir, 'HUB-SANDBOX-4', 'done', {
    status: 'needs-work',
    premium: { priority: 'medium' },
    promptContext: { rawText: 'Files: src/d.js' },
    history: [{ stage: 'applied', at: new Date().toISOString(), detail: 'agent/half' }],
    siblings: ['HUB-SANDBOX-4a', 'HUB-SANDBOX-4b'],
  });

  // Mark siblings as merged
  putTask(pipelineDir, 'HUB-SANDBOX-4a', 'done', { status: 'approved', terminalDisposition: 'merged' });
  putTask(pipelineDir, 'HUB-SANDBOX-4b', 'done', { status: 'approved', terminalDisposition: 'merged' });

  const result = sweepDoneUnmerged({
    pipelineDir,
    now: Date.now() + SETTLE_MS + 1000,
    shippedEntries: [{ taskId: 'HUB-SANDBOX-4', branch: 'agent/half' }],
  });

  assert.equal(result.requeued, 0);
  assert.equal(result.discarded, 1);

  // Verify the task was moved to archived
  const archived = JSON.parse(
    fs.readFileSync(path.join(pipelineDir, 'queue', 'done', '_archived_no_action', 'HUB-SANDBOX-4.json'), 'utf8')
  );
  assert.equal(archived.status, 'needs-work');
  assert.match(archived.history[archived.history.length - 1].stage, /discarded/);
});

test('the old branch is never deleted during requeue', () => {
  const pipelineDir = makePipelineDir();
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'done-unmerged-repo-'));
  const { execFileSync } = require('child_process');
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  // Setup a real git repo with a branch
  const bare = path.join(repoRoot, 'origin.git');
  const repo = path.join(repoRoot, 'repo');
  git(repoRoot, 'init', '--bare', '-b', 'main', bare);
  git(repoRoot, 'clone', '-q', bare, repo);
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'content\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'init'); git(repo, 'push', '-q', 'origin', 'main');

  // Create the branch
  git(repo, 'checkout', '-q', '-B', 'agent/keep-me', 'main');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'branch content\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'branch change'); git(repo, 'push', '-q', '-f', 'origin', 'agent/keep-me');
  git(repo, 'checkout', '-q', 'main');

  putTask(pipelineDir, 'HUB-SANDBOX-5', 'done', {
    status: 'needs-work',
    premium: { priority: 'high' },
    promptContext: { rawText: 'Files: src/e.js' },
    history: [{ stage: 'applied', at: new Date().toISOString(), detail: 'agent/keep-me' }],
  });

  sweepDoneUnmerged({
    pipelineDir,
    repoRoot,
    mainBranch: 'main',
    now: Date.now() + SETTLE_MS + 1000,
    shippedEntries: [{ taskId: 'HUB-SANDBOX-5', branch: 'agent/keep-me' }],
  });

  // Verify the branch still exists in the bare repo
  const branches = git(bare, 'branch', '--list').trim().split('\n');
  assert.ok(branches.some(b => b.trim() === 'agent/keep-me'), 'Branch should still exist');
});

test('a cross-project requeue lands in the owning project queue', () => {
  const pipelineDir = makePipelineDir();
  const otherPipelineDir = makePipelineDir();

  // Put task in source project
  putTask(pipelineDir, 'HUB-SANDBOX-6', 'done', {
    status: 'needs-work',
    premium: { priority: 'medium' },
    promptContext: { rawText: 'Files: src/f.js' },
    history: [{ stage: 'applied', at: new Date().toISOString(), detail: 'agent/cross' }],
    project: 'project-a',
  });

  const result = sweepDoneUnmerged({
    pipelineDir,
    otherPipelineDir,
    now: Date.now() + SETTLE_MS + 1000,
    shippedEntries: [{ taskId: 'HUB-SANDBOX-6', branch: 'agent/cross', targetProject: 'project-b' }],
  });

  assert.equal(result.requeued, 1);
  assert.equal(result.unchanged, 0);

  // Verify the task is in the target project's queue
  const requeued = JSON.parse(
    fs.readFileSync(path.join(otherPipelineDir, 'queue', 'pending', 'HUB-SANDBOX-6.json'), 'utf8')
  );
  assert.equal(requeued.status, 'pending');
  assert.equal(requeued.project, 'project-b');
});
