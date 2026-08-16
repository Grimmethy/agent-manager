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

test('skipPush ("Implement" mode): commits locally, never calls push or checkoutMain', () => {
  const gitRunner = createFakeGitRunner();
  const result = applyTask(baseTask(), { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner, skipPush: true });

  assert.equal(result.succeeded, true);
  assert.equal(result.branch, 'agent/test-task-1');
  assert.equal(result.pushed, false);
  const names = gitRunner.calls.map((c) => c.name);
  assert.deepEqual(names, ['fetchMain', 'resetToMain', 'createBranch', 'add', 'commit']);
});

test('happy path (push enabled) reports pushed: true', () => {
  const gitRunner = createFakeGitRunner();
  const result = applyTask(baseTask(), { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });
  assert.equal(result.pushed, true);
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

// --- awaiting-confirm gate: a Group B batch containing a delete holds for human
// confirmation instead of touching git or disk (src/apply-group-b.js's
// batchContainsDeleteMode + src/apply-task.js's gate just before the git-branch-diff
// flow) ----------------------------------------------------------------------------

test('a delete-containing batch is held for confirmation and never touches git', () => {
  const gitRunner = createFakeGitRunner();
  const task = baseTask({ implementResponse: JSON.stringify({ mode: 'delete', file: 'foo.js' }) });
  const result = applyTask(task, { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  assert.equal(result.succeeded, false);
  assert.equal(result.needsConfirmation, true);
  assert.match(result.reason, /delete/);
  assert.deepEqual(gitRunner.calls, []);
  // Nothing on disk touched either -- the gate fires before writeArtifact is ever called.
  assert.equal(fs.readFileSync(path.join(REPO_ROOT, 'foo.js'), 'utf8'), 'a');
});

test('a delete-containing batch inside an array is also held for confirmation', () => {
  const gitRunner = createFakeGitRunner();
  const batch = [{ mode: 'create', file: 'new.js', content: 'x' }, { mode: 'delete', file: 'foo.js' }];
  const task = baseTask({ implementResponse: JSON.stringify(batch) });
  const result = applyTask(task, { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  assert.equal(result.needsConfirmation, true);
  assert.deepEqual(gitRunner.calls, []);
});

test('deleteConfirmedAt lets a previously-held delete batch proceed for real', () => {
  const gitRunner = createFakeGitRunner();
  const task = baseTask({
    implementResponse: JSON.stringify({ mode: 'delete', file: 'foo.js' }),
    deleteConfirmedAt: '2026-08-16T00:00:00.000Z',
  });
  const result = applyTask(task, { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  assert.equal(result.succeeded, true);
  assert.equal(result.branch, 'agent/test-task-1');
  const names = gitRunner.calls.map((c) => c.name);
  assert.deepEqual(names, ['fetchMain', 'resetToMain', 'createBranch', 'add', 'commit', 'push', 'checkoutMain']);
  assert.equal(fs.existsSync(path.join(REPO_ROOT, 'foo.js')), false);
});

test('a batch with no delete never hits the gate (unaffected by this change)', () => {
  const gitRunner = createFakeGitRunner();
  const result = applyTask(baseTask(), { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  assert.equal(result.succeeded, true);
  assert.equal(result.needsConfirmation, undefined);
});

test('a source with its own registered apply (e.g. brain_dump_sort) never hits the delete gate, even with delete-shaped implementResponse', () => {
  const gitRunner = createFakeGitRunner();
  const task = baseTask({
    domain: 'brain_dump_sort',
    source: 'brain_dump_sort',
    implementResponse: JSON.stringify({ mode: 'delete', file: 'foo.js' }),
    promptContext: { brainDumpEntryId: 'bd-1', rawText: 'irrelevant' },
  });
  const brainDumpPath = path.join(os.tmpdir(), 'apply-task-gate-brain-dump.json');
  fs.writeFileSync(brainDumpPath, JSON.stringify({ entries: [] }));
  const result = applyTask(task, { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner, brainDumpPath, secondBrainDir: os.tmpdir() });

  assert.equal(result.needsConfirmation, undefined);
  assert.deepEqual(gitRunner.calls, []); // brain_dump_sort never touches git regardless
  fs.rmSync(brainDumpPath, { force: true });
});

test('a fetchMain failure surfaces as a failure with no branch created', () => {
  const gitRunner = createFakeGitRunner({ failOn: 'fetchMain', failMessage: 'network unreachable' });
  const result = applyTask(baseTask(), { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  assert.equal(result.succeeded, false);
  assert.match(result.reason, /network unreachable/);
  const names = gitRunner.calls.map((c) => c.name);
  assert.deepEqual(names, ['fetchMain']);
});

// --- domain: 'brain_dump_sort' -- must skip git entirely (non-git write), same as
// secondbrain/project_search/deep_dive above it in applyTask() -----------------------

test('domain brain_dump_sort never touches git -- writes the note and marks the entry sorted instead', () => {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-task-brain-dump-test-'));
  const brainDumpPath = path.join(scratchDir, 'brain-dump.json');
  const secondBrainDir = path.join(scratchDir, 'secondbrain');
  fs.writeFileSync(brainDumpPath, JSON.stringify({
    entries: [{ id: 'bd-1', rawText: 'Buy milk', status: 'captured' }],
  }));

  const gitRunner = createFakeGitRunner();
  const task = baseTask({
    domain: 'brain_dump_sort',
    source: 'brain_dump_sort',
    promptContext: { brainDumpEntryId: 'bd-1', rawText: 'Buy milk' },
    implementResponse: JSON.stringify({ category: 'task', secondBrainPath: 'Errands/shopping.md', tags: [], actionable: true, rationale: 'r' }),
  });

  const result = applyTask(task, { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, brainDumpPath, secondBrainDir, gitRunner });

  assert.equal(result.succeeded, true);
  assert.equal(gitRunner.calls.length, 0, 'a non-git domain must never call the git runner');

  const entries = JSON.parse(fs.readFileSync(brainDumpPath, 'utf8')).entries;
  assert.equal(entries[0].status, 'sorted');
  assert.ok(fs.existsSync(path.join(secondBrainDir, 'Errands', 'shopping.md')));

  fs.rmSync(scratchDir, { recursive: true, force: true });
});

test('domain brain_dump_sort reports skipped-but-succeeded when the classification is malformed', () => {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-task-brain-dump-test-'));
  const brainDumpPath = path.join(scratchDir, 'brain-dump.json');
  const secondBrainDir = path.join(scratchDir, 'secondbrain');
  fs.writeFileSync(brainDumpPath, JSON.stringify({
    entries: [{ id: 'bd-1', rawText: 'Buy milk', status: 'captured' }],
  }));

  const gitRunner = createFakeGitRunner();
  const task = baseTask({
    domain: 'brain_dump_sort',
    source: 'brain_dump_sort',
    promptContext: { brainDumpEntryId: 'bd-1', rawText: 'Buy milk' },
    implementResponse: 'not json',
  });

  const result = applyTask(task, { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, brainDumpPath, secondBrainDir, gitRunner });

  // Malformed model output is a task outcome, not an apply FAILURE -- same convention
  // project_search/deep_dive's own "no findings" skip already uses just above.
  assert.equal(result.succeeded, true);
  assert.equal(gitRunner.calls.length, 0);
  const entries = JSON.parse(fs.readFileSync(brainDumpPath, 'utf8')).entries;
  assert.equal(entries[0].status, 'captured');

  fs.rmSync(scratchDir, { recursive: true, force: true });
});

// --- domain: 'path_prefetch_resolve' -- must skip git entirely (non-git write), same as
// brain_dump_sort above. Without this special case in applyTask(), it would fall through
// to the git-branch-diff flow below and try to `git add`/commit an artifact shape
// (suggested/heldTaskId/paths) that was never a {file}/{files} in the first place. -------

test('domain path_prefetch_resolve never touches git -- writes the suggestion onto the held task instead', () => {
  const scratchPipelineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-task-path-prefetch-test-'));
  const heldDir = path.join(scratchPipelineDir, 'queue', 'needs-clarification');
  fs.mkdirSync(heldDir, { recursive: true });
  fs.writeFileSync(path.join(heldDir, 'held-1.json'), JSON.stringify({
    id: 'held-1', domain: 'adhoc', source: 'brain_dump', title: 'held task',
    promptContext: { rawText: 'held task text' },
    needsClarification: { reason: 'no-match' },
  }));

  const gitRunner = createFakeGitRunner();
  const task = baseTask({
    domain: 'path_prefetch_resolve',
    source: 'path_prefetch_resolve',
    promptContext: { heldTaskId: 'held-1' },
    // confident:false deliberately -- a confident suggestion now auto-resolves into
    // adhoc/ (see apply-group-a.test.js's own coverage of that path), which would make
    // "held.json still exists in needs-clarification/" below false and is not what this
    // test is checking. This test's own job is just "no git calls for this domain."
    implementResponse: JSON.stringify({ paths: ['src/auth.ts'], rationale: 'the note is about login', confident: false }),
  });

  const result = applyTask(task, { repoRoot: REPO_ROOT, pipelineDir: scratchPipelineDir, gitRunner });

  assert.equal(result.succeeded, true);
  assert.equal(gitRunner.calls.length, 0, 'a non-git domain must never call the git runner');

  const held = JSON.parse(fs.readFileSync(path.join(heldDir, 'held-1.json'), 'utf8'));
  assert.deepEqual(held.needsClarification.suggested.paths, ['src/auth.ts']);
  assert.equal(held.needsClarification.suggestionAttempted, true);
  // Still held, not moved to adhoc/ -- a non-confident guess still requires a human to
  // accept it via the dashboard's resolve endpoint.
  assert.equal(fs.existsSync(path.join(scratchPipelineDir, 'queue', 'adhoc', 'held-1.json')), false);

  fs.rmSync(scratchPipelineDir, { recursive: true, force: true });
});
