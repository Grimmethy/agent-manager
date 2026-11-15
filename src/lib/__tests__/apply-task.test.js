'use strict';

// Unit tests for src/lib/apply-main-batch.js's missing-origin-remote handling (HUB0334 · 3/3).
//
// When a repo has no 'origin' remote (e.g. a local-only clone), applyDirectToMainBatch
// must not crash on gitRunner.fetchMain() or gitRunner.push(). Instead it must commit
// locally and mark each task result with a doneMarker that names the missing remote and
// the project so downstream task-disposition does not treat the commit as shipped.
//
// Run: node --test src/lib/__tests__/apply-task.test.js  (or `npm test`)

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const TEMP_ROOT = path.join(os.tmpdir(), 'apply-task-no-origin-test');
const PROJECT_DIR = path.join(TEMP_ROOT, 'local-only-repo');

// Force AGENT_MANAGER_REPO_ROOT to a throwaway temp dir so config.js / task-sources.js
// never read the ambient repo (same rationale as src/lib/apply-main-batch.test.js).
process.env.AGENT_MANAGER_REPO_ROOT = TEMP_ROOT;
fs.mkdirSync(TEMP_ROOT, { recursive: true });

// HOME and state paths must point into temp dirs so the apply path never touches the
// real user home (config writes, brain-dump paths, state dirs).
const TEMP_HOME = path.join(os.tmpdir(), 'apply-task-no-origin-test-home');
fs.mkdirSync(TEMP_HOME, { recursive: true });
const previousHome = process.env.HOME;
const previousXdg = process.env.XDG_CONFIG_HOME;
process.env.HOME = TEMP_HOME;
process.env.XDG_CONFIG_HOME = path.join(TEMP_HOME, '.config');

test.after(() => {
  // Restore env before tearing down dirs so any cleanup that reads HOME works.
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previousXdg;
  fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
});

// Set up a real git repo (no origin remote) under PROJECT_DIR so checkRemoteExists
// (git-remote-check.js) returns false for 'origin' and the local-only path in
// apply-main-batch.js is taken. Ungated mode avoids the gated prepareStackedBranch path
// which would try to fetch origin and fail -- the local-only probe happens BEFORE that
// branch, so ungated is the cleanest way to hit the assertion.
test.before(() => {
  fs.mkdirSync(PROJECT_DIR, { recursive: true });
  execFileSync('git', ['init', PROJECT_DIR], { stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: PROJECT_DIR, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: PROJECT_DIR, stdio: 'pipe' });
  // Deliberately do NOT run `git remote add origin ...` -- the whole point of this test.
});

const { createFakeGitRunner } = require('../../git-runner.js');
const { registerTaskSource } = require('../../task-source-registry.js');
const { applyDirectToMainBatch } = require('../apply-main-batch.js');

// Register a directToMain source whose apply() returns a clean artifact so the batch
// reaches the commit+local-only-outcome branch (not the stale/skipped/needs-confirmation
// early returns).
const TEST_SOURCE = 'no_origin_probe';
if (!require('../../task-source-registry.js').getRegisteredSource(TEST_SOURCE)) {
  registerTaskSource(TEST_SOURCE, {
    priority: 80,
    next: () => null,
    directToMain: true,
    apply: () => ({ file: 'test-artifact.md', content: '# test\n', files: ['test-artifact.md'] }),
  });
}

const TEST_TASK = {
  id: 'hub0334-no-origin-1',
  domain: 'test',
  source: TEST_SOURCE,
  title: 'Missing origin remote test task',
  implementResponse: '',
};

// Ungated wrapper: the local-only path is taken before the gated/ungated decision in
// production, but the fake gitRunner does not implement prepareStackedBranch, so force
// ungated to skip that branch entirely and exercise the local-only outcome cleanly.
function ungatedTest(name, fn) {
  test(name, async (t) => {
    const saved = process.env.AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH;
    process.env.AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH = 'true';
    try { return await fn(t); } finally {
      if (saved === undefined) delete process.env.AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH; else process.env.AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH = saved;
    }
  });
}

ungatedTest('HUB0334 3/3: missing origin remote does not crash and marks result local-only', () => {
  // Confirm the test setup: the temp repo genuinely has no origin remote.
  let hasOrigin = false;
  try {
    execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: PROJECT_DIR, stdio: 'pipe', encoding: 'utf8' });
    hasOrigin = true;
  } catch { /* expected */ }
  assert.equal(hasOrigin, false, 'test setup must have no origin remote');

  const gitRunner = createFakeGitRunner();
  // No crash: applyDirectToMainBatch must return normally even with no origin.
  const result = applyDirectToMainBatch([TEST_TASK], {
    repoRoot: PROJECT_DIR,
    pipelineDir: PROJECT_DIR,
    gitRunner,
  });

  // (1) No crash: we got a result back.
  assert.ok(result, 'applyDirectToMainBatch must return a result object');
  assert.ok(result.results, 'result must include a results map');
  assert.ok(result.results[TEST_TASK.id], 'result must include an entry for the test task');

  // (2) The result indicates local-only application or names the missing remote.
  const doneMarker = result.results[TEST_TASK.id].doneMarker;
  assert.ok(doneMarker, 'result must include a doneMarker');
  assert.ok(
    /local/i.test(doneMarker) || /no remote/i.test(doneMarker),
    `doneMarker must indicate local-only or no remote, got: ${doneMarker}`
  );

  // (3) The result message includes the remote name 'origin' and the project name.
  const projectName = path.basename(PROJECT_DIR);
  assert.ok(
    /origin/i.test(doneMarker),
    `doneMarker must mention 'origin', got: ${doneMarker}`
  );
  assert.ok(
    new RegExp(projectName, 'i').test(doneMarker),
    `doneMarker must mention project name '${projectName}', got: ${doneMarker}`
  );

  // (4) The task is NOT marked as needs-clarification.
  const status = result.results[TEST_TASK.id].status;
  assert.notEqual(status, 'needs-clarification', 'task must not be marked needs-clarification');
  // Also verify succeeded is true (the local-only path is a success).
  assert.equal(result.results[TEST_TASK.id].succeeded, true, 'local-only application must be recorded as succeeded');
});
