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

function readQueuedAdhocTasks(pipelineDir) {
  const adhocDir = path.join(pipelineDir, 'queue', 'adhoc');
  return fs.readdirSync(adhocDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(adhocDir, f), 'utf8')));
}

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

// --- 2026-08-24 (pipeline hardening): --3way fallback ----------------------------------
// Caught live: a real adhoc task's diff conflicted with an unrelated sibling task's own
// change that landed on the same file between this draft's worktree being cut and apply
// actually running. Plain `git apply` only does context-line matching; `git apply --3way`
// does a real content-based three-way merge using the diff's own base blob, which
// resolves this class of conflict (the actual edited lines are untouched, something
// UNRELATED nearby shifted) automatically.
//
// Default 3-line diff context (makeRealDiff, same as production) is used for both tests
// below -- confirmed live while writing these tests that a -U0 (zero-context) diff
// doesn't work with git's own --3way merge fallback at all (it degrades to "Falling
// back to direct application" and fails the same way plain apply does), so the fixture
// has to match what adhoc-agentic-draft.js's real `git diff` capture actually produces,
// not an artificially minimal one. The unrelated insertion below (3 lines) is enough to
// exceed plain `git apply`'s own default fuzzy context-search tolerance -- confirmed by
// this test failing on plain apply before the --3way fallback was added.
function makeMultilineRepo() {
  const repoDir = makeRepo();
  fs.writeFileSync(path.join(repoDir, 'multi.txt'), 'a\nb\nc\nd\ne\nf\ng\nh\n');
  git(['add', 'multi.txt'], repoDir);
  git(['commit', '-m', 'add multi.txt'], repoDir);
  return repoDir;
}

test('applyAdhocDiff falls back to --3way and still succeeds when an unrelated change elsewhere in the file breaks plain context matching', () => {
  const repoDir = makeMultilineRepo();
  const rawDiff = makeRealDiff(repoDir, (dir) => {
    fs.writeFileSync(path.join(dir, 'multi.txt'), 'a\nb\nc-changed\nd\ne\nf\ng\nh\n');
  });

  // Simulates a sibling task's own unrelated change landing on the real repo in between
  // this draft's worktree being cut and apply actually running -- an insertion far from
  // the line actually being edited, but one that shifts every line number below it,
  // exactly the shape of the real incident this fix exists for.
  fs.writeFileSync(path.join(repoDir, 'multi.txt'), 'x\ny\nz\na\nb\nc\nd\ne\nf\ng\nh\n');
  git(['add', 'multi.txt'], repoDir);
  git(['commit', '-m', 'unrelated sibling change'], repoDir);

  const task = { id: 'apply-test-3way-1', rawDiff, implementResponse: 'summary', adhocResolution: 'implemented' };
  const result = applyAdhocDiff({ task, repoRoot: repoDir });

  assert.deepEqual(result.files, ['multi.txt']);
  assert.equal(fs.readFileSync(path.join(repoDir, 'multi.txt'), 'utf8'), 'x\ny\nz\na\nb\nc-changed\nd\ne\nf\ng\nh\n', 'both the sibling\'s unrelated insertion AND this draft\'s real edit should survive');
});

