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
const { draftAdhocImplement, parseSubTaskProposals, buildSandboxOpts } = require('./adhoc-agentic-draft.js');

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

// Regression, 2026-08-24: caught live -- a real adhoc draft's own summary noted "git log
// isn't usable in this worktree... gitdir path doesn't exist in this sandbox." Confirmed
// via direct reproduction: this deployment's own AGENT_MANAGER_REPO_ROOT
// (/media/wok/model-cache/agent-manager-apply-target) is itself a symlink to
// /media/model-cache/github/agent-manager-apply-target -- git's own gitdir: pointer
// canonicalizes to the REAL path, so binding the symlink path (what buildSandboxOpts used
// to do) left the path git actually needed completely unbound inside the sandbox.
test('buildSandboxOpts resolves repoRoot/worktreeDir through a symlink before building bind paths', () => {
  const realRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhoc-sandbox-real-repo-'));
  git(['init', '-b', 'main', realRepoDir]);
  git(['config', 'user.email', 'test@example.com'], realRepoDir);
  git(['config', 'user.name', 'Test'], realRepoDir);
  fs.writeFileSync(path.join(realRepoDir, 'f.txt'), 'v1\n');
  git(['add', 'f.txt'], realRepoDir);
  git(['commit', '-m', 'init'], realRepoDir);

  // The symlink IS what gets passed around as "repoRoot" -- same shape as
  // AGENT_MANAGER_REPO_ROOT pointing through /media/wok/model-cache's own symlink.
  const symlinkRepoDir = path.join(os.tmpdir(), `adhoc-sandbox-symlink-repo-${Date.now()}`);
  fs.symlinkSync(realRepoDir, symlinkRepoDir);

  const worktreeDir = path.join(os.tmpdir(), `adhoc-sandbox-worktree-${Date.now()}`);
  git(['worktree', 'add', worktreeDir, '-b', 'throwaway/sandbox-test', 'main'], symlinkRepoDir);

  const opts = buildSandboxOpts(symlinkRepoDir, worktreeDir);

  const realRepoRoot = fs.realpathSync(realRepoDir);
  assert.ok(opts.readOnlyBinds.includes(path.join(realRepoRoot, '.git')), 'must bind the REAL .git path, not the symlink');
  assert.equal(opts.readOnlyBinds.some((p) => p.includes(symlinkRepoDir)), false, 'must never bind the symlink path itself');
  const expectedWorktreeGitdir = path.join(realRepoRoot, '.git', 'worktrees', path.basename(fs.realpathSync(worktreeDir)));
  assert.ok(opts.writableBinds.includes(expectedWorktreeGitdir), 'writable worktree gitdir bind must also use the real, resolved path');
  assert.equal(opts.workDir, fs.realpathSync(worktreeDir));

  git(['worktree', 'remove', '--force', worktreeDir], realRepoDir);
});

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

// Regression, 2026-08-23: caught live -- a task that ran out of its turn budget mid-
// investigation (stop_reason:'tool_use', no RESOLUTION line) got blocked immediately,
// then the OUTER task-retry mechanism re-ran this whole function from scratch at the
// exact same ADHOC_MAX_TURNS, wasting a full expensive session with no reason to expect
// a different outcome.
test('draftAdhocImplement retries ONCE at a larger turn budget when the first attempt runs out of turns mid-investigation', async () => {
  const { repoDir } = makeRepoWithOrigin();
  const task = { id: 'test-6', title: 'Big task', promptContext: { rawText: 'a large task' } };

  const seenMaxTurns = [];
  let call = 0;
  const claudeCall = async ({ cwd, maxTurns }) => {
    seenMaxTurns.push(maxTurns);
    call += 1;
    if (call === 1) {
      // Ran out of turns mid-investigation -- no RESOLUTION line, stop_reason:'tool_use'.
      return { response: 'Still investigating the second half of this...', stopReason: 'tool_use', costUsd: 0.5 };
    }
    fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'v2\n');
    return { response: 'Finished on the retry.\n\nRESOLUTION: implemented', stopReason: 'end_turn', costUsd: 0.8 };
  };

  const result = await draftAdhocImplement(task, { claudeCall, recordModelCall: fakeRecordModelCall, repoRoot: repoDir });

  assert.equal(result.succeeded, true);
  assert.equal(result.blocked, false);
  assert.equal(task.adhocResolution, 'implemented');
  assert.equal(seenMaxTurns.length, 2, 'must call claudeCall exactly twice -- original attempt plus one retry');
  assert.ok(seenMaxTurns[1] > seenMaxTurns[0], `retry's maxTurns (${seenMaxTurns[1]}) must be meaningfully larger than the original (${seenMaxTurns[0]})`);
});

