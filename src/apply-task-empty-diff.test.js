'use strict';

// Unit tests for the stacked hub child + empty diff guard in apply-task.js.
// When a stacked hub child task produces an empty diff (no code change landed),
// applyTask must NOT silently succeed -- it returns { succeeded:false, status:'needs-clarification' }
// so the human decides whether to drop/reschedule/merge. Plain (non-stacked)
// empty-diff tasks keep the old "succeeded:true" behavior.
//
// Run: node --test src/apply-task-empty-diff.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { createFakeGitRunner } = require('./git-runner.js');
const { ensureRegistered } = require('./config.js');

const REPO_ROOT = path.join(os.tmpdir(), 'apply-task-empty-diff-test-repo');
const PIPELINE_DIR = REPO_ROOT;

process.env.AGENT_MANAGER_REPO_ROOT = REPO_ROOT;

const { applyTask, recordApplyOutcome } = require('./apply-task.js');

function baseTask(overrides = {}) {
  return {
    id: 'test-task-empty-diff-1',
    domain: 'default',
    source: 'trouble_log',
    title: 'Test task for empty diff',
    implementResponse: JSON.stringify({ mode: 'edit', file: 'foo.js', find: 'a', replace: 'b' }),
    ...overrides,
  };
}

test.beforeEach(() => {
  fs.mkdirSync(REPO_ROOT, { recursive: true });
  fs.writeFileSync(path.join(REPO_ROOT, 'foo.js'), 'a');
});

test.after(() => {
  fs.rmSync(REPO_ROOT, { recursive: true, force: true });
});

// Test 1: stacked child + empty diff is not succeeded and not done
test('stacked child task with empty adhoc diff is held for human clarification (not succeeded, not done)', () => {
  const gitRunner = createFakeGitRunner();
  const task = baseTask({
    domain: 'adhoc',
    source: 'manual',
    rawDiff: '',
    adhocResolution: 'implemented',
    stacked: true,
  });
  const result = applyTask(task, { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  assert.equal(result.succeeded, false, 'stacked child with empty diff must NOT succeed');
  assert.equal(result.status, 'needs-clarification', 'status must be needs-clarification');
  assert.ok(result.reason, 'must include a reason');
});

// Test 2: same task with adhocResolution no-changes-needed is still succeeded
test('stacked child with adhocResolution no-changes-needed is still succeeded (explicit model decision, not empty-diff artifact)', () => {
  const gitRunner = createFakeGitRunner();
  const task = baseTask({
    domain: 'adhoc',
    source: 'manual',
    rawDiff: '',
    adhocResolution: 'no-changes-needed',
    stacked: true,
  });
  const result = applyTask(task, { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  assert.equal(result.succeeded, true, 'explicit no-changes-needed must still succeed even when stacked');
  assert.equal(result.status, undefined, 'no needs-clarification status');
});

// Test 3: non-stacked adhoc task with empty diff is still succeeded
test('non-stacked adhoc task with empty diff is still succeeded (standalone no-op, not a hub piece)', () => {
  const gitRunner = createFakeGitRunner();
  const task = baseTask({
    domain: 'adhoc',
    source: 'manual',
    rawDiff: '',
    stacked: false,
  });
  const result = applyTask(task, { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  assert.equal(result.succeeded, true, 'non-stacked empty-diff task must still succeed');
  assert.equal(result.status, undefined, 'no needs-clarification status');
});

// Test 4: stacked child with real diff is unaffected
test('stacked child with a real (non-empty) diff proceeds normally -- the guard is empty-diff only', () => {
  const gitRunner = createFakeGitRunner();
  const task = baseTask({
    domain: 'adhoc',
    source: 'manual',
    rawDiff: 'diff --git a/foo.js b/foo.js\n--- a/foo.js\n+++ b/foo.js\n@@ -1 +1 @@\n-a\n+b\n',
    stacked: true,
  });
  const result = applyTask(task, { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  // The git apply will fail because REPO_ROOT isn't a real git repo, but the point
  // is the guard did NOT short-circuit with needs-clarification -- the normal
  // git-branch-diff flow ran (fetch/reset/branch) and the failure is a real apply
  // error, not a "nothing landed" hold.
  assert.equal(result.status, undefined, 'real-diff stacked task must NOT get needs-clarification');
  const names = gitRunner.calls.map((c) => c.name);
  assert.ok(names.includes('resetToMain'), 'guard did not short-circuit: normal git flow ran');
});

// Test 5: reason text names 'stacked' and 'nothing landed'
test('reason text for stacked empty-diff hold names both "stacked" and "nothing landed"', () => {
  const gitRunner = createFakeGitRunner();
  const task = baseTask({
    domain: 'adhoc',
    source: 'manual',
    rawDiff: '',
    adhocResolution: 'implemented',
    stacked: true,
  });
  const result = applyTask(task, { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  assert.ok(result.reason, 'must have a reason');
  assert.match(result.reason, /stacked/, 'reason must mention "stacked"');
  assert.match(result.reason, /nothing landed/, 'reason must mention "nothing landed"');
});

// Test 6: brain-dump entry is NOT closed for the held case
test('brain-dump entry is NOT closed when a stacked child is held for clarification on empty diff', () => {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-task-empty-diff-bd-test-'));
  const brainDumpPath = path.join(scratchDir, 'brain-dump.json');
  fs.writeFileSync(brainDumpPath, JSON.stringify({
    entries: [{ id: 'bd-1', status: 'actioned', rawText: 'Original brain dump note' }],
  }));

  const gitRunner = createFakeGitRunner();
  const task = baseTask({
    domain: 'adhoc',
    source: 'manual',
    rawDiff: '',
    adhocResolution: 'implemented',
    stacked: true,
    promptContext: { brainDumpEntryId: 'bd-1' },
  });
  const result = applyTask(task, { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner, brainDumpPath });

  assert.equal(result.succeeded, false, 'held task is not succeeded');

  const entries = JSON.parse(fs.readFileSync(brainDumpPath, 'utf8')).entries;
  assert.equal(entries[0].status, 'actioned', 'brain-dump entry must remain actioned (not closed/resolved)');
  assert.equal(entries[0].resolvedNote, undefined, 'no resolvedNote set (closeOriginatingBrainDumpEntry was NOT called)');

  fs.rmSync(scratchDir, { recursive: true, force: true });
});
