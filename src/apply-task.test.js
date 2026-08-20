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

const { applyTask, recordApplyOutcome } = require('./apply-task.js');

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

test('skipPush ("Implement" mode): still pushes the branch (durability), but stays checked out on it instead of returning to main', () => {
  const gitRunner = createFakeGitRunner();
  const result = applyTask(baseTask(), { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner, skipPush: true });

  assert.equal(result.succeeded, true);
  assert.equal(result.branch, 'agent/test-task-1');
  assert.equal(result.pushed, true);
  const names = gitRunner.calls.map((c) => c.name);
  // push happens either way now; skipPush's only remaining effect is no checkoutMain
  // afterward, so the branch stays checked out for local inspection.
  assert.deepEqual(names, ['fetchMain', 'resetToMain', 'createBranch', 'add', 'commit', 'push']);
});

test('happy path (push enabled) reports pushed: true', () => {
  const gitRunner = createFakeGitRunner();
  const result = applyTask(baseTask(), { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });
  assert.equal(result.pushed, true);
});

test('push failure after a successful commit keeps the branch instead of deleting real applied work', () => {
  const gitRunner = createFakeGitRunner({ failOn: 'push', failMessage: 'remote: permission denied' });
  const result = applyTask(baseTask(), { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  assert.equal(result.succeeded, false);
  assert.equal(result.branch, 'agent/test-task-1');
  assert.match(result.reason, /push failed after commit succeeded \(kept local, not rolled back\)/);
  assert.match(result.reason, /remote: permission denied/);

  const names = gitRunner.calls.map((c) => c.name);
  // commit happened, push was attempted and failed -- no checkoutMain/deleteBranch:
  // the branch and its real commit are deliberately left in place, not discarded.
  assert.deepEqual(names, ['fetchMain', 'resetToMain', 'createBranch', 'add', 'commit', 'push']);
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

// --- arch_discovery/arch_import: direct-to-main path (no throwaway branch) --------------
// Confirmed live 2026-08-16: the old branch-per-task flow left ~301 of ~311 real applied
// candidates stranded on branches nobody ever merged. These two domains commit straight
// onto main instead and push immediately, ignoring skipPush -- see DIRECT_TO_MAIN_DOMAINS'
// own header comment in apply-task.js for the full reasoning.

function archDiscoveryTask(overrides = {}) {
  return baseTask({
    domain: 'arch_discovery',
    source: 'arch_discovery',
    implementResponse: [
      '### AC-1 · Example candidate',
      'Strength: Strong',
      'Files: foo.js',
      '',
      'Problem: ...',
      'Solution: ...',
    ].join('\n'),
    ...overrides,
  });
}

test('arch_discovery: commits straight to main, no branch, pushes immediately even without skipPush set', () => {
  const gitRunner = createFakeGitRunner();
  const result = applyTask(archDiscoveryTask(), { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  assert.equal(result.succeeded, true);
  assert.equal(result.pushed, true);
  assert.equal(result.branch, gitRunner.mainBranch);
  const names = gitRunner.calls.map((c) => c.name);
  // No createBranch, no checkoutMain, no deleteBranch -- pushMain instead of push(branch).
  assert.deepEqual(names, ['fetchMain', 'resetToMain', 'add', 'commit', 'pushMain']);
});

test('arch_discovery: still pushes even when skipPush is true -- an unpushed direct-to-main commit would be destroyed by the next resetToMain()', () => {
  const gitRunner = createFakeGitRunner();
  const result = applyTask(archDiscoveryTask(), { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner, skipPush: true });

  assert.equal(result.succeeded, true);
  assert.equal(result.pushed, true);
  const names = gitRunner.calls.map((c) => c.name);
  assert.ok(names.includes('pushMain'));
});

test('arch_discovery: push failure keeps the commit local instead of rolling it back (there is no branch to roll back)', () => {
  const gitRunner = createFakeGitRunner({ failOn: 'pushMain', failMessage: 'remote: connection reset' });
  const result = applyTask(archDiscoveryTask(), { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  assert.equal(result.succeeded, false);
  assert.match(result.reason, /push to main failed after commit succeeded \(kept local, not rolled back\)/);
  assert.match(result.reason, /remote: connection reset/);
  const names = gitRunner.calls.map((c) => c.name);
  // commit already happened and is deliberately left in place -- no checkoutMain/deleteBranch.
  assert.deepEqual(names, ['fetchMain', 'resetToMain', 'add', 'commit', 'pushMain']);
});

test('arch_discovery: artifact write failure resets main instead of trying to delete a branch that was never created', () => {
  const gitRunner = createFakeGitRunner();
  const task = archDiscoveryTask({ implementResponse: 'not valid arch-discovery markdown' });
  const result = applyTask(task, { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  // No AC-N heading in the response -> parseArchDiscoveryCandidates returns [] ->
  // applyArchDiscoveryCandidates returns {skipped: true}, not a thrown error -- exercises
  // the *skipped* path, distinct from the write-throws path covered by the next test.
  assert.equal(result.succeeded, true);
  const names = gitRunner.calls.map((c) => c.name);
  assert.deepEqual(names, ['fetchMain', 'resetToMain']);
});

test('arch_import: a genuinely thrown write error resets main again for cleanup (called twice: once up front, once in the catch)', () => {
  const gitRunner = createFakeGitRunner();
  // No promptContext at all -> applyArchImportCandidate's destructuring of
  // task.promptContext throws a real TypeError, distinct from the "no candidates,
  // cleanly skipped" case covered by the arch_discovery test above.
  const task = baseTask({ domain: 'arch_import', source: 'arch_import', implementResponse: '### AC-1 · X\nStrength: Strong\n\nbody' });
  delete task.promptContext;
  const result = applyTask(task, { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  assert.equal(result.succeeded, false);
  const names = gitRunner.calls.map((c) => c.name);
  assert.deepEqual(names, ['fetchMain', 'resetToMain', 'resetToMain']);
});

test('arch_import: same direct-to-main shape as arch_discovery (both domains share DIRECT_TO_MAIN_DOMAINS)', () => {
  const gitRunner = createFakeGitRunner();
  const task = baseTask({
    domain: 'arch_import',
    source: 'arch_import',
    promptContext: { itemId: 'item-1', sourceProject: 'some-external-repo' },
    implementResponse: [
      '### AC-1 · Example import candidate',
      'Strength: Strong',
      'Source: some-external-repo',
      'Files: foo.js',
      '',
      'Problem: ...',
      'Solution: ...',
    ].join('\n'),
  });
  const result = applyTask(task, { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  assert.equal(result.succeeded, true);
  assert.equal(result.pushed, true);
  const names = gitRunner.calls.map((c) => c.name);
  assert.deepEqual(names, ['fetchMain', 'resetToMain', 'add', 'commit', 'pushMain']);
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

// --- awaiting-confirm gate: an adhoc task with a real agentic-drafted diff also holds
// for human confirmation instead of touching git or disk (Brain Dump #67, 2026-08-17) --
// confirmed live testing this exact feature that apply-task.sh applies EVERYTHING in
// queue/approved/ unconditionally, so without this gate a real code change would land
// and push with no human click at all -----------------------------------------------

test('an adhoc task with a real rawDiff is held for confirmation and never touches git', () => {
  const gitRunner = createFakeGitRunner();
  const task = baseTask({ domain: 'adhoc', source: 'manual', rawDiff: 'diff --git a/x b/x\n', implementResponse: 'summary\n\n=== DIFF ===\ndiff --git a/x b/x\n' });
  const result = applyTask(task, { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  assert.equal(result.succeeded, false);
  assert.equal(result.needsConfirmation, true);
  assert.match(result.reason, /agentic/);
  assert.deepEqual(gitRunner.calls, []);
});

test('an adhoc task with an empty rawDiff (no-changes-needed) never hits the confirm gate', () => {
  const gitRunner = createFakeGitRunner();
  const task = baseTask({ domain: 'adhoc', source: 'manual', rawDiff: '', adhocResolution: 'no-changes-needed', implementResponse: 'already resolved' });
  const result = applyTask(task, { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  // Falls through to applyAdhocDiff's own {skipped} branch instead -- nothing to confirm.
  // The normal git-branch-diff sequence still runs fetch/reset/branch BEFORE writeArtifact
  // is called (same as every other {skipped} outcome on a non-special-cased domain), then
  // cleans the throwaway branch back up once it sees {skipped} -- no commit/push, though.
  assert.equal(result.needsConfirmation, undefined);
  assert.equal(result.succeeded, true);
  const names = gitRunner.calls.map((c) => c.name);
  assert.ok(!names.includes('commit'), 'a skipped (no-op) outcome must never commit');
  assert.ok(!names.includes('push'), 'a skipped (no-op) outcome must never push');
});

test('adhocApplyConfirmedAt lets a previously-held adhoc diff proceed past the gate', () => {
  const gitRunner = createFakeGitRunner();
  const task = baseTask({
    domain: 'adhoc', source: 'manual', rawDiff: 'diff --git a/x b/x\n', implementResponse: 'summary',
    adhocApplyConfirmedAt: '2026-08-17T00:00:00.000Z',
  });
  const result = applyTask(task, { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  // Past the confirm gate now -- resetToMain/createBranch ran, proving the gate didn't
  // hold it again. (Fails at the real `git apply` step since REPO_ROOT here isn't a real
  // git repo/matching diff -- applyAdhocDiff.test.js covers that path against real git.)
  const names = gitRunner.calls.map((c) => c.name);
  assert.ok(names.includes('resetToMain'), 'gate let it through to the real git-branch-diff flow');
});

// --- research tasks: same awaiting-confirm gate, but never touch git at all (Brain Dump
// #1 follow-up, 2026-08-17) -- SecondBrain is outside repoRoot, so a confirmed research
// task must be intercepted BEFORE the git-branch-diff flow's fetch/reset/branch, not just
// gated the same way adhoc is -------------------------------------------------------

test('a research task with a real researchDoc is held for confirmation and never touches git', () => {
  const gitRunner = createFakeGitRunner();
  const task = baseTask({ domain: 'research', source: 'research_task', researchDoc: '# x\n\nfindings', promptContext: { secondBrainPath: 'x.md' } });
  const result = applyTask(task, { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  assert.equal(result.succeeded, false);
  assert.equal(result.needsConfirmation, true);
  assert.match(result.reason, /research/);
  assert.deepEqual(gitRunner.calls, []);
});

test('researchApplyConfirmedAt lets a confirmed research task proceed, writes into SecondBrain, and never touches git', () => {
  const gitRunner = createFakeGitRunner();
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-task-research-test-'));
  const secondBrainDir = path.join(scratchDir, 'secondbrain');
  const brainDumpPath = path.join(scratchDir, 'brain-dump.json');
  fs.writeFileSync(brainDumpPath, JSON.stringify({ entries: [{ id: 'bd-1', status: 'actioned' }] }));

  const task = baseTask({
    domain: 'research', source: 'research_task',
    researchDoc: '# goblinnib\n\nReal findings.',
    promptContext: { secondBrainPath: 'references/goblinnib.md', brainDumpEntryId: 'bd-1' },
    researchApplyConfirmedAt: '2026-08-17T00:00:00.000Z',
  });
  const result = applyTask(task, { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, brainDumpPath, secondBrainDir, gitRunner });

  assert.equal(result.succeeded, true);
  assert.deepEqual(gitRunner.calls, [], 'research never touches git, confirmed or not');

  const noteText = fs.readFileSync(path.join(secondBrainDir, 'references/goblinnib.md'), 'utf8');
  assert.match(noteText, /Real findings\./);

  const entries = JSON.parse(fs.readFileSync(brainDumpPath, 'utf8')).entries;
  assert.equal(entries[0].status, 'actioned');
  assert.match(entries[0].resolvedNote, /Researched and filed/);
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

// Regression tests for recordApplyOutcome() (2026-08-18 incident): an apply failure on an
// already-APPROVED task was silently reclassified as a review rejection by
// reject-retry-check.js purely because the task still carried a stale blockedStage:
// 'review' from an earlier, already-resolved rejection -- discarding an already-approved,
// human-confirmed diff for a full blind redraft instead of leaving it for a human to see.
test('recordApplyOutcome overwrites a stale blockedStage:"review" with "apply" on a new apply failure, so reject-retry-check.js cannot misfire on it', () => {
  const task = {
    id: 'stale-blocked-task',
    // Leftover from an EARLIER, already-resolved review rejection -- approval never
    // clears these fields, only a NEW block overwrites them.
    blockedStage: 'review',
    blockedReason: 'an old, unrelated review rejection from a prior draft attempt',
    history: [],
  };
  const result = { succeeded: false, reason: 'git apply failed: error: corrupt patch at line 68' };

  const stage = recordApplyOutcome(task, result);

  assert.equal(stage, 'apply-failed');
  assert.equal(task.blockedStage, 'apply');
  assert.equal(task.blockedReason, result.reason);
  assert.notEqual(task.blockedStage, 'review', 'reject-retry-check.js\'s isReviewRejection() must not match this');
});

test('recordApplyOutcome does not touch blockedStage/blockedReason on a successful apply', () => {
  const task = { id: 'ok-task', history: [] };
  const result = { succeeded: true, branch: 'agent/ok-task', pushed: true };

  const stage = recordApplyOutcome(task, result);

  assert.equal(stage, 'applied');
  assert.equal(task.blockedStage, undefined);
  assert.equal(task.blockedReason, undefined);
});

test('recordApplyOutcome reports awaiting-confirm (not apply-failed) for a needsConfirmation hold, and does not stamp blockedStage', () => {
  const task = { id: 'hold-task', history: [] };
  const result = { succeeded: false, needsConfirmation: true, reason: 'real agentic code diff ready to apply -- held for human confirmation' };

  const stage = recordApplyOutcome(task, result);

  assert.equal(stage, 'awaiting-confirm');
  assert.equal(task.blockedStage, undefined);
});

// coAuthorTrailer (2026-08-20, Grimmethy: "It's showing that ornith authored the script
// which implies that the program is inaccurately representing model used"): the
// commit-message Co-Authored-By trailer must name the REAL model that drafted the
// change, not a generic "Ornith" brand name that discards task.draftModel's actual tag.
function gitRunnerCapturingCommitMessage() {
  const base = createFakeGitRunner();
  let commitMessage = null;
  return {
    ...base,
    commit: (messageFilePath) => {
      commitMessage = fs.readFileSync(messageFilePath, 'utf8');
      return base.commit(messageFilePath);
    },
    get capturedCommitMessage() { return commitMessage; },
  };
}

test('coAuthorTrailer: a local (non-Claude) draftModel credits the SPECIFIC model tag, not a bare "Ornith"', () => {
  const gitRunner = gitRunnerCapturingCommitMessage();
  applyTask(baseTask({ draftModel: 'qwen3.8:27b-q4_K_M' }), { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  assert.match(gitRunner.capturedCommitMessage, /Co-Authored-By: Ornith \(qwen3\.8:27b-q4_K_M\) <noreply@ornith\.local>/);
});

test('coAuthorTrailer: a Claude draftModel still credits Claude with its specific model name (no regression)', () => {
  const gitRunner = gitRunnerCapturingCommitMessage();
  applyTask(baseTask({ draftModel: 'claude:sonnet' }), { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  assert.match(gitRunner.capturedCommitMessage, /Co-Authored-By: Claude \(sonnet\) <noreply@anthropic\.com>/);
});

test('coAuthorTrailer: a task with no draftModel at all (queued before the field existed) falls back to the bare generic label', () => {
  const gitRunner = gitRunnerCapturingCommitMessage();
  applyTask(baseTask({ draftModel: undefined }), { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  assert.match(gitRunner.capturedCommitMessage, /Co-Authored-By: Ornith <noreply@ornith\.local>/);
  assert.doesNotMatch(gitRunner.capturedCommitMessage, /Ornith \(/);
});
