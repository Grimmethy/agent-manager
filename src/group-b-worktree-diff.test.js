'use strict';

// Same real-throwaway-git-repo fixture pattern as adhoc-agentic-draft.test.js (see its own
// header) -- the worktree lifecycle (create, apply, capture diff, clean up) runs against
// real git, since that lifecycle is exactly what this module adds on top of applyGroupB.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { captureGroupBDiffInWorktree, normalizeDiffOutput } = require('./group-b-worktree-diff.js');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

function makeRepoWithOrigin() {
  const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'groupb-worktree-test-origin-'));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'groupb-worktree-test-repo-'));
  git(['init', '--bare', '-b', 'main', bareDir]);
  git(['clone', bareDir, repoDir]);
  git(['config', 'user.email', 'test@example.com'], repoDir);
  git(['config', 'user.name', 'Test'], repoDir);
  fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'v1\n');
  git(['add', 'tracked.txt'], repoDir);
  git(['commit', '-m', 'init'], repoDir);
  git(['push', 'origin', 'main'], repoDir);
  return { repoDir };
}

function listWorktrees(repoDir) {
  return git(['worktree', 'list'], repoDir);
}

test('captureGroupBDiffInWorktree applies an edit against an isolated worktree and returns a real diff', () => {
  const { repoDir } = makeRepoWithOrigin();
  const implementResponse = JSON.stringify({ mode: 'edit', file: 'tracked.txt', find: 'v1', replace: 'v2' });

  const diff = captureGroupBDiffInWorktree({
    repoRoot: repoDir, pipelineDir: repoDir, implementResponse, worktreeSuffix: 'test-edit',
  });

  assert.match(diff, /-v1/);
  assert.match(diff, /\+v2/);
  // Real repo's own tracked.txt must be untouched -- the change only ever landed in the worktree.
  assert.equal(fs.readFileSync(path.join(repoDir, 'tracked.txt'), 'utf8'), 'v1\n');
});

test('captureGroupBDiffInWorktree handles a create', () => {
  const { repoDir } = makeRepoWithOrigin();
  const implementResponse = JSON.stringify({ mode: 'create', file: 'new-file.txt', content: 'hello\n' });

  const diff = captureGroupBDiffInWorktree({
    repoRoot: repoDir, pipelineDir: repoDir, implementResponse, worktreeSuffix: 'test-create',
  });

  assert.match(diff, /new-file\.txt/);
  assert.match(diff, /\+hello/);
  assert.equal(fs.existsSync(path.join(repoDir, 'new-file.txt')), false);
});

test('captureGroupBDiffInWorktree cleans up the worktree and branch even on success', () => {
  const { repoDir } = makeRepoWithOrigin();
  const implementResponse = JSON.stringify({ mode: 'edit', file: 'tracked.txt', find: 'v1', replace: 'v2' });

  captureGroupBDiffInWorktree({ repoRoot: repoDir, pipelineDir: repoDir, implementResponse, worktreeSuffix: 'test-cleanup' });

  assert.doesNotMatch(listWorktrees(repoDir), /agent-manager-groupb-worktree-test-cleanup/);
  const branches = git(['branch', '--list', 'throwaway/*'], repoDir);
  assert.equal(branches.trim(), '');
});

test('captureGroupBDiffInWorktree throws (and still cleans up) when the find string does not match', () => {
  const { repoDir } = makeRepoWithOrigin();
  const implementResponse = JSON.stringify({ mode: 'edit', file: 'tracked.txt', find: 'this text is not in the file', replace: 'x' });

  assert.throws(() => captureGroupBDiffInWorktree({
    repoRoot: repoDir, pipelineDir: repoDir, implementResponse, worktreeSuffix: 'test-fail',
  }), /find string not found/);

  assert.doesNotMatch(listWorktrees(repoDir), /agent-manager-groupb-worktree-test-fail/);
});

test('captureGroupBDiffInWorktree throws on malformed Group-B JSON', () => {
  const { repoDir } = makeRepoWithOrigin();

  assert.throws(() => captureGroupBDiffInWorktree({
    repoRoot: repoDir, pipelineDir: repoDir, implementResponse: 'not json at all', worktreeSuffix: 'test-malformed',
  }), /Invalid JSON/);
});