test('applyAdhocDiff still fails (does not silently corrupt the file) when the SAME line was genuinely changed differently -- a real conflict, not just a shift', () => {
  const repoDir = makeMultilineRepo();
  const rawDiff = makeRealDiff(repoDir, (dir) => {
    fs.writeFileSync(path.join(dir, 'multi.txt'), 'a\nb\nc-changed-by-draft\nd\ne\nf\ng\nh\n');
  });

  // A genuine conflict this time: the SAME line the draft wants to change was ALREADY
  // changed to something else entirely -- neither plain apply NOR a real 3-way merge can
  // honestly reconcile two different edits to the same line without a human.
  fs.writeFileSync(path.join(repoDir, 'multi.txt'), 'a\nb\nc-changed-by-someone-else\nd\ne\nf\ng\nh\n');
  git(['add', 'multi.txt'], repoDir);
  git(['commit', '-m', 'conflicting change to the same line'], repoDir);

  const task = { id: 'apply-test-3way-2', rawDiff, implementResponse: 'summary', adhocResolution: 'implemented' };

  assert.throws(() => applyAdhocDiff({ task, repoRoot: repoDir }), /git apply failed/);
  assert.equal(fs.readFileSync(path.join(repoDir, 'multi.txt'), 'utf8'), 'a\nb\nc-changed-by-someone-else\nd\ne\nf\ng\nh\n', 'a genuine conflict must leave the real file untouched, not half-applied');
  // The failed --3way attempt marks the index itself unmerged (stage U) before this
  // cleanup runs -- confirmed live this is a real, separate thing from the working tree
  // content being right; a leftover unmerged index entry would break whatever git
  // command runs next in this worktree even with the FILE content already restored.
  assert.equal(git(['status', '--porcelain'], repoDir).trim(), '', 'the index must be fully clean after a failed apply, not left mid-conflict');
});

// 2026-08-24: applying a RESOLUTION: decompose draft queues each sub-task as a fresh
// adhoc task in queue/adhoc/ (the same location/schema queue-adhoc-task.js already uses,
// so nextAdhocTask() picks them up exactly like any human-queued adhoc task) instead of
// touching git at all -- there is no diff to apply for this resolution.
test('applyAdhocDiff queues each sub-task into queue/adhoc/ for a RESOLUTION: decompose draft, without touching git', () => {
  const repoDir = makeRepo();
  const pipelineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-adhoc-diff-pipeline-'));
  const task = {
    id: 'apply-test-decompose-1',
    rawDiff: '',
    implementResponse: 'Too large. Split into two.',
    adhocResolution: 'decompose',
    subTaskProposals: [
      { title: 'Piece one', rawText: 'Do the first independently-implementable piece.' },
      { title: 'Piece two', rawText: 'Do the second independently-implementable piece.' },
    ],
  };

  const result = applyAdhocDiff({ task, repoRoot: repoDir, pipelineDir });

  assert.equal(result.skipped, true);
  assert.match(result.reason, /Decomposed into 2 sub-task/);
  assert.equal(fs.readFileSync(path.join(repoDir, 'tracked.txt'), 'utf8'), 'v1\n', 'must never touch the target repo');

  const queued = readQueuedAdhocTasks(pipelineDir);
  assert.equal(queued.length, 2);
  assert.deepEqual(queued.map((t) => t.title).sort(), ['Piece one', 'Piece two']);
  for (const q of queued) {
    assert.equal(q.domain, 'adhoc');
    assert.equal(q.source, 'manual');
    assert.equal(q.promptContext.decomposedFrom, 'apply-test-decompose-1');
    assert.ok(q.promptContext.rawText.length > 0);
  }
});

test('applyAdhocDiff returns {skipped} without queuing anything when a decompose draft has no surviving sub-task proposals', () => {
  const repoDir = makeRepo();
  const pipelineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-adhoc-diff-pipeline-'));
  const task = { id: 'apply-test-decompose-2', rawDiff: '', adhocResolution: 'decompose', subTaskProposals: [] };

  const result = applyAdhocDiff({ task, repoRoot: repoDir, pipelineDir });

  assert.equal(result.skipped, true);
  assert.match(result.reason, /no sub-task proposals survived/);
  assert.equal(fs.existsSync(path.join(pipelineDir, 'queue', 'adhoc')), false);
});

test('applyAdhocDiff throws a clear error on a malformed diff, without leaving a stray patch file', () => {
  const repoDir = makeRepo();
  const task = { id: 'apply-test-4', rawDiff: 'this is not a real diff', implementResponse: 'summary' };

  assert.throws(() => applyAdhocDiff({ task, repoRoot: repoDir }), /git apply failed/);

  const stray = fs.readdirSync(os.tmpdir()).filter((f) => f.includes('apply-test-4'));
  assert.equal(stray.length, 0, 'temp patch file must be cleaned up even on failure');
});