test('draftAdhocImplement gives up (does not retry a second time) when turns are exhausted twice in a row, and surfaces the combined cost', async () => {
  const { repoDir } = makeRepoWithOrigin();
  const task = { id: 'test-7', title: 'Very big task', promptContext: { rawText: 'a very large task' } };

  const seenMaxTurns = [];
  const claudeCall = async ({ maxTurns }) => {
    seenMaxTurns.push(maxTurns);
    return { response: 'Still investigating...', stopReason: 'tool_use', costUsd: 0.5 };
  };

  const result = await draftAdhocImplement(task, { claudeCall, recordModelCall: fakeRecordModelCall, repoRoot: repoDir });

  assert.equal(result.succeeded, true);
  assert.equal(result.blocked, true);
  assert.equal(seenMaxTurns.length, 2, 'must not retry a third time -- two exhaustions in a row means a bigger budget alone will not fix it');
  assert.match(result.blockedReason, /ran out of turns twice/);
  assert.match(result.blockedReason, /total_cost_usd=1\.0000/);
});

// 2026-08-24: "we had discussed setting up a task that breaks down jobs that are too
// large" -- RESOLUTION: decompose lets the agentic pass split an oversized task into
// smaller sub-tasks instead of blindly retrying/blocking on the same too-large task
// forever (the exact bootstrapping trap the task built to do this hit on itself).
test('draftAdhocImplement parses a valid RESOLUTION: decompose response into subTaskProposals, with no diff captured', async () => {
  const { repoDir } = makeRepoWithOrigin();
  const task = { id: 'test-9', title: 'Huge task', promptContext: { rawText: 'a huge multi-part task' } };

  const claudeCall = async () => ({
    response: 'Too large for one pass.\n\nRESOLUTION: decompose\n' +
      '[{"title": "Piece one", "rawText": "Do the first, independently-implementable piece."}, ' +
      '{"title": "Piece two", "rawText": "Do the second, independently-implementable piece."}]\n\n' +
      'Split into two independent pieces.',
    degenerate: null,
  });

  const result = await draftAdhocImplement(task, { claudeCall, recordModelCall: fakeRecordModelCall, repoRoot: repoDir });

  assert.equal(result.succeeded, true);
  assert.equal(result.blocked, false);
  assert.equal(task.adhocResolution, 'decompose');
  assert.equal(task.rawDiff, '');
  assert.equal(task.subTaskProposals.length, 2);
  assert.equal(task.subTaskProposals[0].title, 'Piece one');
  assert.match(task.subTaskProposals[1].rawText, /second, independently-implementable/);

  const worktreeList = git(['worktree', 'list'], repoDir);
  assert.equal(worktreeList.split('\n').filter(Boolean).length, 1, 'worktree must still be cleaned up');
});

test('draftAdhocImplement blocks when RESOLUTION: decompose is not followed by a valid sub-task JSON array', async () => {
  const { repoDir } = makeRepoWithOrigin();
  const task = { id: 'test-10', title: 'Huge task', promptContext: { rawText: 'x' } };

  const claudeCall = async () => ({
    response: 'Too large.\n\nRESOLUTION: decompose\n\nI would split this up but forgot the JSON.',
    degenerate: null,
  });

  const result = await draftAdhocImplement(task, { claudeCall, recordModelCall: fakeRecordModelCall, repoRoot: repoDir });

  assert.equal(result.succeeded, true);
  assert.equal(result.blocked, true);
  assert.match(result.blockedReason, /decompose but did not follow it with a valid JSON array/);
});

