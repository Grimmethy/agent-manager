'use strict';

// Unit tests for get-grounding-source.js -- assembles the review-time "grounding source"
// text. New coverage (2026-08-24, "Fix the grounding gap"): the live current-repo
// enrichment for adhoc tasks, added after a real false-reject -- a decompose sub-task
// correctly described src/model-stats-client.js's real recordCall() signature, but got
// rejected as "unverified" because the task's own promptContext was a stale, task-
// creation-time snapshot that never captured that file (or captured a different one).
//
// Run: node --test src/get-grounding-source.test.js  (or `npm test`)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// get-grounding-source.js's own require-time ensureRegistered() (config.js) throws if
// AGENT_MANAGER_REPO_ROOT is unset -- same throwaway-value convention review-task.test.js/
// apply-task.test.js already use for the identical requirement. Forced (not `||`-defaulted)
// unconditionally -- see apply-task.test.js's own comment on this exact line for why an
// ambient real AGENT_MANAGER_REPO_ROOT must never be allowed to leak into a test run.
process.env.AGENT_MANAGER_REPO_ROOT = os.tmpdir();
process.env.AGENT_MANAGER_PIPELINE_DIR = process.env.AGENT_MANAGER_REPO_ROOT;

const { extractLiveRepoGrounding } = require('./get-grounding-source.js');

function makeRepoWithFile(relPath, content) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'grounding-test-repo-'));
  const full = path.join(repoRoot, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return repoRoot;
}

test('extractLiveRepoGrounding fetches the current real content of a file the draft references', () => {
  const repoRoot = makeRepoWithFile('src/foo.js', 'module.exports = { bar: 1 };\n');
  const found = extractLiveRepoGrounding('This claims src/foo.js exports { bar: 1 }.', repoRoot);
  assert.equal(found.length, 1);
  assert.equal(found[0].path, 'src/foo.js');
  assert.equal(found[0].content, 'module.exports = { bar: 1 };\n');
});

test('extractLiveRepoGrounding skips a path-shaped string that is not a real file, without throwing', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'grounding-test-repo-'));
  const found = extractLiveRepoGrounding('References src/does-not-exist.js somewhere.', repoRoot);
  assert.equal(found.length, 0);
});

test('extractLiveRepoGrounding refuses a path that would resolve outside repoRoot', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'grounding-test-repo-'));
  // Must actually match REPO_FILE_PATH_RE (real extension, starts with an allowed root
  // dir) to exercise the traversal guard at all -- a shape the regex itself already
  // rejects (e.g. no matching extension) would pass this test for the wrong reason.
  const found = extractLiveRepoGrounding('src/../../../../etc/passwd.md', repoRoot);
  assert.equal(found.length, 0);
});

test('extractLiveRepoGrounding truncates a file over the per-file char cap', () => {
  const big = 'x'.repeat(5000);
  const repoRoot = makeRepoWithFile('src/big.js', big);
  const found = extractLiveRepoGrounding('mentions src/big.js', repoRoot);
  assert.equal(found.length, 1);
  assert.ok(found[0].content.length < 5000);
  assert.match(found[0].content, /\.\.\.\[truncated\]$/);
});

test('extractLiveRepoGrounding caps the number of files fetched', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'grounding-test-repo-'));
  fs.mkdirSync(path.join(repoRoot, 'src'));
  const names = [];
  for (let i = 0; i < 8; i++) {
    const name = `src/file${i}.js`;
    fs.writeFileSync(path.join(repoRoot, name), `// file ${i}\n`);
    names.push(name);
  }
  const found = extractLiveRepoGrounding(names.join(' '), repoRoot);
  assert.equal(found.length, 5);
});

test('extractLiveRepoGrounding returns nothing when repoRoot is not provided (fails open, does not throw)', () => {
  assert.deepEqual(extractLiveRepoGrounding('mentions src/foo.js', null), []);
});

