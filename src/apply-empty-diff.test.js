'use strict';

// Empty-diff routing for adhoc drafts in apply-task.js (HUB0470 1/2).
// - implemented (or absent-resolution) adhoc draft + empty diff, non-stacked:
//   returns needs-clarification and does NOT abandon the branch or close the
//   originating brain dump entry.
// - stacked empty diff keeps its own reason string.
// - no-changes-needed + empty diff stays a succeeded no-op.
//
// Run: node --test src/apply-empty-diff.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { createFakeGitRunner } = require('./git-runner.js');
const { ensureRegistered } = require('./config.js');

const REPO_ROOT = path.join(os.tmpdir(), 'apply-empty-diff-test-repo');
const PIPELINE_DIR = REPO_ROOT;

process.env.AGENT_MANAGER_REPO_ROOT = REPO_ROOT;

const { applyTask } = require('./apply-task.js');

const NEEDS_CLARIFICATION_REASON = 'empty diff on an implemented adhoc draft: nothing landed';

function baseTask(overrides = {}) {
  return {
    id: 'test-empty-diff-adhoc-1',
    domain: 'adhoc',
    source: 'manual',
    title: 'Test adhoc task with empty diff',
    implementResponse: JSON.stringify({ mode: 'edit', file: 'foo.js', find: 'a', replace: 'b' }),
    rawDiff: '',
    ...overrides,
  };
}

// True if abandonBranch's checkoutMain/deleteBranch ran after the apply's own createBranch.
function abandonedAfterBranch(names) {
  const last = names.lastIndexOf('createBranch');
  if (last === -1) return null;
  return names.slice(last + 1).some((n) => n === 'checkoutMain' || n === 'deleteBranch');
}

function brainDumpFixture() {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-empty-diff-bd-'));
  const brainDumpPath = path.join(scratchDir, 'brain-dump.json');
  fs.writeFileSync(brainDumpPath, JSON.stringify({
    entries: [{ id: 'bd-1', status: 'actioned', rawText: 'Original brain dump note' }],
  }));
  return { scratchDir, brainDumpPath };
}

test.beforeEach(() => {
  fs.mkdirSync(REPO_ROOT, { recursive: true });
  fs.writeFileSync(path.join(REPO_ROOT, 'foo.js'), 'a');
});

test.after(() => {
  fs.rmSync(REPO_ROOT, { recursive: true, force: true });
});

test('implemented adhoc + empty diff + non-stacked -> needs-clarification, no abandon, no brain-dump close', () => {
  const { scratchDir, brainDumpPath } = brainDumpFixture();
  try {
    const gitRunner = createFakeGitRunner();
    const task = baseTask({
      adhocResolution: 'implemented',
      stacked: false,
      promptContext: { brainDumpEntryId: 'bd-1' },
    });
    const result = applyTask(task, { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner, brainDumpPath });

    assert.equal(result.succeeded, false);
    assert.equal(result.status, 'needs-clarification');
    assert.equal(result.reason, NEEDS_CLARIFICATION_REASON);

    const names = gitRunner.calls.map((c) => c.name);
    assert.ok(names.includes('createBranch'), 'apply reached the branch step before the guard');
    assert.equal(abandonedAfterBranch(names), false, 'abandonBranch must not run');

    const entries = JSON.parse(fs.readFileSync(brainDumpPath, 'utf8')).entries;
    assert.equal(entries[0].status, 'actioned');
    assert.equal(entries[0].resolvedNote, undefined, 'closeOriginatingBrainDumpEntry must not run');
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
});

test('adhoc with adhocResolution absent + empty diff + non-stacked -> needs-clarification, no abandon', () => {
  const gitRunner = createFakeGitRunner();
  const task = baseTask({ stacked: false });
  assert.equal(task.adhocResolution, undefined);
  const result = applyTask(task, { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  assert.equal(result.succeeded, false);
  assert.equal(result.status, 'needs-clarification');
  assert.equal(result.reason, NEEDS_CLARIFICATION_REASON);

  const names = gitRunner.calls.map((c) => c.name);
  assert.ok(names.includes('createBranch'), 'apply reached the branch step before the guard');
  assert.equal(abandonedAfterBranch(names), false, 'abandonBranch must not run');
});

test('stacked adhoc + empty diff keeps the stacked reason string', () => {
  const gitRunner = createFakeGitRunner();
  const task = baseTask({ adhocResolution: 'implemented', stacked: true });
  const result = applyTask(task, { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  assert.equal(result.succeeded, false);
  assert.equal(result.status, 'needs-clarification');
  assert.equal(result.reason, 'empty diff on a stacked hub piece: nothing landed');
});

test('no-changes-needed adhoc + empty diff stays a succeeded no-op', () => {
  const gitRunner = createFakeGitRunner();
  const task = baseTask({ adhocResolution: 'no-changes-needed', stacked: false });
  const result = applyTask(task, { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  assert.equal(result.succeeded, true);
  assert.equal(result.status, undefined);
});