test('captureGroupBDiffInWorktree handles a multi-file array batch', () => {
  const { repoDir } = makeRepoWithOrigin();
  const implementResponse = JSON.stringify([
    { mode: 'edit', file: 'tracked.txt', find: 'v1', replace: 'v2' },
    { mode: 'create', file: 'second.txt', content: 'second\n' },
  ]);

  const diff = captureGroupBDiffInWorktree({
    repoRoot: repoDir, pipelineDir: repoDir, implementResponse, worktreeSuffix: 'test-multi',
  });

  assert.match(diff, /tracked\.txt/);
  assert.match(diff, /second\.txt/);
});

// 2026-09-08, root-caused live (autodecomp-...-04-system-and-project-js, applied via
// tryDeterministicScriptExtractEdit): `.trim()` on a real `git diff --cached` output
// strips its essential trailing newline along with any incidental leading/trailing
// whitespace, silently corrupting the last hunk -- confirmed directly via `git apply
// --check` on the actual stored rawDiff ("corrupt patch at line N", missing the final
// newline after the last hunk's last content line). normalizeDiffOutput replaces the bare
// `.trim()` call and must always restore exactly one trailing newline on a real diff.

test('normalizeDiffOutput restores exactly one trailing newline on a real diff', () => {
  const raw = 'diff --git a/x.js b/x.js\n--- a/x.js\n+++ b/x.js\n@@ -1,1 +1,1 @@\n-old\n+new\n';
  assert.equal(normalizeDiffOutput(raw), raw); // already well-formed -- unchanged
  assert.equal(normalizeDiffOutput(raw.trimEnd()), raw, 'a diff missing its trailing newline must get exactly one restored');
  assert.equal(normalizeDiffOutput(`${raw}\n\n\n`), raw, 'excess trailing blank lines collapse to exactly one newline');
  assert.equal(normalizeDiffOutput(`\n\n${raw}`), raw, 'incidental leading whitespace is stripped, same as the .trim() this replaces');
});

test('normalizeDiffOutput returns \'\' unchanged for an empty or whitespace-only diff (the real "no net change" case)', () => {
  assert.equal(normalizeDiffOutput(''), '');
  assert.equal(normalizeDiffOutput('   \n  \n'), '');
  assert.equal(normalizeDiffOutput(null), '');
  assert.equal(normalizeDiffOutput(undefined), '');
});

test('captureGroupBDiffInWorktree: the real captured diff ends with exactly one trailing newline and applies cleanly via git apply --check', () => {
  const { repoDir } = makeRepoWithOrigin();
  // A multi-line file so the diff's own last hunk has real trailing content, the same
  // shape as the real incident (a large multi-symbol move whose last hunk's last line is
  // exactly the diff's own last byte).
  fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'v1\nline2\nline3\n');
  git(['add', 'tracked.txt'], repoDir);
  git(['commit', '-m', 'multi-line base'], repoDir);
  git(['push', 'origin', 'main'], repoDir);

  const implementResponse = JSON.stringify({ mode: 'edit', file: 'tracked.txt', find: 'line3', replace: 'line3-edited' });
  const diff = captureGroupBDiffInWorktree({
    repoRoot: repoDir, pipelineDir: repoDir, implementResponse, worktreeSuffix: 'test-trailing-newline',
  });

  assert.match(diff, /\n$/, 'the captured diff must end with a real trailing newline, not be corrupted by .trim()');
  assert.doesNotMatch(diff, /[^\n]$/, 'the diff must not end mid-line');

  const patchPath = path.join(os.tmpdir(), `verify-patch-${Date.now()}.diff`);
  fs.writeFileSync(patchPath, diff);
  try {
    assert.doesNotThrow(() => git(['apply', '--check', patchPath], repoDir), 'a well-formed diff must pass git apply --check cleanly');
  } finally {
    fs.rmSync(patchPath, { force: true });
  }
});
