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

// 2026-09-14, screaminggoatclubmt: "please dig into it" -- root-caused live: a real
// decompose of local-draft.js extracted runCritiqueAndRevision (which deliberately
// embeds a literal NUL byte as a guaranteed-unique string-key separator, `${a}\0${b}`,
// perfectly valid JS) into its own small new file -- git's own binary-content heuristic
// classified that NEW file as binary, and the captured `git diff --cached` (no
// --full-index/--binary) produced a patch `git apply` later refused outright: "cannot
// apply binary patch to '...' without full index line". This proves the fix for real:
// captures a diff for a NUL-containing new file, then actually APPLIES that exact diff
// to a completely separate fresh checkout (not just asserting the patch text LOOKS
// right) and checks the result is byte-for-byte identical, NUL included.
test('captureGroupBDiffInWorktree: a created file containing a literal NUL byte (git classifies it as binary) produces a diff that actually applies elsewhere, byte-for-byte', () => {
  const { repoDir } = makeRepoWithOrigin();
  const content = 'function f() {\n  const seen = new Set(["a\0b"]);\n  return seen;\n}\nmodule.exports = { f };\n';
  const implementResponse = JSON.stringify({ mode: 'create', file: 'nul-fixture.js', content });

  const diff = captureGroupBDiffInWorktree({
    repoRoot: repoDir, pipelineDir: repoDir, implementResponse, worktreeSuffix: 'test-nul-binary',
  });

  assert.match(diff, /GIT binary patch/, 'sanity: this fixture really does trip git\'s binary-content heuristic');
  // The bug's exact fingerprint: a binary patch with an ABBREVIATED index line has no
  // '..' between two full 40-char hashes.
  assert.match(diff, /^index [0-9a-f]{40}\.\.[0-9a-f]{40}/m, 'index line must carry full (not abbreviated) SHAs for a binary patch to be appliable');

  // Apply the exact captured diff to a totally separate, freshly-cloned checkout --
  // proves it works end to end, not just that the patch text looks plausible.
  const applyTargetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'groupb-worktree-apply-target-'));
  git(['clone', repoDir, applyTargetDir]);
  const patchFile = path.join(os.tmpdir(), `nul-fixture-${Date.now()}.patch`);
  fs.writeFileSync(patchFile, diff);
  git(['apply', patchFile], applyTargetDir);
  const applied = fs.readFileSync(path.join(applyTargetDir, 'nul-fixture.js'));
  assert.equal(applied.toString('binary'), content, 'applied content must byte-for-byte match, NUL included');
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

// --- stacked-branch awareness (2026-09-09) ----------------------------------------------
// Root-caused live: file-decompose-hub-autodecomp-adhoc-add-job-stage-groups-... -- a
// stacked sub-task's diff got captured against origin/main, not the shared stacked branch
// (already carrying earlier sibling moves at different content) -- verified clean in
// isolation, then failed a real `git apply` once actually applied to the real branch.

function makeRepoWithStackedBranch() {
  const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'groupb-worktree-stacked-origin-'));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'groupb-worktree-stacked-repo-'));
  git(['init', '--bare', '-b', 'main', bareDir]);
  git(['clone', bareDir, repoDir]);
  git(['config', 'user.email', 'test@example.com'], repoDir);
  git(['config', 'user.name', 'Test'], repoDir);
  fs.writeFileSync(path.join(repoDir, 'shared.txt'), 'original\n');
  git(['add', 'shared.txt'], repoDir);
  git(['commit', '-m', 'init'], repoDir);
  git(['push', 'origin', 'main'], repoDir);

  // The stacked branch diverges from main -- a sibling move already landed there.
  git(['checkout', '-b', 'agent/stacked-family'], repoDir);
  fs.writeFileSync(path.join(repoDir, 'shared.txt'), 'sibling-already-changed-this\n');
  git(['add', 'shared.txt'], repoDir);
  git(['commit', '-m', 'sibling move already landed here'], repoDir);
  git(['push', 'origin', 'agent/stacked-family'], repoDir);
  git(['checkout', 'main'], repoDir);

  return { repoDir };
}

test('captureGroupBDiffInWorktree captures against the stacked branch, not main, when task.stacked.branch is given', () => {
  const { repoDir } = makeRepoWithStackedBranch();
  const task = { id: 't1', stacked: { branch: 'agent/stacked-family' } };
  const implementResponse = JSON.stringify({
    mode: 'edit', file: 'shared.txt', find: 'sibling-already-changed-this', replace: 'and-now-this-too',
  });
  const diff = captureGroupBDiffInWorktree({
    repoRoot: repoDir, pipelineDir: repoDir, implementResponse, worktreeSuffix: 'test-stacked', task,
  });
  assert.match(diff, /-sibling-already-changed-this/);
  assert.match(diff, /\+and-now-this-too/);
});

test('captureGroupBDiffInWorktree still captures against main when task is not stacked (unchanged behavior)', () => {
  const { repoDir } = makeRepoWithStackedBranch();
  const implementResponse = JSON.stringify({ mode: 'edit', file: 'shared.txt', find: 'original', replace: 'changed-on-main' });
  const diff = captureGroupBDiffInWorktree({
    repoRoot: repoDir, pipelineDir: repoDir, implementResponse, worktreeSuffix: 'test-nonstacked',
  });
  assert.match(diff, /-original/);
  assert.match(diff, /\+changed-on-main/);
});

test('captureGroupBDiffInWorktree throws (not silently applies against the wrong branch) when the edit find only matches the stacked branch and no task is given', () => {
  const { repoDir } = makeRepoWithStackedBranch();
  const implementResponse = JSON.stringify({
    mode: 'edit', file: 'shared.txt', find: 'sibling-already-changed-this', replace: 'x',
  });
  assert.throws(() => captureGroupBDiffInWorktree({
    repoRoot: repoDir, pipelineDir: repoDir, implementResponse, worktreeSuffix: 'test-wrong-base',
  }), /find string not found/);
});
