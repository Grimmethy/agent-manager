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

const REPO_ROOT = path.join(os.tmpdir(), 'apply-task-test-repo');
const PIPELINE_DIR = REPO_ROOT;

// apply-task.js requires AGENT_MANAGER_REPO_ROOT at load time (getConfig()'s one required
// setting), AND the arch_discovery/arch_import/observability_review/performance_review
// apply handlers below call getConfig() fresh internally rather than deriving their
// candidates-doc path from the repoRoot/pipelineDir explicitly passed into applyTask() --
// so this can NOT be a "default only if unset" (`||`): confirmed live 2026-08-24 that
// running `npm test` in a shell where AGENT_MANAGER_REPO_ROOT is already set to a real
// repo (the normal state whenever the live pipeline is configured) silently appended
// "Example candidate" placeholder fixture content to that real repo's own
// Docs/ARCH_REVIEW_CANDIDATES.md and friends. Force it to REPO_ROOT unconditionally so
// these tests can never leak into whatever repo happens to be ambient in the env.
process.env.AGENT_MANAGER_REPO_ROOT = REPO_ROOT;

const { applyTask, recordApplyOutcome } = require('./apply-task.js');

// observability_review/performance_review (2026-08-27) and arch_discovery/arch_import/
// arch_review (2026-08-27, Phase 2) moved to the out-of-tree agent-manager-hygiene plugin,
// so requiring ./apply-task.js (which requires ./task-sources.js) no longer registers them.
// The routing/apply tests below assert CORE behaviour (direct-to-main for a
// candidates-doc-appending source, the candidateSplitProposals write-back path, a thrown
// apply error triggering a second resetToMain) -- register matching-shape stubs so
// usesGroupB() and applyCandidateSplit() still resolve them the way production does.
const { registerTaskSource, getRegisteredSource } = require('./task-source-registry.js');
const { applyArchDiscoveryCandidates } = require('./candidate-docs.js');
for (const name of ['observability_review', 'performance_review', 'arch_discovery']) {
  if (!getRegisteredSource(name)) {
    registerTaskSource(name, {
      priority: 80,
      next: () => null,
      apply: ({ implementResponse, task }) => applyArchDiscoveryCandidates({
        implementResponse,
        candidatesPath: path.join(PIPELINE_DIR, `${name.toUpperCase()}_CANDIDATES.md`),
        snippet: task && task.promptContext && task.promptContext.snippet,
      }),
    });
  }
}
// arch_import's real apply destructures task.promptContext up front -- a task with none
// throws a TypeError, which is exactly what the "thrown write error" test exercises.
if (!getRegisteredSource('arch_import')) {
  registerTaskSource('arch_import', {
    priority: 81,
    next: () => null,
    apply: ({ implementResponse, task }) => {
      const { itemId } = task.promptContext; // throws if promptContext is missing
      return applyArchDiscoveryCandidates({ implementResponse, candidatesPath: path.join(PIPELINE_DIR, `ARCH_IMPORT_${itemId || 'x'}.md`) });
    },
  });
}
// arch_review -- NOT direct-to-main; the candidateSplitProposals test needs its
// candidatesPath()/candidateDocTitle so applyCandidateSplit() can write the sub-candidates.
if (!getRegisteredSource('arch_review')) {
  registerTaskSource('arch_review', {
    priority: 70,
    next: () => null,
    emptyApproval: true,
    candidateFulfillment: true,
    candidatesPath: () => path.join(REPO_ROOT, 'Docs', 'ARCH_REVIEW_CANDIDATES.md'),
    candidateDocTitle: '# Architecture Review Candidates',
  });
}

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