test('extractLiveRepoGrounding matches python/scripts/docs paths too, not just src/', () => {
  const repoRoot = makeRepoWithFile('python/dashboard/app.py', 'x = 1\n');
  const found = extractLiveRepoGrounding('see python/dashboard/app.py for the route', repoRoot);
  assert.equal(found.length, 1);
  assert.equal(found[0].path, 'python/dashboard/app.py');
});

// Regression, 2026-08-24: reproduces the exact real false-reject this fix was built for --
// a claim about src/model-stats-client.js's real recordCall() signature, correct against
// the actual file, but previously invisible to review-time grounding for an adhoc task.
test('CLI end-to-end: an adhoc task referencing a real repo-tracked file gets it as live grounding, not just the stale promptContext', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'grounding-test-repo-'));
  fs.mkdirSync(path.join(repoRoot, 'src'));
  fs.writeFileSync(
    path.join(repoRoot, 'src', 'model-stats-client.js'),
    "function recordCall({ taskId, stage = 'implement', model, candidates = null, startedAt, latencyMs, result }) {}\n",
  );
  const task = {
    domain: 'adhoc',
    source: 'manual',
    adhocResolution: 'decompose',
    promptContext: { rawText: 'stale, task-creation-time snapshot' },
    implementResponse: "Sub-task 1 claims src/model-stats-client.js's recordCall() takes { taskId, stage, model, candidates, startedAt, latencyMs, result }.",
  };
  const taskPath = path.join(repoRoot, 'task.json');
  fs.writeFileSync(taskPath, JSON.stringify(task));

  const stdout = execFileSync('node', [path.join(__dirname, 'get-grounding-source.js'), taskPath], {
    encoding: 'utf8',
    env: { ...process.env, AGENT_MANAGER_REPO_ROOT: repoRoot, AGENT_MANAGER_PIPELINE_DIR: repoRoot },
  });

  assert.match(stdout, /LIVE current repo content/);
  assert.match(stdout, /--- src\/model-stats-client\.js ---/);
  assert.match(stdout, /candidates = null/);
});

// Regression, 2026-08-24: caught investigating a real blocked task whose draft correctly
// cited `python/dashboard/templates/index.html:882-895` as proof a feature already
// existed -- .html was never in the allowed extension list, so the ONE file that actually
// contained the cited code never got fetched, and review kept rejecting a true
// "no-changes-needed" verdict as unconfirmed even after this whole mechanism had shipped.
test('extractLiveRepoGrounding matches .html and .json files too, not just js/py/sh/md', () => {
  const repoRoot = makeRepoWithFile('python/dashboard/templates/index.html', '<html>real content</html>\n');
  const found = extractLiveRepoGrounding('see python/dashboard/templates/index.html for the UI', repoRoot);
  assert.equal(found.length, 1);
  assert.equal(found[0].path, 'python/dashboard/templates/index.html');
  assert.match(found[0].content, /real content/);
});

// Same incident, second half of the bug: the OTHER cited file (app.py) DID match the old
// extension list, but flat-truncating from the start of a large file never reached the
// actually-cited line, so the "grounding" was functionally empty for it too.
test('extractLiveRepoGrounding centers the fetched window on a cited line number instead of truncating from the start', () => {
  const lines = [];
  for (let i = 1; i <= 500; i++) lines.push(`line ${i}`);
  lines[398] = 'line 399: the actually relevant route lives here, THE_MARKER';
  const repoRoot = makeRepoWithFile('python/dashboard/app.py', lines.join('\n'));

  const found = extractLiveRepoGrounding('see python/dashboard/app.py:399-405 for the route', repoRoot);

  assert.equal(found.length, 1);
  assert.match(found[0].content, /THE_MARKER/, 'the cited line must actually be present, not truncated away');
  assert.match(found[0].content, /showing lines/);
});