test('draftAdhocImplement blocks when RESOLUTION: decompose only proposes a single sub-task (not a real split)', async () => {
  const { repoDir } = makeRepoWithOrigin();
  const task = { id: 'test-11', title: 'Huge task', promptContext: { rawText: 'x' } };

  const claudeCall = async () => ({
    response: 'RESOLUTION: decompose\n[{"title": "Only one piece", "rawText": "just this"}]',
    degenerate: null,
  });

  const result = await draftAdhocImplement(task, { claudeCall, recordModelCall: fakeRecordModelCall, repoRoot: repoDir });

  assert.equal(result.blocked, true);
  assert.match(result.blockedReason, /at least 2/);
});

test('parseSubTaskProposals drops malformed entries but keeps valid ones', () => {
  const text = '[{"title": "Good", "rawText": "fine"}, {"title": ""}, {"rawText": "no title"}, {"title": "Also good", "rawText": "fine too"}]';
  const parsed = parseSubTaskProposals(text);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed.map((t) => t.title), ['Good', 'Also good']);
});

test('parseSubTaskProposals returns null when there is no JSON array in the text', () => {
  assert.equal(parseSubTaskProposals('no json here'), null);
});

// 2026-08-24: "Why is it declining to do the work?" -- root-caused live on the hardware-
// tracking-system task: adhoc-agentic-draft.js's own prompt already told the model to
// explain a genuine product/design decision instead of guessing, but the only resolutions
// available were implemented/no-changes-needed/decompose -- none of which honestly means
// "I have real open questions for a human." RESOLUTION: needs-human-decision closes that
// gap, mirroring local-agentic-draft.js's own needs-capability-i-dont-have.
test('draftAdhocImplement parses a RESOLUTION: needs-human-decision response and flags needsClarification', async () => {
  const { repoDir } = makeRepoWithOrigin();
  const task = { id: 'test-12', title: 'Hardware tracking system', promptContext: { rawText: 'add hardware monitoring' } };

  const claudeCall = async () => ({
    response: 'Investigated -- this repo has zero charting infrastructure today.\n\n' +
      'RESOLUTION: needs-human-decision\n\n' +
      'Which charting library should the new dashboard tab use, and what retention window for historical samples?',
    degenerate: null,
  });

  const result = await draftAdhocImplement(task, { claudeCall, recordModelCall: fakeRecordModelCall, repoRoot: repoDir });

  assert.equal(result.succeeded, true);
  assert.equal(result.blocked, false);
  assert.equal(result.needsClarification, true);
  assert.equal(task.adhocResolution, 'needs-human-decision');
  assert.equal(task.rawDiff, '');
  assert.match(task.implementResponse, /Which charting library/);

  const worktreeList = git(['worktree', 'list'], repoDir);
  assert.equal(worktreeList.split('\n').filter(Boolean).length, 1, 'worktree must still be cleaned up');
});

test('draftAdhocImplement does NOT retry when the response is degenerate rather than turn-exhausted', async () => {
  const { repoDir } = makeRepoWithOrigin();
  const task = { id: 'test-8', title: 'x', promptContext: { rawText: 'x' } };

  let calls = 0;
  const claudeCall = async () => { calls += 1; return { response: '', degenerate: 'empty', stopReason: 'end_turn' }; };

  const result = await draftAdhocImplement(task, { claudeCall, recordModelCall: fakeRecordModelCall, repoRoot: repoDir });

  assert.equal(result.blocked, true);
  assert.equal(calls, 1, 'a genuinely degenerate (not turn-exhausted) response must not trigger the turn-budget retry');
});