test('happy path: fetch/reset/(delete stale branch)/branch/add/commit/push/checkout in order, succeeds', () => {
  const gitRunner = createFakeGitRunner();
  const result = applyTask(baseTask(), { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  assert.equal(result.succeeded, true);
  assert.equal(result.branch, 'agent/test-task-1');
  const names = gitRunner.calls.map((c) => c.name);
  assert.deepEqual(names, ['fetchMain', 'resetToMain', 'deleteBranch', 'createBranch', 'add', 'commit', 'push', 'checkoutMain']);
});

// Regression, 2026-08-25: root-caused live via apply-task-loop.log -- a real task
// (adhoc-add-a-hardware-tab-...) failed every single apply attempt with "fatal: a branch
// named 'agent/adhoc-add-a-hardware-tab-...' already exists", forever, after a prior
// interrupted apply attempt left the branch behind (createBranch() had no surrounding
// try/catch at all -- an exception there propagated straight out of applyTask() with zero
// cleanup, unlike every other failure point in this function). The deleteBranch() call
// added right before createBranch() (asserted by name above) is unconditional and
// best-effort -- must not throw even when there is genuinely nothing to delete (the
// overwhelmingly common case, a task's very first apply attempt).
test('a pre-existing stale branch with the same name is deleted before creating a fresh one, without failing', () => {
  const gitRunner = createFakeGitRunner();
  const result = applyTask(baseTask(), { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  assert.equal(result.succeeded, true);
  const deleteCall = gitRunner.calls.find((c) => c.name === 'deleteBranch');
  assert.ok(deleteCall, 'deleteBranch must be called defensively before createBranch');
  assert.equal(deleteCall.args[0], 'agent/test-task-1');
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
  assert.deepEqual(names, ['fetchMain', 'resetToMain', 'deleteBranch', 'createBranch', 'add', 'commit', 'push']);
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
  // commit happened, push was attempted and failed -- no checkoutMain/deleteBranch AFTER
  // the failure: the branch and its real commit are deliberately left in place, not
  // discarded. The one deleteBranch call present is the defensive pre-cleanup BEFORE
  // createBranch, unconditional and unrelated to this test's own push failure.
  assert.deepEqual(names, ['fetchMain', 'resetToMain', 'deleteBranch', 'createBranch', 'add', 'commit', 'push']);
});

test('artifact write failure rolls back the branch before any add/commit/push', () => {
  const gitRunner = createFakeGitRunner();
  // implementResponse that applyGroupB cannot parse -> writeArtifact throws.
  const task = baseTask({ implementResponse: 'not valid json' });
  const result = applyTask(task, { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  assert.equal(result.succeeded, false);
  const names = gitRunner.calls.map((c) => c.name);
  // First deleteBranch is the defensive pre-cleanup before createBranch; second is the
  // real rollback after the artifact write failure.
  assert.deepEqual(names, ['fetchMain', 'resetToMain', 'deleteBranch', 'createBranch', 'checkoutMain', 'deleteBranch']);
});

// Regression, 2026-08-22: an empty implementResponse (several Group B sources are
// explicitly told to output this when there's nothing to change -- see
// review-task.js's EMPTY_APPROVAL_SOURCES, which already approves this exact shape at
// review time) used to reach applyGroupB's JSON.parse unconditionally and throw "Invalid
// JSON in Group B implementResponse: Unexpected end of JSON input", landing the task in
// blocked/ instead of a clean skip -- found as a real 6-task cluster in queue/blocked/.
test('an empty implementResponse (an approved no-changes-needed outcome) skips cleanly instead of throwing a JSON parse error', () => {
  const gitRunner = createFakeGitRunner();
  const task = baseTask({ source: 'arch_review', implementResponse: '' });
  const result = applyTask(task, { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  assert.equal(result.succeeded, true);
  assert.match(result.doneMarker, /no code change needed/);
});

// --- arch_discovery/arch_import/observability_review/performance_review: direct-to-main
// path (no throwaway branch) --------------------------------------------------------
// Confirmed live 2026-08-16: the old branch-per-task flow left ~301 of ~311 real applied
// candidates stranded on branches nobody ever merged. These four sources commit straight
// onto main instead and push immediately, ignoring skipPush -- see DIRECT_TO_MAIN_SOURCES'
// own header comment in apply-task.js for the full reasoning, including the 2026-08-21
// fix (this file's own tests set domain: 'arch_discovery' below, matching the OLD
// task.domain-based check -- real tasks always carry domain: 'default' with the real
// distinguishing name in task.source, which is why that check never actually fired
// against real traffic despite these tests passing the whole time).

function archDiscoveryTask(overrides = {}) {
  return baseTask({
    domain: 'default',
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
  const task = baseTask({ domain: 'default', source: 'arch_import', implementResponse: '### AC-1 · X\nStrength: Strong\n\nbody' });
  delete task.promptContext;
  const result = applyTask(task, { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  assert.equal(result.succeeded, false);
  const names = gitRunner.calls.map((c) => c.name);
  assert.deepEqual(names, ['fetchMain', 'resetToMain', 'resetToMain']);
});

// --- candidateSplitProposals: a task judged too large for one atomic edit writes its
// sub-candidates back into the candidates doc instead of applying a diff (2026-08-26, see
// prompts.js's candidateSplitInstructions and local-draft.js's parseCandidateSplit for the
// full incident/design, root-caused live via arch-review-ac-4). arch_review is NOT a
// DIRECT_TO_MAIN_SOURCE, so this goes through the normal branch-per-task flow above, not
// arch_discovery's direct-to-main path -- the split result just replaces the diff at the
// writeArtifact step.
function arSplitTask(overrides = {}) {
  return baseTask({
    domain: 'default',
    source: 'arch_review',
    candidateSplitProposals: [
      { title: 'Extract git path', files: 'src/apply-task.js', problem: 'p1', solution: 's1', benefits: 'b1' },
      { title: 'Extract direct-write path', files: 'src/apply-task.js', problem: 'p2', solution: 's2', benefits: 'b2' },
    ],
    ...overrides,
  });
}

test('candidateSplitProposals: writes both sub-candidates into ARCH_REVIEW_CANDIDATES.md and applies through the normal branch flow (no diff needed)', () => {
  const gitRunner = createFakeGitRunner();
  const result = applyTask(arSplitTask(), { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  assert.equal(result.succeeded, true);
  assert.equal(result.branch, 'agent/test-task-1');
  const names = gitRunner.calls.map((c) => c.name);
  assert.deepEqual(names, ['fetchMain', 'resetToMain', 'deleteBranch', 'createBranch', 'add', 'commit', 'push', 'checkoutMain']);

  const doc = fs.readFileSync(path.join(REPO_ROOT, 'Docs', 'ARCH_REVIEW_CANDIDATES.md'), 'utf8');
  assert.match(doc, /# Architecture Review Candidates/);
  assert.match(doc, /Extract git path/);
  assert.match(doc, /Extract direct-write path/);
  assert.match(doc, /Files: src\/apply-task\.js/);
});

test('candidateSplitProposals: throws (rolls back the branch) when the resolved source has no registered candidatesPath', () => {
  const gitRunner = createFakeGitRunner();
  // trouble_log is a real registered source with no candidatesPath field.
  const task = arSplitTask({ source: 'trouble_log' });
  const result = applyTask(task, { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  assert.equal(result.succeeded, false);
  assert.match(result.reason, /no registered candidatesPath/);
  const names = gitRunner.calls.map((c) => c.name);
  assert.deepEqual(names, ['fetchMain', 'resetToMain', 'deleteBranch', 'createBranch', 'checkoutMain', 'deleteBranch']);
});

test('arch_import: same direct-to-main shape as arch_discovery (both sources share DIRECT_TO_MAIN_SOURCES)', () => {
  const gitRunner = createFakeGitRunner();
  const task = baseTask({
    domain: 'default',
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

// Regression, 2026-08-21: real observability_review/performance_review tasks -- like
// every source above -- stamp domain: 'default' (defaultDomain, config.js) and carry
// their real identity in task.source alone. Exercising that exact realistic shape (not
// domain: 'observability_review', which no real task ever has) is what would have
// caught the task.domain-vs-task.source bug that made the fast path dead code.
test('observability_review: real task shape (domain: default, source: observability_review) takes the direct-to-main path', () => {
  const gitRunner = createFakeGitRunner();
  const task = baseTask({
    domain: 'default',
    source: 'observability_review',
    implementResponse: [
      '### AC-1 · Example observability candidate',
      'Strength: Strong',
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

test('performance_review: same direct-to-main shape (domain: default, source: performance_review)', () => {
  const gitRunner = createFakeGitRunner();
  const task = baseTask({
    domain: 'default',
    source: 'performance_review',
    implementResponse: [
      '### AC-1 · Example performance candidate',
      'Strength: Strong',
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
  assert.deepEqual(names, ['fetchMain', 'resetToMain', 'deleteBranch', 'createBranch', 'add', 'commit', 'push', 'checkoutMain']);
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

// --- adhoc/research_task/pipeline_self_audit/product_spec: these four used to each hold
// in queue/awaiting-confirm/ for an explicit confirm click (adhocApplyConfirmedAt/
// researchApplyConfirmedAt/pipelineSelfFixConfirmedAt/productSpecConfirmedAt) before a
// real diff could even reach a pushed branch. REMOVED 2026-08-22 (Grimmethy: "I'd like to
// skip the confirm step. We already have a manual step for merge to main. This extra
// step is unnecessary friction.") -- the merge-to-main step (api_git_merge_branch) is
// still always a separate, manual dashboard action; these tasks now proceed straight to
// that same pushed-but-unmerged state a confirmed task used to reach. The *ConfirmedAt
// fields are simply ignored now (harmless if still present on an old task record).
// Delete-mode's own awaiting-confirm gate above is UNCHANGED -- see its own comment.

test('an adhoc task with a real rawDiff proceeds directly to the real git-branch-diff flow', () => {
  const gitRunner = createFakeGitRunner();
  const task = baseTask({ domain: 'adhoc', source: 'manual', rawDiff: 'diff --git a/x b/x\n', implementResponse: 'summary\n\n=== DIFF ===\ndiff --git a/x b/x\n' });
  const result = applyTask(task, { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  // No confirm gate to hold it -- resetToMain/createBranch ran immediately. (Fails at the
  // real `git apply` step since REPO_ROOT here isn't a real git repo/matching diff --
  // applyAdhocDiff.test.js covers that path against real git.)
  assert.equal(result.needsConfirmation, undefined);
  const names = gitRunner.calls.map((c) => c.name);
  assert.ok(names.includes('resetToMain'), 'no gate holding it back from the real git-branch-diff flow');
});

test('an adhoc task with an empty rawDiff (no-changes-needed) never commits or pushes', () => {
  const gitRunner = createFakeGitRunner();
  const task = baseTask({ domain: 'adhoc', source: 'manual', rawDiff: '', adhocResolution: 'no-changes-needed', implementResponse: 'already resolved' });
  const result = applyTask(task, { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  // Falls through to applyAdhocDiff's own {skipped} branch -- the normal git-branch-diff
  // sequence still runs fetch/reset/branch BEFORE writeArtifact is called (same as every
  // other {skipped} outcome on a non-special-cased domain), then cleans the throwaway
  // branch back up once it sees {skipped} -- no commit/push, though.
  assert.equal(result.needsConfirmation, undefined);
  assert.equal(result.succeeded, true);
  const names = gitRunner.calls.map((c) => c.name);
  assert.ok(!names.includes('commit'), 'a skipped (no-op) outcome must never commit');
  assert.ok(!names.includes('push'), 'a skipped (no-op) outcome must never push');
});

test('a research task with a real researchDoc proceeds, writes into SecondBrain, and never touches git', () => {
  const gitRunner = createFakeGitRunner();
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-task-research-test-'));
  const secondBrainDir = path.join(scratchDir, 'secondbrain');
  const brainDumpPath = path.join(scratchDir, 'brain-dump.json');
  fs.writeFileSync(brainDumpPath, JSON.stringify({ entries: [{ id: 'bd-1', status: 'actioned' }] }));

  const task = baseTask({
    domain: 'research', source: 'research_task',
    researchDoc: '# goblinnib\n\nReal findings.',
    promptContext: { secondBrainPath: 'references/goblinnib.md', brainDumpEntryId: 'bd-1' },
  });
  const result = applyTask(task, { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, brainDumpPath, secondBrainDir, gitRunner });

  assert.equal(result.succeeded, true);
  assert.equal(result.needsConfirmation, undefined);
  assert.deepEqual(gitRunner.calls, [], 'research never touches git');

  const noteText = fs.readFileSync(path.join(secondBrainDir, 'references/goblinnib.md'), 'utf8');
  assert.match(noteText, /Real findings\./);

  const entries = JSON.parse(fs.readFileSync(brainDumpPath, 'utf8')).entries;
  assert.equal(entries[0].status, 'actioned');
  assert.match(entries[0].resolvedNote, /Researched and filed/);
});

test('a pipeline_self_audit task with a real implementResponse proceeds directly to the real git-branch-diff flow', () => {
  const gitRunner = createFakeGitRunner();
  const task = baseTask({
    domain: 'default', source: 'pipeline_self_audit',
    implementResponse: JSON.stringify({ mode: 'edit', file: 'foo.js', find: 'a', replace: 'b' }),
  });
  const result = applyTask(task, { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  assert.equal(result.needsConfirmation, undefined);
  const names = gitRunner.calls.map((c) => c.name);
  assert.ok(names.includes('resetToMain'), 'no gate holding it back from the real git-branch-diff flow');
});

test('a pipeline_self_audit task with an empty implementResponse (nothing groundable found) never commits', () => {
  const gitRunner = createFakeGitRunner();
  const task = baseTask({ domain: 'default', source: 'pipeline_self_audit', implementResponse: '' });
  const result = applyTask(task, { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  assert.equal(result.needsConfirmation, undefined);
  const names = gitRunner.calls.map((c) => c.name);
  assert.ok(!names.includes('commit'), 'nothing to commit');
});

test('a product_spec task with a real implementResponse proceeds directly to the real git-branch-diff flow', () => {
  const gitRunner = createFakeGitRunner();
  const task = baseTask({
    domain: 'default', source: 'product_spec',
    implementResponse: JSON.stringify({ mode: 'create', file: 'Docs/PRODUCT_SPEC.md', content: '## Entities\n\n- Contact\n' }),
  });
  const result = applyTask(task, { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  assert.equal(result.needsConfirmation, undefined);
  const names = gitRunner.calls.map((c) => c.name);
  assert.ok(names.includes('resetToMain'), 'no gate holding it back from the real git-branch-diff flow');
});

test('a product_spec task with an empty implementResponse never commits', () => {
  const gitRunner = createFakeGitRunner();
  const task = baseTask({ domain: 'default', source: 'product_spec', implementResponse: '' });
  const result = applyTask(task, { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  assert.equal(result.needsConfirmation, undefined);
  const names = gitRunner.calls.map((c) => c.name);
  assert.ok(!names.includes('commit'), 'nothing to commit');
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
// change, not a generic "Ornith" brand name that discards task.draftModel's actual tag
// (2026-08-24: the generic fallback itself was also renamed from "Ornith" to "Local Model").
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

  assert.match(gitRunner.capturedCommitMessage, /Co-Authored-By: Local Model \(qwen3\.8:27b-q4_K_M\) <noreply@agent-manager\.local>/);
});

test('coAuthorTrailer: a Claude draftModel still credits Claude with its specific model name (no regression)', () => {
  const gitRunner = gitRunnerCapturingCommitMessage();
  applyTask(baseTask({ draftModel: 'claude:sonnet' }), { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  assert.match(gitRunner.capturedCommitMessage, /Co-Authored-By: Claude \(sonnet\) <noreply@anthropic\.com>/);
});

test('coAuthorTrailer: a task with no draftModel at all (queued before the field existed) falls back to the bare generic label', () => {
  const gitRunner = gitRunnerCapturingCommitMessage();
  applyTask(baseTask({ draftModel: undefined }), { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  assert.match(gitRunner.capturedCommitMessage, /Co-Authored-By: Local Model <noreply@agent-manager\.local>/);
  assert.doesNotMatch(gitRunner.capturedCommitMessage, /Local Model \(/);
});

// Auto-drain (2026-08-20, blocked-drain.js -- Grimmethy: "What kind of mechanism can we
// use to change the reasoning models approach to blocked tasks that allow them to
// drain?"): once a pipeline_self_audit fix genuinely lands (real branch/commit/push, not
// the earlier unconfirmed pass and not a no-op), every currently-blocked task sharing the
// same failure signature gets automatically requeued.

test('a landed pipeline_self_audit fix auto-requeues blocked tasks sharing its signature', () => {
  const blockedDir = path.join(PIPELINE_DIR, 'queue', 'blocked');
  fs.mkdirSync(blockedDir, { recursive: true });
  fs.writeFileSync(path.join(blockedDir, 'arch-import-victim-1.json'), JSON.stringify({
    id: 'arch-import-victim-1', source: 'arch_import',
    history: [{ stage: 'harness-search', detail: '3 quer(y/ies), 0 hit(s), 0 file(s)' }],
  }));

  const gitRunner = createFakeGitRunner();
  const task = baseTask({
    source: 'pipeline_self_audit',
    promptContext: { signature: 'arch_import::harness-search-zero-results' },
    pipelineSelfFixConfirmedAt: '2026-08-20T00:00:00.000Z', // past the awaiting-confirm gate
  });
  const result = applyTask(task, { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  assert.equal(result.succeeded, true);
  assert.ok(result.branch, 'a real fix must have actually landed for the drain to fire at all');
  assert.equal(fs.existsSync(path.join(blockedDir, 'arch-import-victim-1.json')), false);
  const pending = JSON.parse(fs.readFileSync(path.join(PIPELINE_DIR, 'queue', 'pending', 'arch-import-victim-1.json'), 'utf8'));
  assert.equal(pending.status, 'pending');

  fs.rmSync(path.join(PIPELINE_DIR, 'queue'), { recursive: true, force: true });
});

test('a pipeline_self_audit task with no signature never attempts to drain anything', () => {
  const gitRunner = createFakeGitRunner();
  const task = baseTask({ source: 'pipeline_self_audit', promptContext: {}, pipelineSelfFixConfirmedAt: '2026-08-20T00:00:00.000Z' });
  const result = applyTask(task, { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  assert.equal(result.succeeded, true);
  assert.equal(fs.existsSync(path.join(PIPELINE_DIR, 'queue', 'pending')), false);
});