test('extractLiveRepoGrounding falls back to flat truncation from the start when no line number is cited', () => {
  const repoRoot = makeRepoWithFile('python/dashboard/app.py', 'x'.repeat(5000));
  const found = extractLiveRepoGrounding('mentions python/dashboard/app.py with no line ref', repoRoot);
  assert.equal(found.length, 1);
  assert.doesNotMatch(found[0].content, /showing lines/);
  assert.match(found[0].content, /\.\.\.\[truncated\]$/);
});

// Regression, 2026-08-25: root-caused live -- a real blocked task added new constants
// around line 2478 of a ~4700-line index.html, but its own prose summary ("Only
// index.html changed, as expected") carried no `file:line` citation, so the flat-
// truncation fallback above fetched only the file's first 4000 characters -- nowhere near
// the real change -- and the fact-checker correctly-per-its-own-logic flagged the new
// constants as "not found in source". A real unified diff's own `@@ -a,b +c,d @@` hunk
// header already states exactly which lines changed; this must be used to center the
// window even when the prose summary cites nothing.
test('extractLiveRepoGrounding centers the window on a real diff hunk header when the prose summary cites no line number', () => {
  const lines = [];
  for (let i = 1; i <= 4700; i++) lines.push(`line ${i}`);
  lines[2477] = 'line 2478: const JOB_TYPE_FAMILIES = [...], THE_MARKER';
  const repoRoot = makeRepoWithFile('python/dashboard/templates/index.html', lines.join('\n'));

  const draftText = [
    'Only index.html changed, as expected for a pure UI grouping change.',
    '',
    'RESOLUTION: implemented',
    '',
    '=== DIFF ===',
    'diff --git a/python/dashboard/templates/index.html b/python/dashboard/templates/index.html',
    'index eee803d..05dc767 100644',
    '--- a/python/dashboard/templates/index.html',
    '+++ b/python/dashboard/templates/index.html',
    '@@ -2475,6 +2475,26 @@ const JOB_TYPES = [',
    '+const JOB_TYPE_FAMILIES = [',
  ].join('\n');

  const found = extractLiveRepoGrounding(draftText, repoRoot);

  assert.equal(found.length, 1);
  assert.match(found[0].content, /THE_MARKER/, 'the real diff region must be fetched, not the file\'s first 4000 chars');
  assert.match(found[0].content, /showing lines/);
});

test('extractLiveRepoGrounding prefers a real prose citation over a diff hunk header when both are present', () => {
  const lines = [];
  for (let i = 1; i <= 4700; i++) lines.push(`line ${i}`);
  lines[98] = 'line 99: MARKER_FROM_PROSE_CITATION';
  const repoRoot = makeRepoWithFile('python/dashboard/templates/index.html', lines.join('\n'));

  const draftText = [
    'see python/dashboard/templates/index.html:99 for the real change',
    '',
    '=== DIFF ===',
    'diff --git a/python/dashboard/templates/index.html b/python/dashboard/templates/index.html',
    '@@ -2475,6 +2475,26 @@ const JOB_TYPES = [',
    '+const JOB_TYPE_FAMILIES = [',
  ].join('\n');

  const found = extractLiveRepoGrounding(draftText, repoRoot);

  assert.equal(found.length, 1);
  assert.match(found[0].content, /MARKER_FROM_PROSE_CITATION/, 'an explicit prose citation must win over the diff hunk fallback');
});

test('extractLiveRepoGrounding keeps the first real line reference when the same file is cited more than once', () => {
  const lines = [];
  for (let i = 1; i <= 500; i++) lines.push(`line ${i}`);
  lines[198] = 'line 199: MARKER_A';
  const repoRoot = makeRepoWithFile('python/dashboard/app.py', lines.join('\n'));

  const found = extractLiveRepoGrounding('see python/dashboard/app.py:199 and also python/dashboard/app.py generally', repoRoot);

  assert.equal(found.length, 1);
  assert.match(found[0].content, /MARKER_A/);
});
