'use strict';

// Unit tests for apply-adhoc-diff.js, run against a real throwaway git repo (same fixture
// pattern as git-runner.test.js) -- proves a real unified diff (the exact shape
// adhoc-agentic-draft.js produces via `git diff` in an isolated worktree) actually lands
// via `git apply` against a separate real repo, the way apply-task.js's writeArtifact()
// really calls this.
//
// Run: node --test src/apply-adhoc-diff.test.js  (or `npm test`)

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { applyAdhocDiff } = require('./apply-adhoc-diff.js');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

function makeRepo() {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-adhoc-diff-test-'));
  git(['init', '-b', 'main', repoDir]);
  git(['config', 'user.email', 'test@example.com'], repoDir);
  git(['config', 'user.name', 'Test'], repoDir);
  fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'v1\n');
  git(['add', 'tracked.txt'], repoDir);
  git(['commit', '-m', 'init'], repoDir);
  return repoDir;
}

// A real unified diff, captured the same way adhoc-agentic-draft.js produces one --
// edit a SEPARATE clone, then `git diff` there, so this test never depends on knowing
// the exact byte-for-byte diff format by hand.
function makeRealDiff(baseRepoDir, mutate) {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-adhoc-diff-scratch-'));
  git(['clone', baseRepoDir, scratchDir]);
  git(['config', 'user.email', 'test@example.com'], scratchDir);
  git(['config', 'user.name', 'Test'], scratchDir);
  mutate(scratchDir);
  // add -A first -- plain `git diff` never shows a brand-new untracked file, only
  // already-tracked changes, same reasoning as adhoc-agentic-draft.js's own capture.
  git(['add', '-A'], scratchDir);
  return git(['diff', '--cached'], scratchDir);
}

test('applyAdhocDiff applies a real diff to the target repo and reports the touched file', () => {
  const repoDir = makeRepo();
  const rawDiff = makeRealDiff(repoDir, (dir) => fs.writeFileSync(path.join(dir, 'tracked.txt'), 'v2\n'));
  const task = { id: 'apply-test-1', rawDiff, implementResponse: 'summary', adhocResolution: 'implemented' };

  const result = applyAdhocDiff({ task, repoRoot: repoDir });

  assert.deepEqual(result.files, ['tracked.txt']);
  assert.equal(fs.readFileSync(path.join(repoDir, 'tracked.txt'), 'utf8'), 'v2\n');
});

test('applyAdhocDiff applies a real diff that creates a new file', () => {
  const repoDir = makeRepo();
  const rawDiff = makeRealDiff(repoDir, (dir) => fs.writeFileSync(path.join(dir, 'new-file.txt'), 'hello\n'));
  const task = { id: 'apply-test-2', rawDiff, implementResponse: 'summary', adhocResolution: 'implemented' };

  const result = applyAdhocDiff({ task, repoRoot: repoDir });

  assert.deepEqual(result.files, ['new-file.txt']);
  assert.equal(fs.readFileSync(path.join(repoDir, 'new-file.txt'), 'utf8'), 'hello\n');
});

test('applyAdhocDiff returns {skipped} when task.rawDiff is empty, without touching git', () => {
  const repoDir = makeRepo();
  const task = { id: 'apply-test-3', rawDiff: '', implementResponse: 'Already resolved, no change needed.', adhocResolution: 'no-changes-needed' };

  const result = applyAdhocDiff({ task, repoRoot: repoDir });

  assert.equal(result.skipped, true);
  assert.match(result.reason, /no code change needed/);
  assert.equal(fs.readFileSync(path.join(repoDir, 'tracked.txt'), 'utf8'), 'v1\n');
});

test('applyAdhocDiff applies a real diff whose hunk header line-count is wrong (regression: 2026-08-18 "corrupt patch" incident)', () => {
  // A plain `git apply` (no --recount) rejects a hunk whose "@@ -a,b +c,d @@" counts
  // don't match the actual hunk body as corrupt, even when the body itself is completely
  // valid -- confirmed live against a real adhoc-agentic-draft.js diff that failed this
  // way in production. Deliberately corrupt the header by hand here (a real diff's
  // header/body already agree, so this can't be reproduced through makeRealDiff() --
  // it has to be forced) to prove applyAdhocDiff's --recount flag tolerates it.
  const repoDir = makeRepo();
  const rawDiff = makeRealDiff(repoDir, (dir) => fs.writeFileSync(path.join(dir, 'tracked.txt'), 'v2\n'));
  const corrupted = rawDiff.replace(/^@@ -1 \+1 @@$/m, '@@ -1 +1,2 @@');
  assert.notEqual(corrupted, rawDiff, 'test setup: expected hunk header pattern not found in real diff -- update the regex to match makeRealDiff()\'s actual output');
  const task = { id: 'apply-test-recount', rawDiff: corrupted, implementResponse: 'summary', adhocResolution: 'implemented' };

  const result = applyAdhocDiff({ task, repoRoot: repoDir });

  assert.deepEqual(result.files, ['tracked.txt']);
  assert.equal(fs.readFileSync(path.join(repoDir, 'tracked.txt'), 'utf8'), 'v2\n');
});

test('applyAdhocDiff throws a clear error on a malformed diff, without leaving a stray patch file', () => {
  const repoDir = makeRepo();
  const task = { id: 'apply-test-4', rawDiff: 'this is not a real diff', implementResponse: 'summary' };

  assert.throws(() => applyAdhocDiff({ task, repoRoot: repoDir }), /git apply failed/);

  const stray = fs.readdirSync(os.tmpdir()).filter((f) => f.includes('apply-test-4'));
  assert.equal(stray.length, 0, 'temp patch file must be cleaned up even on failure');
});
