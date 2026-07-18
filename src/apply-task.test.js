'use strict';

// Unit tests for apply-task.js's git sequencing -- the single highest-consequence
// untested path in this package (it's the one place that actually mutates the consumer's
// real git repo). Uses createFakeGitRunner (git-runner.js) as the injectable test double
// instead of a real repo/child_process, so these run instantly with no git or filesystem
// dependency beyond the temp commit-message file apply-task.js itself writes.
//
// Run: node --test src/apply-task.test.js  (or `npm test`, see package.json)

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { createFakeGitRunner } = require('./git-runner.js');
const { ensureRegistered } = require('./config.js');

// apply-task.js requires AGENT_MANAGER_REPO_ROOT at load time (getConfig()'s one required
// setting) even though these tests never call getConfig() themselves -- module-level
// require('./task-sources.js') + ensureRegistered() at the top of apply-task.js run before
// any test does. A throwaway value is fine; no test here exercises the real repoRoot.
process.env.AGENT_MANAGER_REPO_ROOT = process.env.AGENT_MANAGER_REPO_ROOT || os.tmpdir();

const { applyTask } = require('./apply-task.js');

const REPO_ROOT = path.join(os.tmpdir(), 'apply-task-test-repo');
const PIPELINE_DIR = REPO_ROOT;

function baseTask(overrides = {}) {
  return {
    id: 'test-task-1',
    domain: 'default',
    source: 'trouble_log',
    title: 'Test task',
    implementResponse: JSON.stringify({ mode: 'edit', file: 'foo.js', find: 'a', replace: 'b' }),
    ...overrides,
  };
}

// writeArtifact() (in apply-task.js) falls through to applyGroupB for domain/source
// combos with no registered custom `apply` -- applyGroupB actually touches the filesystem
// (reads/writes foo.js under repoRoot). Point repoRoot at a real throwaway temp dir with
// the file the fake task's edit expects, so writeArtifact succeeds without needing a real
// git repo (git itself is entirely faked via gitRunner).
test.beforeEach(() => {
  fs.mkdirSync(REPO_ROOT, { recursive: true });
  fs.writeFileSync(path.join(REPO_ROOT, 'foo.js'), 'a');
});

test.after(() => {
  fs.rmSync(REPO_ROOT, { recursive: true, force: true });
});

test('happy path: fetch/reset/branch/add/commit/push/checkout in order, succeeds', () => {
  const gitRunner = createFakeGitRunner();
  const result = applyTask(baseTask(), { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  assert.equal(result.succeeded, true);
  assert.equal(result.branch, 'agent/test-task-1');
  const names = gitRunner.calls.map((c) => c.name);
  assert.deepEqual(names, ['fetchMain', 'resetToMain', 'createBranch', 'add', 'commit', 'push', 'checkoutMain']);
});

test('push failure after a successful commit rolls back instead of leaving an orphaned branch', () => {
  const gitRunner = createFakeGitRunner({ failOn: 'push', failMessage: 'remote: permission denied' });
  const result = applyTask(baseTask(), { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  assert.equal(result.succeeded, false);
  assert.match(result.reason, /push failed after commit succeeded \(rolled back\)/);
  assert.match(result.reason, /remote: permission denied/);

  const names = gitRunner.calls.map((c) => c.name);
  // commit happened (it succeeded) BEFORE the push attempt, and cleanup (checkoutMain +
  // deleteBranch) happened AFTER push failed -- this is the exact sequence the report
  // flagged as missing: "if push throws here, commit already succeeded -- no cleanup".
  assert.deepEqual(names, ['fetchMain', 'resetToMain', 'createBranch', 'add', 'commit', 'push', 'checkoutMain', 'deleteBranch']);

  const deleteBranchCall = gitRunner.calls.find((c) => c.name === 'deleteBranch');
  assert.equal(deleteBranchCall.args[0], 'agent/test-task-1');
});

test('artifact write failure rolls back the branch before any add/commit/push', () => {
  const gitRunner = createFakeGitRunner();
  // implementResponse that applyGroupB cannot parse -> writeArtifact throws.
  const task = baseTask({ implementResponse: 'not valid json' });
  const result = applyTask(task, { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  assert.equal(result.succeeded, false);
  const names = gitRunner.calls.map((c) => c.name);
  assert.deepEqual(names, ['fetchMain', 'resetToMain', 'createBranch', 'checkoutMain', 'deleteBranch']);
});

test('a fetchMain failure surfaces as a failure with no branch created', () => {
  const gitRunner = createFakeGitRunner({ failOn: 'fetchMain', failMessage: 'network unreachable' });
  const result = applyTask(baseTask(), { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  assert.equal(result.succeeded, false);
  assert.match(result.reason, /network unreachable/);
  const names = gitRunner.calls.map((c) => c.name);
  assert.deepEqual(names, ['fetchMain']);
});
