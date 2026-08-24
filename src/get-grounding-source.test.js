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
// apply-task.test.js already use for the identical requirement.
process.env.AGENT_MANAGER_REPO_ROOT = process.env.AGENT_MANAGER_REPO_ROOT || os.tmpdir();
process.env.AGENT_MANAGER_PIPELINE_DIR = process.env.AGENT_MANAGER_PIPELINE_DIR || process.env.AGENT_MANAGER_REPO_ROOT;

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
