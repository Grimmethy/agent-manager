'use strict';

// Unit tests for apply-group-b.js -- in particular the computed-inverse rollback added
// alongside the fix for a real gap (found live 2026-08-16): a partial multi-item batch
// failure used to leave already-applied items' writes sitting on disk, because
// apply-task.js's only cleanup on a write failure is abandoning the git branch
// (checkoutMain + deleteBranch), which does nothing for uncommitted working-tree writes --
// an untracked `create` persists regardless of branch, and an `edit` just rides along as a
// dirty change. This file's own internal rollback (undo already-applied items before
// propagating the failure) closes that gap independent of what the caller does with git.
//
// Run: node --test src/apply-group-b.test.js  (or `npm test`)

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { applyGroupB, batchContainsDeleteMode } = require('./apply-group-b.js');

function tmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apply-group-b-test-'));
}

test('applyGroupB creates a new file', () => {
  const repoRoot = tmpRepo();
  const result = applyGroupB({
    implementResponse: JSON.stringify({ mode: 'create', file: 'a.js', content: 'hello' }),
    repoRoot,
    pipelineDir: repoRoot,
  });
  assert.deepEqual(result.files, ['a.js']);
  assert.equal(fs.readFileSync(path.join(repoRoot, 'a.js'), 'utf8'), 'hello');
});

test('applyGroupB edits a file via a unique find/replace', () => {
  const repoRoot = tmpRepo();
  fs.writeFileSync(path.join(repoRoot, 'a.js'), 'const x = 1;\n');
  applyGroupB({
    implementResponse: JSON.stringify({ mode: 'edit', file: 'a.js', find: 'x = 1', replace: 'x = 2' }),
    repoRoot,
    pipelineDir: repoRoot,
  });
  assert.equal(fs.readFileSync(path.join(repoRoot, 'a.js'), 'utf8'), 'const x = 2;\n');
});

test('applyGroupB rolls back an earlier successful create when a later item in the same batch fails', () => {
  const repoRoot = tmpRepo();
  const batch = [
    { mode: 'create', file: 'new-file.js', content: 'export const x = 1;\n' },
    { mode: 'edit', file: 'does-not-exist.js', find: 'x', replace: 'y' },
  ];
  assert.throws(
    () => applyGroupB({ implementResponse: JSON.stringify(batch), repoRoot, pipelineDir: repoRoot }),
    /does-not-exist\.js/,
  );
  // The create from item 1 must not survive -- this is the actual bug: a plain
  // `git checkout main` never touches an untracked file regardless of which branch it's on.
  assert.equal(fs.existsSync(path.join(repoRoot, 'new-file.js')), false);
});

test('applyGroupB rolls back an earlier successful edit (restores exact prior bytes) when a later item fails', () => {
  const repoRoot = tmpRepo();
  fs.writeFileSync(path.join(repoRoot, 'a.js'), 'const x = 1;\nconst y = 2;\n');
  const batch = [
    { mode: 'edit', file: 'a.js', find: 'x = 1', replace: 'x = 99' },
    { mode: 'delete', file: 'does-not-exist.js' },
  ];
  assert.throws(() => applyGroupB({ implementResponse: JSON.stringify(batch), repoRoot, pipelineDir: repoRoot }));
  assert.equal(fs.readFileSync(path.join(repoRoot, 'a.js'), 'utf8'), 'const x = 1;\nconst y = 2;\n');
});

test('applyGroupB rolls back an earlier successful delete (recreates exact prior bytes) when a later item fails', () => {
  const repoRoot = tmpRepo();
  fs.writeFileSync(path.join(repoRoot, 'a.js'), 'export const x = 1;\n');
  const batch = [
    { mode: 'delete', file: 'a.js' },
    { mode: 'edit', file: 'does-not-exist.js', find: 'x', replace: 'y' },
  ];
  assert.throws(() => applyGroupB({ implementResponse: JSON.stringify(batch), repoRoot, pipelineDir: repoRoot }));
  assert.equal(fs.readFileSync(path.join(repoRoot, 'a.js'), 'utf8'), 'export const x = 1;\n');
});

