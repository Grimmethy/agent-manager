'use strict';

// Tests for verifyMergedWorkPresent (2026-09-16) -- the content-based "did this actually
// land" checker built after a real investigation mistake this session: a task's own
// history claimed terminalDisposition:'merged', its exact commit SHA was not a
// `git merge-base --is-ancestor` of current master (misread as "lost"), but the code had
// simply been relocated by an unrelated refactor -- git-ancestor checking a single SHA
// cannot distinguish "genuinely lost" from "refactored but present," only reading the
// CURRENT repo's real content can. Fixture cases below mirror the two real incidents this
// session actually hit: a file whose content is genuinely gone (draft-file-guard.js's
// lost wiring, 2026-09-10) vs. a file whose content moved into a DIFFERENT file entirely
// (the pre-filter fact-check block, moved from local-draft.js into lib/draft-context.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { verifyMergedWorkPresent, extractAddedLinesForFile, isMeaningfulLine } = require('./verify-merged-work.js');

function git(args, cwd) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-merged-work-test-'));
  git(['init', '-q'], root);
  git(['config', 'user.email', 'test@example.com'], root);
  git(['config', 'user.name', 'Test'], root);
  return root;
}

function commitFile(root, relPath, content) {
  const abs = path.join(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  git(['add', relPath], root);
  git(['commit', '-q', '-m', `add ${relPath}`], root);
}

test('isMeaningfulLine: skips short/trivial lines, keeps real content', () => {
  assert.equal(isMeaningfulLine('}'), false);
  assert.equal(isMeaningfulLine('  );'), false);
  assert.equal(isMeaningfulLine('x'), false, 'too short to mean anything on its own');
  assert.equal(isMeaningfulLine('function realFunctionName(task, options) {'), true);
});

test('extractAddedLinesForFile: isolates + lines for one file in a multi-file diff', () => {
  const diff = [
    'diff --git a/src/a.js b/src/a.js',
    'index 111..222 100644',
    '--- a/src/a.js',
    '+++ b/src/a.js',
    '@@ -1,2 +1,3 @@',
    ' const a = 1;',
    '+const addedInA = 2;',
    'diff --git a/src/b.js b/src/b.js',
    'index 333..444 100644',
    '--- a/src/b.js',
    '+++ b/src/b.js',
    '@@ -1,1 +1,2 @@',
    '+const addedInB = 3;',
  ].join('\n');
  assert.deepEqual(extractAddedLinesForFile(diff, 'src/a.js'), ['const addedInA = 2;']);
  assert.deepEqual(extractAddedLinesForFile(diff, 'src/b.js'), ['const addedInB = 3;']);
});

test('verifyMergedWorkPresent: content unchanged at the same path -> present', () => {
  const root = makeRepo();
  const realContent = 'function verifiedLine() { return "this exact distinctive content is here"; }\n';
  commitFile(root, 'src/target.js', realContent);
  const diff = [
    'diff --git a/src/target.js b/src/target.js',
    'index 000..111 100644',
    '--- a/src/target.js',
    '+++ b/src/target.js',
    '@@ -0,0 +1,1 @@',
    `+${realContent.trim()}`,
  ].join('\n');
  const result = verifyMergedWorkPresent(diff, root);
  assert.equal(result.verdict, 'present');
  assert.equal(result.ratio, 1);
  assert.equal(result.files[0].existsAtOriginalPath, true);
  assert.equal(result.files[0].relocatedTo, null);
});

test('verifyMergedWorkPresent: content genuinely absent everywhere -> missing (the real draft-file-guard incident shape)', () => {
  const root = makeRepo();
  commitFile(root, 'README.md', 'unrelated repo content\n');
  const diff = [
    'diff --git a/src/never-landed.js b/src/never-landed.js',
    'new file mode 100644',
    'index 000..111 100644',
    '--- /dev/null',
    '+++ b/src/never-landed.js',
    '@@ -0,0 +1,1 @@',
    '+function thisCodeWasNeverActuallyMergedAnywhere() {}',
  ].join('\n');
  const result = verifyMergedWorkPresent(diff, root);
  assert.equal(result.verdict, 'missing');
  assert.equal(result.files[0].existsAtOriginalPath, false);
  assert.equal(result.files[0].relocatedTo, null);
});

test('verifyMergedWorkPresent: file MOVED to a different directory (same basename) -> found via basename relocation', () => {
  const root = makeRepo();
  const realContent = 'function relocatedButStillHere() { return "distinctive marker line here"; }\n';
  commitFile(root, 'src/target.js', realContent); // same basename, different directory than the diff below
  const diff = [
    'diff --git a/src/deep/nested/target.js b/src/deep/nested/target.js',
    'new file mode 100644',
    'index 000..111 100644',
    '--- /dev/null',
    '+++ b/src/deep/nested/target.js',
    '@@ -0,0 +1,1 @@',
    `+${realContent.trim()}`,
  ].join('\n');
  const result = verifyMergedWorkPresent(diff, root);
  assert.equal(result.files[0].existsAtOriginalPath, false);
  assert.equal(result.files[0].relocatedTo, 'src/target.js');
  assert.equal(result.verdict, 'present');
});

test('verifyMergedWorkPresent: content moved into a DIFFERENT, differently-named file -> found via repo-wide grep fallback (the real preFilterFlags incident shape)', () => {
  const root = makeRepo();
  // The original file still exists (unrelated content) -- content moved to a NEW file
  // findByBasename could never match by name alone.
  commitFile(root, 'src/local-draft.js', 'function unrelatedSurvivingCode() { return 1; }\n');
  const movedLine = 'function preFilterFactCheckLogicThatMovedElsewhereEntirely() { return true; }';
  commitFile(root, 'src/lib/draft-context.js', `${movedLine}\n`);
  const diff = [
    'diff --git a/src/local-draft.js b/src/local-draft.js',
    'index 000..111 100644',
    '--- a/src/local-draft.js',
    '+++ b/src/local-draft.js',
    '@@ -1,1 +1,2 @@',
    ' function unrelatedSurvivingCode() { return 1; }',
    `+${movedLine}`,
  ].join('\n');
  const result = verifyMergedWorkPresent(diff, root);
  // Found via git-grep fallback, not at the original path and not a basename match either.
  assert.equal(result.files[0].existsAtOriginalPath, true);
  assert.equal(result.files[0].foundCount, 1);
  assert.equal(result.verdict, 'present');
});

test('verifyMergedWorkPresent: a delete-kind entry is listed but never verified (checked:false)', () => {
  const root = makeRepo();
  commitFile(root, 'README.md', 'x\n');
  const diff = [
    'diff --git a/src/gone.js b/src/gone.js',
    'deleted file mode 100644',
    'index 111..000 100644',
    '--- a/src/gone.js',
    '+++ /dev/null',
    '@@ -1,1 +0,0 @@',
    '-function thisWasDeletedOnPurpose() {}',
  ].join('\n');
  const result = verifyMergedWorkPresent(diff, root);
  assert.equal(result.files[0].checked, false);
  assert.equal(result.totalMeaningfulLines, 0);
  assert.equal(result.verdict, 'unknown');
});

test('verifyMergedWorkPresent: a diff with only trivial added lines -> unknown, not a false "missing"', () => {
  const root = makeRepo();
  commitFile(root, 'src/x.js', 'x\n');
  const diff = [
    'diff --git a/src/x.js b/src/x.js',
    'index 111..222 100644',
    '--- a/src/x.js',
    '+++ b/src/x.js',
    '@@ -1,1 +1,2 @@',
    ' x',
    '+}',
  ].join('\n');
  const result = verifyMergedWorkPresent(diff, root);
  assert.equal(result.verdict, 'unknown');
  assert.equal(result.ratio, null);
});

test('verifyMergedWorkPresent: accepts a task object (rawDiff field) as well as a raw diff string', () => {
  const root = makeRepo();
  const realContent = 'function fromTaskObject() { return "task-object-shape-marker"; }\n';
  commitFile(root, 'src/t.js', realContent);
  const task = {
    rawDiff: [
      'diff --git a/src/t.js b/src/t.js',
      'index 000..111 100644',
      '--- a/src/t.js',
      '+++ b/src/t.js',
      '@@ -0,0 +1,1 @@',
      `+${realContent.trim()}`,
    ].join('\n'),
  };
  const result = verifyMergedWorkPresent(task, root);
  assert.equal(result.verdict, 'present');
});

test('verifyMergedWorkPresent: falls back to the "=== DIFF ===" section of implementResponse when rawDiff is absent', () => {
  const root = makeRepo();
  const realContent = 'function fromImplementResponse() { return "implement-response-shape-marker"; }\n';
  commitFile(root, 'src/t2.js', realContent);
  const diffText = [
    'diff --git a/src/t2.js b/src/t2.js',
    'index 000..111 100644',
    '--- a/src/t2.js',
    '+++ b/src/t2.js',
    '@@ -0,0 +1,1 @@',
    `+${realContent.trim()}`,
  ].join('\n');
  const task = { implementResponse: `RESOLUTION: implemented\n\nsome summary text\n\n=== DIFF ===\n${diffText}\n` };
  const result = verifyMergedWorkPresent(task, root);
  assert.equal(result.verdict, 'present');
});
