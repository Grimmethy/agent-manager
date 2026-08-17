'use strict';

// Unit tests for adhoc-agentic-draft.js, run against a real throwaway git repo + bare
// "origin" in a temp dir (same fixture pattern as git-runner.test.js) -- never against
// this package's own repo. claudeCall is faked (no real Claude Code CLI call), but the
// worktree lifecycle (create, edit, capture diff, clean up) runs against real git, since
// that lifecycle -- not the model call itself -- is what this module actually adds.
//
// Run: node --test src/adhoc-agentic-draft.test.js  (or `npm test`)

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { draftAdhocImplement } = require('./adhoc-agentic-draft.js');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

function makeRepoWithOrigin() {
  const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhoc-draft-test-origin-'));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhoc-draft-test-repo-'));
  git(['init', '--bare', '-b', 'main', bareDir]);
  git(['clone', bareDir, repoDir]);
  git(['config', 'user.email', 'test@example.com'], repoDir);
  git(['config', 'user.name', 'Test'], repoDir);
  fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'v1\n');
  git(['add', 'tracked.txt'], repoDir);
  git(['commit', '-m', 'init'], repoDir);
  git(['push', 'origin', 'main'], repoDir);
  return { bareDir, repoDir };
}

function fakeRecordModelCall() {
  return 'fake-call-id';
}

test('draftAdhocImplement edits a real file in the isolated worktree and captures it as task.rawDiff', async () => {
  const { repoDir } = makeRepoWithOrigin();
  const task = { id: 'test-1', title: 'Bump the version comment', promptContext: { rawText: 'Change v1 to v2 in tracked.txt' } };

  const claudeCall = async ({ cwd }) => {
    // Simulates the agentic call actually editing a real file in the worktree it's given.
    fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'v2\n');
    return { response: 'Updated tracked.txt.\n\nRESOLUTION: implemented', degenerate: null };
  };

  const result = await draftAdhocImplement(task, { claudeCall, recordModelCall: fakeRecordModelCall, repoRoot: repoDir });

  assert.equal(result.succeeded, true);
  assert.equal(result.blocked, false);
  assert.equal(task.adhocResolution, 'implemented');
  assert.match(task.rawDiff, /-v1/);
  assert.match(task.rawDiff, /\+v2/);
  assert.match(task.implementResponse, /=== DIFF ===/);

  // Worktree and throwaway branch must both be cleaned up regardless of success.
  const worktreeList = git(['worktree', 'list'], repoDir);
  assert.equal(worktreeList.split('\n').filter(Boolean).length, 1, 'only the main worktree should remain');
  const branches = git(['branch', '--list', 'throwaway/adhoc-test-1'], repoDir);
  assert.equal(branches.trim(), '');
});

test('draftAdhocImplement leaves task.rawDiff empty when the agentic call makes no edits (no-changes-needed)', async () => {
  const { repoDir } = makeRepoWithOrigin();
  const task = { id: 'test-2', title: 'Already fixed', promptContext: { rawText: 'This was already fixed by an earlier commit' } };

  const claudeCall = async () => ({
    response: 'Checked git log -- this was already resolved by an earlier commit.\n\nRESOLUTION: no-changes-needed',
    degenerate: null,
  });

  const result = await draftAdhocImplement(task, { claudeCall, recordModelCall: fakeRecordModelCall, repoRoot: repoDir });

  assert.equal(result.succeeded, true);
  assert.equal(task.adhocResolution, 'no-changes-needed');
  assert.equal(task.rawDiff, '');
  assert.equal(task.implementResponse.includes('=== DIFF ==='), false);
});

test('draftAdhocImplement blocks (does not throw) when the response has no RESOLUTION line', async () => {
  const { repoDir } = makeRepoWithOrigin();
  const task = { id: 'test-3', title: 'Vague', promptContext: { rawText: 'do something' } };

  const claudeCall = async () => ({ response: 'I looked into it but I am not sure what to do.', degenerate: null });

  const result = await draftAdhocImplement(task, { claudeCall, recordModelCall: fakeRecordModelCall, repoRoot: repoDir });

  assert.equal(result.succeeded, true);
  assert.equal(result.blocked, true);
  assert.match(result.blockedReason, /RESOLUTION/);
});

test('draftAdhocImplement blocks on a degenerate response without touching git', async () => {
  const { repoDir } = makeRepoWithOrigin();
  const task = { id: 'test-4', title: 'x', promptContext: { rawText: 'x' } };

  const claudeCall = async () => ({ response: '', degenerate: 'empty' });

  const result = await draftAdhocImplement(task, { claudeCall, recordModelCall: fakeRecordModelCall, repoRoot: repoDir });

  assert.equal(result.succeeded, true);
  assert.equal(result.blocked, true);
  assert.match(result.blockedReason, /degenerate/);

  const worktreeList = git(['worktree', 'list'], repoDir);
  assert.equal(worktreeList.split('\n').filter(Boolean).length, 1);
});

test('draftAdhocImplement cleans up the worktree even when the agentic call throws', async () => {
  const { repoDir } = makeRepoWithOrigin();
  const task = { id: 'test-5', title: 'x', promptContext: { rawText: 'x' } };

  const claudeCall = async () => { throw new Error('simulated claude -p failure'); };

  const result = await draftAdhocImplement(task, { claudeCall, recordModelCall: fakeRecordModelCall, repoRoot: repoDir });

  assert.equal(result.succeeded, false);
  assert.match(result.reason, /simulated claude -p failure/);

  const worktreeList = git(['worktree', 'list'], repoDir);
  assert.equal(worktreeList.split('\n').filter(Boolean).length, 1, 'worktree must be cleaned up even on failure');
});