test('applyGroupB rolls back multiple already-applied items in reverse order when a later item fails', () => {
  const repoRoot = tmpRepo();
  fs.writeFileSync(path.join(repoRoot, 'existing.js'), 'const a = 1;\n');
  const batch = [
    { mode: 'create', file: 'brand-new.js', content: 'x\n' },
    { mode: 'edit', file: 'existing.js', find: 'a = 1', replace: 'a = 2' },
    { mode: 'edit', file: 'nope.js', find: 'x', replace: 'y' },
  ];
  assert.throws(() => applyGroupB({ implementResponse: JSON.stringify(batch), repoRoot, pipelineDir: repoRoot }));
  assert.equal(fs.existsSync(path.join(repoRoot, 'brand-new.js')), false);
  assert.equal(fs.readFileSync(path.join(repoRoot, 'existing.js'), 'utf8'), 'const a = 1;\n');
});

test('applyGroupB reports (not swallows) a rollback failure alongside the original error', () => {
  const repoRoot = tmpRepo();
  const nestedDir = path.join(repoRoot, 'locked-dir');
  fs.mkdirSync(nestedDir);
  const createdPath = path.join(nestedDir, 'created.js');
  const batch = [
    { mode: 'create', file: 'locked-dir/created.js', content: 'x\n' },
    { mode: 'edit', file: 'nope.js', find: 'x', replace: 'y' },
  ];
  // Make the containing directory read-only AFTER the create succeeds is hard to simulate
  // deterministically cross-platform, so instead verify the success path directly: revert
  // of a 'create' is a plain unlink, which only fails if the file is already gone -- delete
  // it out from under the rollback to force that failure branch.
  const originalUnlink = fs.unlinkSync;
  let unlinkCalls = 0;
  fs.unlinkSync = (p) => {
    unlinkCalls += 1;
    if (p === createdPath) throw new Error('simulated unlink failure');
    return originalUnlink(p);
  };
  try {
    assert.throws(
      () => applyGroupB({ implementResponse: JSON.stringify(batch), repoRoot, pipelineDir: repoRoot }),
      /nope\.js.*rollback.*failure|simulated unlink failure/s,
    );
  } finally {
    fs.unlinkSync = originalUnlink;
  }
  assert.equal(unlinkCalls > 0, true);
});

test('applyGroupB does not attempt any rollback when the very first item fails (nothing yet applied)', () => {
  const repoRoot = tmpRepo();
  assert.throws(
    () => applyGroupB({
      implementResponse: JSON.stringify({ mode: 'edit', file: 'nope.js', find: 'x', replace: 'y' }),
      repoRoot,
      pipelineDir: repoRoot,
    }),
    (err) => !/rolled back|rollback/.test(err.message),
  );
});

test('batchContainsDeleteMode is true for a single delete-mode object', () => {
  assert.equal(batchContainsDeleteMode(JSON.stringify({ mode: 'delete', file: 'a.js' })), true);
});

test('batchContainsDeleteMode is true when any item in an array batch is delete-mode', () => {
  const batch = [
    { mode: 'create', file: 'a.js', content: 'x' },
    { mode: 'delete', file: 'b.js' },
  ];
  assert.equal(batchContainsDeleteMode(JSON.stringify(batch)), true);
});

test('batchContainsDeleteMode is false for a create/edit-only batch', () => {
  const batch = [
    { mode: 'create', file: 'a.js', content: 'x' },
    { mode: 'edit', file: 'b.js', find: 'x', replace: 'y' },
  ];
  assert.equal(batchContainsDeleteMode(JSON.stringify(batch)), false);
});

test('batchContainsDeleteMode is false (not throwing) on malformed JSON -- best-effort look-ahead only', () => {
  assert.equal(batchContainsDeleteMode('not json at all'), false);
  assert.equal(batchContainsDeleteMode(''), false);
  assert.equal(batchContainsDeleteMode(undefined), false);
});

test('batchContainsDeleteMode handles a ```json-fenced response the same as applyGroupB does', () => {
  const fenced = '```json\n' + JSON.stringify({ mode: 'delete', file: 'a.js' }) + '\n```';
  assert.equal(batchContainsDeleteMode(fenced), true);
});

test('applyGroupB leaves a fully successful batch untouched (no rollback path taken)', () => {
  const repoRoot = tmpRepo();
  const batch = [
    { mode: 'create', file: 'a.js', content: 'a\n' },
    { mode: 'create', file: 'b.js', content: 'b\n' },
  ];
  const result = applyGroupB({ implementResponse: JSON.stringify(batch), repoRoot, pipelineDir: repoRoot });
  assert.deepEqual(result.files, ['a.js', 'b.js']);
  assert.equal(fs.readFileSync(path.join(repoRoot, 'a.js'), 'utf8'), 'a\n');
  assert.equal(fs.readFileSync(path.join(repoRoot, 'b.js'), 'utf8'), 'b\n');
});
