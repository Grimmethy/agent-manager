'use strict';

// Unit tests for apply-task.js's git sequencing -- the single highest-consequence
// untested path in this package (it's the one place that actually mutates the consumer's
// real git repo). Uses createFakeGitRunner (git-runner.js) as the injectable test double
// instead of a real repo/child_process, so these run instantly with no git or filesystem
// dependency beyond the temp commit-message file apply-task.js itself writes.
//
// Run: node --test src/apply-task.test.js  (or `npm test`, see package.json)

const test = require('node:test');

// The pre-2026-09-19 direct-to-main behavior still exists behind an explicit opt-in
// (AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH=true, see lib/main-push-policy.js). These tests keep it
// covered; the gated default has its own tests at the bottom of this file.
function ungatedTest(name, fn) {
  test(name, async (t) => {
    const saved = process.env.AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH;
    process.env.AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH = 'true';
    try { return await fn(t); } finally {
      if (saved === undefined) delete process.env.AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH; else process.env.AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH = saved;
    }
  });
}
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

const { applyTask, recordApplyOutcome, safeApplyCall } = require('./apply-task.js');

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
      directToMain: true, // these candidate-generator sources commit straight to main -- the real
      // agent-manager-hygiene registrations set this; mirror it so the direct-to-main tests below
      // exercise the same path production does (ADR-0022 Stage G dropped the DIRECT_TO_MAIN_SOURCES literal).
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
    directToMain: true, // see the loop above
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
  // The trailing resetToMain (2026-09-24) clears the partial write abandonBranch() leaves uncommitted in the working tree.
  assert.deepEqual(names, ['fetchMain', 'resetToMain', 'deleteBranch', 'createBranch', 'checkoutMain', 'deleteBranch', 'resetToMain']);
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

// Regression, 2026-09-06: found live as a real 2-task cluster (observability-fix-ac-45,
// -ac-59) in queue/blocked/ -- a Group B source can legitimately answer with a plain-text
// "FALSE POSITIVE" refusal (the flagged issue no longer exists in the real file) instead
// of a change. Review approved this prose as a genuinely correct answer, but apply had no
// matching check (unlike the empty-response case above) and threw "Invalid JSON in Group
// B implementResponse: Unexpected token 'F', \"FALSE POSI\"...", landing the task in
// blocked/ instead of a clean skip.
test('a "FALSE POSITIVE" prose refusal skips cleanly instead of throwing a JSON parse error', () => {
  const gitRunner = createFakeGitRunner();
  const refusal = 'FALSE POSITIVE -- the real file already contains the corrected block; the flagged issue no longer exists.';
  const task = baseTask({ source: 'observability_fix', implementResponse: refusal });
  const result = applyTask(task, { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  assert.equal(result.succeeded, true);
  assert.match(result.doneMarker, /false positive/i);
  assert.match(result.doneMarker, /already contains the corrected block/);
});

test('a "false positive" refusal is matched case-insensitively and with a hyphen', () => {
  const gitRunner = createFakeGitRunner();
  const task = baseTask({ source: 'observability_fix', implementResponse: 'false-positive: nothing to do here.' });
  const result = applyTask(task, { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });
  assert.equal(result.succeeded, true);
  assert.match(result.doneMarker, /false positive/i);
});

test('a real Group B JSON change is never misclassified just because it mentions "false positive" inside a string value', () => {
  const gitRunner = createFakeGitRunner();
  const change = JSON.stringify({
    mode: 'edit', file: 'foo.js', find: 'a', replace: 'b',
    note: 'this was previously flagged as a false positive but is real',
  });
  const task = baseTask({ source: 'observability_fix', implementResponse: change });
  const result = applyTask(task, { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });
  // Must take the real Group B apply-and-commit path, not a skip -- the anchored regex
  // only matches when the response itself STARTS with "false positive", never a substring
  // buried inside real JSON.
  assert.equal(result.succeeded, true);
  assert.equal(result.doneMarker, undefined, 'a real applied change has no doneMarker -- only a skip does');
  assert.equal(fs.readFileSync(path.join(REPO_ROOT, 'foo.js'), 'utf8'), 'b');
});

// --- assertStageableFiles guard (src/lib/apply-core.js): a registered source whose
// artifact carries neither `file` nor `files` used to reach `git add [undefined]` here,
// producing "fatal: pathspec 'undefined' did not match any files" -- a real, live failure
// (2026-09-01, first real pipeline_forensics report) that recurred 3 times on task 12
// before a manual re-approve unblocked it. `filesToAdd = artifact.files || [artifact.file]`
// with neither present yields `[undefined]`; assertStageableFiles now throws a clear
// "no target file path" error at that exact point instead. Note: this throw happens AFTER
// writeArtifact()'s own try/catch (which is the only block that runs checkoutMain/
// deleteBranch cleanup), so unlike the "artifact write failure rolls back" test above, the
// throwaway branch is left created (empty, no commit) rather than torn back down here --
// the next apply attempt's defensive pre-createBranch deleteBranch (see the "pre-existing
// stale branch" test) sweeps it up. The one guarantee that matters -- never reaching git add
// with the bad [undefined] pathspec -- still holds.
test('a registered source whose artifact has neither file nor files throws "no target file path" instead of reaching git add [undefined]', () => {
  const name = 'guard_no_file_probe';
  if (!getRegisteredSource(name)) {
    registerTaskSource(name, {
      priority: 80,
      next: () => null,
      apply: () => ({}), // no `file`, no `files` -- the exact shape that used to crash git
    });
  }
  const gitRunner = createFakeGitRunner();
  const task = baseTask({ source: name, id: 'guard-no-file-1' });
  const result = applyTask(task, { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  assert.equal(result.succeeded, false);
  assert.match(result.reason, /no target file path/);
  assert.match(result.reason, /guard-no-file-1/);
  const names = gitRunner.calls.map((c) => c.name);
  // Branch created, then the guard throws before writeArtifact ever gets to filesToAdd/add
  // -- crucially never reaches add/commit/push with the bad [undefined] pathspec.
  assert.deepEqual(names, ['fetchMain', 'resetToMain', 'deleteBranch', 'createBranch']);
  assert.ok(!names.includes('add'), 'must never call git add with an undefined pathspec');
});

test('a registered source whose artifact has files: [] (empty array) also throws "no target file path"', () => {
  const name = 'guard_empty_files_probe';
  if (!getRegisteredSource(name)) {
    registerTaskSource(name, {
      priority: 80,
      next: () => null,
      apply: () => ({ files: [] }),
    });
  }
  const gitRunner = createFakeGitRunner();
  const task = baseTask({ source: name, id: 'guard-empty-files-1' });
  const result = applyTask(task, { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  assert.equal(result.succeeded, false);
  assert.match(result.reason, /no target file path/);
  assert.ok(!gitRunner.calls.some((c) => c.name === 'add'));
});

test('applyDirectToMainBatch: a directToMain source whose artifact has no file/files fails that one task with "no target file path" instead of crashing the whole batch', () => {
  const name = 'guard_no_file_batch_probe';
  if (!getRegisteredSource(name)) {
    registerTaskSource(name, {
      priority: 80,
      next: () => null,
      directToMain: true,
      apply: () => ({}), // same undefined-pathspec shape, exercised through the batch path
    });
  }
  const gitRunner = createFakeGitRunner();
  const bad = baseTask({ source: name, id: 'guard-batch-bad-1' });
  const good = batchTriageTask('guard-batch-good-1');
  const out = applyDirectToMainBatch([bad, good], { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  assert.equal(out.results['guard-batch-bad-1'].succeeded, false);
  assert.match(out.results['guard-batch-bad-1'].reason, /no target file path/);
  assert.equal(out.results['guard-batch-good-1'].succeeded, true, 'a sibling task in the same batch still applies cleanly');
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

ungatedTest('arch_discovery: commits straight to main, no branch, pushes immediately even without skipPush set', () => {
  const gitRunner = createFakeGitRunner();
  const result = applyTask(archDiscoveryTask(), { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  assert.equal(result.succeeded, true);
  assert.equal(result.pushed, true);
  assert.equal(result.branch, gitRunner.mainBranch);
  const names = gitRunner.calls.map((c) => c.name);
  // No createBranch, no checkoutMain, no deleteBranch -- pushMain instead of push(branch).
  assert.deepEqual(names, ['fetchMain', 'resetToMain', 'add', 'commit', 'pushMain']);
});

ungatedTest('a source with `directToMain: true` on its registration takes the direct-to-main path even without a DIRECT_TO_MAIN_SOURCES literal entry', () => {
  const name = 'sa1_direct_probe';
  if (!getRegisteredSource(name)) {
    registerTaskSource(name, {
      priority: 80,
      next: () => null,
      directToMain: true,
      apply: ({ implementResponse, task }) => applyArchDiscoveryCandidates({
        implementResponse,
        candidatesPath: path.join(PIPELINE_DIR, `${name.toUpperCase()}.md`),
        snippet: task && task.promptContext && task.promptContext.snippet,
      }),
    });
  }
  const gitRunner = createFakeGitRunner();
  const result = applyTask(archDiscoveryTask({ source: name, id: 'sa1-direct-1' }), { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  assert.equal(result.succeeded, true);
  assert.equal(result.branch, gitRunner.mainBranch);
  assert.deepEqual(gitRunner.calls.map((c) => c.name), ['fetchMain', 'resetToMain', 'add', 'commit', 'pushMain']);
});

ungatedTest('arch_discovery: still pushes even when skipPush is true -- an unpushed direct-to-main commit would be destroyed by the next resetToMain()', () => {
  const gitRunner = createFakeGitRunner();
  const result = applyTask(archDiscoveryTask(), { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner, skipPush: true });

  assert.equal(result.succeeded, true);
  assert.equal(result.pushed, true);
  const names = gitRunner.calls.map((c) => c.name);
  assert.ok(names.includes('pushMain'));
});

ungatedTest('arch_discovery: push failure keeps the commit local instead of rolling it back (there is no branch to roll back)', () => {
  const gitRunner = createFakeGitRunner({ failOn: 'pushMain', failMessage: 'remote: connection reset' });
  const result = applyTask(archDiscoveryTask(), { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  assert.equal(result.succeeded, false);
  assert.match(result.reason, /push to main failed after commit succeeded \(kept local, not rolled back\)/);
  assert.match(result.reason, /remote: connection reset/);
  const names = gitRunner.calls.map((c) => c.name);
  // commit already happened and is deliberately left in place -- no checkoutMain/deleteBranch.
  assert.deepEqual(names, ['fetchMain', 'resetToMain', 'add', 'commit', 'pushMain']);
});

ungatedTest('arch_discovery: artifact write failure resets main instead of trying to delete a branch that was never created', () => {
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

ungatedTest('arch_import: a genuinely thrown write error resets main again for cleanup (called twice: once up front, once in the catch)', () => {
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
  // The trailing resetToMain (2026-09-24) clears the partial write abandonBranch() leaves uncommitted in the working tree.
  assert.deepEqual(names, ['fetchMain', 'resetToMain', 'deleteBranch', 'createBranch', 'checkoutMain', 'deleteBranch', 'resetToMain']);
});

ungatedTest('arch_import: same direct-to-main shape as arch_discovery (both sources share DIRECT_TO_MAIN_SOURCES)', () => {
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
ungatedTest('observability_review: real task shape (domain: default, source: observability_review) takes the direct-to-main path', () => {
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

ungatedTest('performance_review: same direct-to-main shape (domain: default, source: performance_review)', () => {
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

// --- applyDirectToMainBatch: N directToMain triage tasks -> ONE fetch/reset/commit/push
// instead of N. This is the fix for a 140-task backlog drain producing 140 pushed commits
// to master (see the function's own header). --------------------------------------------

const { applyDirectToMainBatch } = require('./apply-task.js');

let _batchAc = 0;
function batchTriageTask(id, extra) {
  _batchAc += 1;
  return archDiscoveryTask({
    id,
    source: 'observability_review',
    implementResponse: [`### AC-${_batchAc} · candidate ${id}`, 'Strength: Strong', 'Files: foo.js', '', 'Problem: p', 'Solution: s'].join('\n'),
    title: `Triage ${id}`,
    ...extra,
  });
}

ungatedTest('applyDirectToMainBatch: three triage tasks share ONE fetch/reset/commit/push', () => {
  const gitRunner = createFakeGitRunner();
  const tasks = [batchTriageTask('b1'), batchTriageTask('b2'), batchTriageTask('b3')];
  const out = applyDirectToMainBatch(tasks, { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  assert.equal(out.committed, true);
  assert.equal(out.pushed, true);
  for (const id of ['b1', 'b2', 'b3']) assert.equal(out.results[id].succeeded, true);

  const names = gitRunner.calls.map((c) => c.name);
  assert.equal(names.filter((n) => n === 'fetchMain').length, 1);
  assert.equal(names.filter((n) => n === 'resetToMain').length, 1);
  assert.equal(names.filter((n) => n === 'commit').length, 1, 'exactly one commit for the whole batch');
  assert.equal(names.filter((n) => n === 'pushMain').length, 1, 'exactly one push for the whole batch');
});

// 2026-09-16, root-caused live via a real stuck task (arch-discovery-community-15): the
// 2026-09-15 privacy fix (task-logs/ is gitignored -- see task-log-store.js's own header
// -- so it must be written to disk only, never staged/committed/pushed) was applied to
// apply-task.js's single-task path but missed this batch path, which is what
// apply-task.sh's --batch mode actually uses for the common case (arch_discovery,
// arch_review, observability_review, ...). Every batched apply started failing `git add`
// with "The following paths are ignored by one of your .gitignore files: task-logs" the
// moment it reached here, and looped on requeue forever since the failure is
// deterministic.
test('applyDirectToMainBatch: never stages task-logs/ (gitignored, disk-only) -- regression for the batch path missing the 2026-09-15 fix', () => {
  const gitRunner = createFakeGitRunner();
  const task = batchTriageTask('tl1');
  const out = applyDirectToMainBatch([task], { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  assert.equal(out.results.tl1.succeeded, true);
  const addCall = gitRunner.calls.find((c) => c.name === 'add');
  assert.ok(addCall, 'add was called');
  const staged = addCall.args[0];
  assert.ok(!staged.some((f) => f.startsWith('task-logs/')), `task-logs/ must never be staged, got: ${JSON.stringify(staged)}`);
  // the log is still written to disk for the user's own local reference
  assert.ok(fs.existsSync(path.join(REPO_ROOT, 'task-logs', 'tl1.json')), 'task-logs/tl1.json should still exist on disk');
  assert.ok(gitRunner.calls.some((c) => c.name === 'commit'), 'the batch still commits');
});

ungatedTest('applyDirectToMainBatch: refuses a non-directToMain source instead of batching it', () => {
  const gitRunner = createFakeGitRunner();
  const good = batchTriageTask('ok1');
  const bad = baseTask({ id: 'branchy-1', source: 'trouble_log' }); // real branch source, not directToMain
  const out = applyDirectToMainBatch([good, bad], { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  assert.equal(out.results.ok1.succeeded, true);
  assert.equal(out.results['branchy-1'].succeeded, false);
  assert.match(out.results['branchy-1'].reason, /not directToMain/i);
  // the bad task never reached git
  assert.ok(!gitRunner.calls.some((c) => c.name === 'createBranch'));
});

ungatedTest('applyDirectToMainBatch: a push failure marks every batched task failed, commit kept local', () => {
  const gitRunner = createFakeGitRunner({ failOn: 'pushMain', failMessage: 'remote: connection reset' });
  const out = applyDirectToMainBatch([batchTriageTask('p1'), batchTriageTask('p2')], { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  assert.equal(out.committed, true);
  assert.equal(out.pushed, false);
  assert.equal(out.results.p1.succeeded, false);
  assert.equal(out.results.p2.succeeded, false);
  assert.match(out.results.p1.reason, /push to main failed/i);
  assert.equal(gitRunner.calls.filter((c) => c.name === 'commit').length, 1);
});

test('applyDirectToMainBatch: a needsConfirmation result is surfaced (not staged, not committed, not a "failure")', () => {
  // Regression: a directToMain source (pipeline_forensics) whose apply returns
  // { succeeded:false, needsConfirmation:true } used to be indistinguishable from a real
  // failure in the batch path -- apply-task.sh moved it to blocked/ instead of
  // awaiting-confirm/, so the ranked root-cause report was invisible to the confirm gate.
  const { registerTaskSource, getRegisteredSource } = require('./task-source-registry.js');
  if (!getRegisteredSource('batch_needs_confirm_src')) {
    registerTaskSource('batch_needs_confirm_src', {
      priority: 44, next: () => null, advisoryProse: true, directToMain: true,
      apply: ({ task }) => task.confirmedAt
        ? { succeeded: true, file: 'Docs/PIPELINE_FIX_CANDIDATES.md', doneMarker: 'filed AC-1' }
        : { succeeded: false, needsConfirmation: true, reason: 'root-cause report held for a human read' },
    });
  }
  const gitRunner = createFakeGitRunner();
  const held = baseTask({ id: 'batch-nc-1', source: 'batch_needs_confirm_src', implementResponse: 'RANKED REPORT' });
  const ok = batchTriageTask('batch-ok-1');
  const out = applyDirectToMainBatch([held, ok], { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  assert.equal(out.results['batch-nc-1'].needsConfirmation, true);
  assert.ok(!out.results['batch-nc-1'].succeeded, 'a hold is not a success (apply-task.sh checks needsConfirmation first)');
  assert.equal(out.results['batch-ok-1'].succeeded, true, 'the sibling still applies in the same batch');
  // recordApplyOutcome still routes the held one to awaiting-confirm/
  assert.equal(recordApplyOutcome(held, out.results['batch-nc-1']), 'awaiting-confirm');
});

test('applyDirectToMainBatch: empty input does not touch git', () => {
  const gitRunner = createFakeGitRunner();
  const out = applyDirectToMainBatch([], { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });
  assert.equal(out.committed, false);
  assert.equal(gitRunner.calls.length, 0);
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
    promptContext: { secondBrainPath: 'References/goblinnib.md', brainDumpEntryId: 'bd-1' },
  });
  const result = applyTask(task, { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, brainDumpPath, secondBrainDir, gitRunner });

  assert.equal(result.succeeded, true);
  assert.equal(result.needsConfirmation, undefined);
  assert.deepEqual(gitRunner.calls, [], 'research never touches git');

  const noteText = fs.readFileSync(path.join(secondBrainDir, 'References/goblinnib.md'), 'utf8');
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
    implementResponse: JSON.stringify({ category: 'task', secondBrainPath: 'Ideas/shopping.md', tags: [], actionable: true, rationale: 'r' }),
  });

  const result = applyTask(task, { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, brainDumpPath, secondBrainDir, gitRunner });

  assert.equal(result.succeeded, true);
  assert.equal(gitRunner.calls.length, 0, 'a non-git domain must never call the git runner');

  const entries = JSON.parse(fs.readFileSync(brainDumpPath, 'utf8')).entries;
  assert.equal(entries[0].status, 'sorted');
  assert.ok(fs.existsSync(path.join(secondBrainDir, 'Ideas', 'shopping.md')));

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
  assert.equal(task.status, 'blocked', 'status tracks the queue/blocked/ dir apply-task.sh moves it to');
});

test('recordApplyOutcome does not touch blockedStage/blockedReason on a successful apply', () => {
  const task = { id: 'ok-task', history: [] };
  const result = { succeeded: true, branch: 'agent/ok-task', pushed: true };

  const stage = recordApplyOutcome(task, result);

  assert.equal(stage, 'applied');
  assert.equal(task.blockedStage, undefined);
  assert.equal(task.blockedReason, undefined);
  assert.equal(task.status, 'done', 'status tracks the queue/done/ dir apply-task.sh moves it to');
});

// --- safeApplyCall (2026-09-18, bd-1789602146764) --------------------------------------
// An uncaught exception inside applyTask/applyDirectToMainBatch used to crash the whole
// apply-task.js process before recordApplyOutcome ever ran -- apply-task.sh's own
// succeeded="false" fallback on empty/unparseable stdout still moved the task to
// queue/blocked/, but with NO blockedReason/blockedStage/history event at all. Confirmed
// live: 3 real tasks (observability_review + 2 brain_dump_sort) sat in exactly that state.

test('safeApplyCall: a normal return passes through unchanged', () => {
  const r = safeApplyCall(() => ({ succeeded: true, branch: 'agent/x' }), 'applyTask');
  assert.deepEqual(r, { succeeded: true, branch: 'agent/x' });
});

test('safeApplyCall: a throw is turned into a real {succeeded:false, reason} instead of propagating', () => {
  const r = safeApplyCall(() => { throw new Error('unexpected null dereference in applyGroupB'); }, 'applyTask');
  assert.equal(r.succeeded, false);
  assert.match(r.reason, /^applyTask crashed before producing a result: unexpected null dereference in applyGroupB/);
});

test('safeApplyCall composed with recordApplyOutcome: a crash still produces a real blockedReason/blockedStage/history event, exactly like an ordinary apply failure', () => {
  const task = { id: 'crash-task', status: 'approved', history: [{ stage: 'approved', at: '2026-09-01T00:00:00Z' }] };
  const result = safeApplyCall(() => { throw new Error('Cannot read properties of undefined (reading \'sha\')'); }, 'applyTask');

  const stage = recordApplyOutcome(task, result);

  assert.equal(stage, 'apply-failed');
  assert.equal(task.status, 'blocked');
  assert.equal(task.blockedStage, 'apply');
  assert.ok(task.blockedReason, 'a crash must never leave blockedReason empty/undefined');
  assert.match(task.blockedReason, /applyTask crashed before producing a result/);
  assert.match(task.blockedReason, /Cannot read properties of undefined/);
});

test('safeApplyCall: the crash message is capped, not an unbounded full stack dump', () => {
  const r = safeApplyCall(() => { throw new Error('boom'); }, 'applyDirectToMainBatch');
  // message + up to 3 stack frames -- generous but bounded, never the whole raw stack.
  assert.ok(r.reason.length < 2000, `crash reason should be bounded, got ${r.reason.length} chars`);
});

test('recordApplyOutcome stamps a terminal noop event + terminalDisposition for a no-op apply', () => {
  const task = { id: 'noop-task', source: 'adhoc', history: [] };
  const result = { succeeded: true, doneMarker: 'no candidates in implement response -- nothing to apply' };

  const stage = recordApplyOutcome(task, result);

  assert.equal(stage, 'applied');
  assert.equal(task.terminalDisposition, 'noop');
  const stages = task.history.map((h) => h.stage);
  assert.deepEqual(stages, ['applied', 'noop']);
  assert.match(task.history[1].detail, /no-op apply: no candidates/);
});

test('recordApplyOutcome does NOT stamp noop for a real branch apply', () => {
  const task = { id: 'ship-task', source: 'adhoc', history: [] };
  recordApplyOutcome(task, { succeeded: true, branch: 'agent/ship-task', pushed: true });
  assert.equal(task.terminalDisposition, undefined);
  assert.deepEqual(task.history.map((h) => h.stage), ['applied']);
});

test('recordApplyOutcome does NOT stamp noop for a *_review source (its no-op is a dismissed, only the reconcile sweep can tell)', () => {
  const task = { id: 'rev-task', source: 'observability_review', history: [] };
  recordApplyOutcome(task, { succeeded: true, doneMarker: 'no candidates -- false positive' });
  assert.equal(task.terminalDisposition, undefined, 'left for the reconcile sweep to classify as dismissed vs noop');
  assert.deepEqual(task.history.map((h) => h.stage), ['applied']);
});

test('recordApplyOutcome reports awaiting-confirm (not apply-failed) for a needsConfirmation hold, and does not stamp blockedStage', () => {
  const task = { id: 'hold-task', history: [] };
  const result = { succeeded: false, needsConfirmation: true, reason: 'real agentic code diff ready to apply -- held for human confirmation' };

  const stage = recordApplyOutcome(task, result);

  assert.equal(stage, 'awaiting-confirm');
  assert.equal(task.blockedStage, undefined);
  assert.equal(task.status, 'awaiting-confirm');
});

test('recordApplyOutcome routes a decompose parent to coordinating/, stamping the sub-task checklist and progress', () => {
  const task = { id: 'parent-1', history: [] };
  const result = {
    coordinating: true,
    reason: 'Decomposed into 3 sub-task(s), now coordinating: a; b; c',
    subTasks: [
      { id: 'adhoc-a-1', title: 'a', status: 'pending' },
      { id: 'adhoc-b-2', title: 'b', status: 'pending' },
      { id: 'adhoc-c-3', title: 'c', status: 'pending' },
    ],
  };

  const stage = recordApplyOutcome(task, result);

  assert.equal(stage, 'coordinating');
  assert.equal(task.status, 'coordinating');
  assert.equal(task.blockedStage, undefined);
  assert.equal(task.subTasks.length, 3);
  assert.deepEqual(task.progress, { done: 0, total: 3 });
  assert.equal(task.history.at(-1).stage, 'coordinating');
});

// parentHub (2026-09-08): when the task that just re-decomposed is ITSELF a hub's child
// (promptContext.decomposedFrom set), the new hub it becomes should carry that link, so the
// Hub Tasks tab can render the real family tree.
test('recordApplyOutcome stamps parentHub from promptContext.decomposedFrom when a hub child itself decomposes', () => {
  const task = { id: 'child-1', history: [], promptContext: { decomposedFrom: 'hub-original' } };
  const result = {
    coordinating: true,
    reason: 'Decomposed into 2 sub-task(s), now coordinating: a; b',
    subTasks: [
      { id: 'adhoc-a-1', title: 'a', status: 'pending' },
      { id: 'adhoc-b-2', title: 'b', status: 'pending' },
    ],
  };

  recordApplyOutcome(task, result);

  assert.equal(task.status, 'coordinating');
  assert.equal(task.parentHub, 'hub-original');
});

test('recordApplyOutcome does not stamp parentHub when the task has no owning hub (a plain top-level decompose)', () => {
  const task = { id: 'parent-2', history: [] };
  const result = {
    coordinating: true,
    reason: 'Decomposed into 2 sub-task(s), now coordinating: a; b',
    subTasks: [
      { id: 'adhoc-a-1', title: 'a', status: 'pending' },
      { id: 'adhoc-b-2', title: 'b', status: 'pending' },
    ],
  };

  recordApplyOutcome(task, result);

  assert.equal(Object.prototype.hasOwnProperty.call(task, 'parentHub'), false);
});

// S2 of the hub-tasks extraction (2026-09-23): recordApplyOutcome resolves the coordinating
// stamping through hub-apply-routing.js's swap point instead of doing it inline -- proves a
// registered override actually runs (a future hub-tasks plugin's own hub-record shape),
// and that the default is restored afterward since this module is a process-wide singleton
// shared across every test in the suite.
test('recordApplyOutcome runs an overridden hub-apply-routing implementation instead of the default stamping', () => {
  const { setHubApplyRouting } = require('./hub-apply-routing.js');
  const calls = [];
  setHubApplyRouting({ applyCoordinatingOutcome: (task, result) => { calls.push([task.id, result.subTasks.length]); task.customHubField = 'from-the-override'; } });
  try {
    const task = { id: 'parent-override-1', history: [] };
    const result = { coordinating: true, reason: 'x', subTasks: [{ id: 'a', title: 'a', status: 'pending' }] };
    const stage = recordApplyOutcome(task, result);

    assert.equal(stage, 'coordinating');
    assert.deepEqual(calls, [['parent-override-1', 1]]);
    assert.equal(task.customHubField, 'from-the-override');
    // The override owns ALL of the stamping -- the default's subTasks/progress fields must
    // NOT also appear, or the two implementations would be running on top of each other.
    assert.equal(task.subTasks, undefined);
    assert.equal(task.progress, undefined);
  } finally {
    setHubApplyRouting(null); // restore the default -- singleton state shared across this whole suite
  }
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

test('a Group-A apply returning needsConfirmation holds at awaiting-confirm without staging anything (no "pathspec undefined")', () => {
  const { registerTaskSource, getRegisteredSource } = require('./task-source-registry.js');
  if (!getRegisteredSource('needs_confirm_src')) {
    registerTaskSource('needs_confirm_src', {
      priority: 66, next: () => null, advisoryProse: true,
      apply: ({ task }) => task.confirmedAt
        ? { succeeded: true, doneMarker: 'filed' }
        : { succeeded: false, needsConfirmation: true, reason: 'held for human review' },
    });
  }
  const gitRunner = createFakeGitRunner();
  const task = baseTask({ id: 'nc-task', source: 'needs_confirm_src', implementResponse: 'a prose report' });
  const result = applyTask(task, { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });

  assert.equal(result.succeeded, false);
  assert.equal(result.needsConfirmation, true);
  const names = gitRunner.calls.map((c) => c.name);
  assert.ok(!names.includes('add'), 'nothing is staged');
  assert.ok(!names.includes('commit'), 'nothing is committed');
  // the throwaway branch that was created is cleaned back up
  assert.ok(names.includes('checkoutMain'));

  // recordApplyOutcome routes it to awaiting-confirm/
  assert.equal(recordApplyOutcome(task, result), 'awaiting-confirm');
});

// --- stacked file-decompose child branches (file-decompose-to-hub.js `mode: stacked`) ---

test('stacked seq 1: creates the shared decompose branch off main (reset first)', () => {
  const gitRunner = createFakeGitRunner();
  const result = applyTask(baseTask({ id: 'adhoc-decompose-x-01-a', stacked: { branch: 'agent/decompose-x', seq: 1 } }),
    { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });
  assert.equal(result.succeeded, true);
  assert.equal(result.branch, 'agent/decompose-x');
  assert.deepEqual(gitRunner.calls.map((c) => c.name),
    ['fetchMain', 'remoteHasUnmergedWork', 'resetToMain', 'deleteBranch', 'createBranch', 'add', 'commit', 'push', 'checkoutMain']);
});

// 2026-09-20 (PF HUB0003-01): a nested hub's first child was numbered seq 1, so this path deleted and recreated a branch that already
// carried the parent chain's pushed steps -> non-fast-forward on every retry. Origin holding UNMERGED work on the branch means seq 1
// must ride on it (prepareStackedBranch), never reset it away.
test('stacked seq 1 with pushed, unmerged work on origin: rides on that branch instead of recreating it off main', () => {
  const gitRunner = createFakeGitRunner({ remoteBranches: ['agent/decompose-x'], isAncestorFn: () => false });
  const result = applyTask(baseTask({ id: 'adhoc-decompose-x-01-a', stacked: { branch: 'agent/decompose-x', seq: 1 } }),
    { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });
  assert.equal(result.succeeded, true);
  const names = gitRunner.calls.map((c) => c.name);
  assert.ok(names.includes('prepareStackedBranch'));
  assert.ok(!names.includes('resetToMain'), 'must not reset away the pushed steps');
  assert.ok(!names.includes('deleteBranch'), 'must not delete the branch that carries them');
});

test('stacked seq 1 whose origin branch is already merged into main: still starts fresh off main', () => {
  const gitRunner = createFakeGitRunner({ remoteBranches: ['agent/decompose-x'], isAncestorFn: () => true });
  const result = applyTask(baseTask({ id: 'adhoc-decompose-x-01-a', stacked: { branch: 'agent/decompose-x', seq: 1 } }),
    { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });
  assert.equal(result.succeeded, true);
  const names = gitRunner.calls.map((c) => c.name);
  assert.ok(!names.includes('prepareStackedBranch'));
  assert.ok(names.includes('resetToMain') && names.includes('createBranch'));
});

// 2026-09-08: seq > 1 now delegates the whole fetch/exists/ancestry decision to
// gitRunner.prepareStackedBranch (git-runner.js) -- one call from apply-task.js's own
// perspective; the fake runner's own internal decision logic is exercised directly by
// git-runner.test.js, so these tests just confirm apply-task.js calls it (not resetToMain/
// deleteBranch/createBranch directly) and correctly wires its outcome into the rest of
// the apply.
test('stacked seq 2: rides on top of the existing shared branch via prepareStackedBranch -- never resets it away directly', () => {
  const gitRunner = createFakeGitRunner({ existingBranches: ['agent/decompose-x'], remoteBranches: ['agent/decompose-x'], isAncestorFn: () => true });
  const result = applyTask(baseTask({ id: 'adhoc-decompose-x-02-b', stacked: { branch: 'agent/decompose-x', seq: 2 } }),
    { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });
  assert.equal(result.succeeded, true);
  const names = gitRunner.calls.map((c) => c.name);
  // quarantineDirtyTree + assertCleanTree (2026-09-24): the pre-flight the triage batch already had -- neither resets or deletes anything.
  assert.deepEqual(names, ['fetchMain', 'quarantineDirtyTree', 'assertCleanTree', 'prepareStackedBranch', 'checkoutTracking', 'add', 'commit', 'push', 'checkoutMain']);
  assert.ok(!names.includes('resetToMain'), 'must not reset directly -- prior steps live on this branch');
  assert.ok(!names.includes('deleteBranch'), 'must not delete the shared branch directly');
});

test('stacked child: a write failure steps off the branch but does NOT delete it', () => {
  const gitRunner = createFakeGitRunner({ existingBranches: ['agent/decompose-x'], remoteBranches: ['agent/decompose-x'], isAncestorFn: () => true });
  const result = applyTask(
    baseTask({ id: 'adhoc-decompose-x-02-b', stacked: { branch: 'agent/decompose-x', seq: 2 },
      implementResponse: JSON.stringify({ mode: 'edit', file: 'foo.js', find: 'NOPE', replace: 'b' }) }),
    { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });
  assert.equal(result.succeeded, false);
  const names = gitRunner.calls.map((c) => c.name);
  assert.ok(names.includes('checkoutMain'));
  assert.ok(!names.includes('deleteBranch'), 'the shared branch carries committed prior steps -- never delete on cleanup');
  // ...but the partial write it left uncommitted IS cleared (resetToMain acts on main only; the stacked branch keeps its commits).
  assert.ok(names.lastIndexOf('resetToMain') > names.indexOf('checkoutMain'), 'cleared after stepping off the branch');
});

// 2026-09-24 (apply-clone dirt incident): the single-task path gets the same pre-flight as the triage batch.
test('stacked seq 2 on a dirty apply clone: fails ONCE up front with the stable message, before prepareStackedBranch touches anything', () => {
  const { DIRTY_CLONE_ERROR_PREFIX } = require('./git-runner.js');
  const { isInfraApplyFailure } = require('./apply-retry-check.js');
  const gitRunner = createFakeGitRunner({ dirtyTree: 'Docs/ARCH_REVIEW_CANDIDATES.md', existingBranches: ['agent/decompose-x'], remoteBranches: ['agent/decompose-x'], isAncestorFn: () => true });
  const result = applyTask(baseTask({ id: 'adhoc-decompose-x-02-b', stacked: { branch: 'agent/decompose-x', seq: 2 } }), { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });
  assert.equal(result.succeeded, false);
  assert.ok(result.reason.startsWith(DIRTY_CLONE_ERROR_PREFIX) && /ARCH_REVIEW_CANDIDATES\.md/.test(result.reason), result.reason);
  const names = gitRunner.calls.map((c) => c.name);
  assert.deepEqual(names, ['fetchMain', 'quarantineDirtyTree', 'assertCleanTree'], 'self-heal is attempted first, then the assert -- and nothing after it');
  // The message must land where apply-retry-check treats it as INFRASTRUCTURE (held, no retry burned, released once clean), not a draft failure.
  assert.equal(isInfraApplyFailure({ blockedStage: 'apply', blockedReason: result.reason }), true);
});

test('a normal (non-stacked) apply is unchanged: resetToMain already clears stray content, so no extra pre-flight calls', () => {
  const gitRunner = createFakeGitRunner();
  applyTask(baseTask(), { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });
  const names = gitRunner.calls.map((c) => c.name);
  assert.ok(!names.includes('assertCleanTree') && !names.includes('quarantineDirtyTree'));
  assert.equal(names[1], 'resetToMain');
});

// --- Gated default (2026-09-19): nothing reaches main without a human merge ----------------------

test('gated default: a directToMain source (arch_discovery) takes the agent/<id> BRANCH path, never pushMain', () => {
  delete process.env.AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH;
  const gitRunner = createFakeGitRunner();
  const result = applyTask(archDiscoveryTask(), { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });
  assert.equal(result.succeeded, true);
  const names = gitRunner.calls.map((c) => c.name);
  assert.ok(names.includes('createBranch'), 'a branch is created');
  assert.ok(names.includes('push'), 'the BRANCH is pushed');
  assert.ok(!names.includes('pushMain'), 'main is never pushed');
  assert.notEqual(result.branch, gitRunner.mainBranch);
});

test('gated default: applyDirectToMainBatch appends onto the rolling agent/triage-queue branch and pushes THAT, not main', () => {
  delete process.env.AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH;
  const gitRunner = createFakeGitRunner();
  const tasks = [batchTriageTask('g1'), batchTriageTask('g2')];
  const out = applyDirectToMainBatch(tasks, { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });
  assert.equal(out.committed, true);
  assert.equal(out.pushed, true);
  assert.equal(out.branch, 'agent/triage-queue');
  const calls = gitRunner.calls;
  const names = calls.map((c) => c.name);
  assert.ok(names.includes('prepareStackedBranch'));
  assert.deepEqual(calls.find((c) => c.name === 'prepareStackedBranch').args, ['agent/triage-queue']);
  assert.ok(!names.includes('pushMain'), 'main is never pushed');
  assert.deepEqual(calls.find((c) => c.name === 'push').args, ['agent/triage-queue']);
  assert.equal(names.filter((n) => n === 'commit').length, 1, 'one commit for the whole batch');
  for (const id of ['g1', 'g2']) {
    assert.equal(out.results[id].succeeded, true);
    // Must not read as "already on main" to task-disposition.js's DIRECT_RE.
    assert.doesNotMatch(out.results[id].doneMarker, /committed to (?:master|main)|triage batch/i);
    assert.match(out.results[id].doneMarker, /agent\/triage-queue/);
    assert.match(out.results[id].doneMarker, /awaiting a human merge/);
  }
});

test('gated default: a triage-queue push failure marks every batched task failed and still never touches main', () => {
  delete process.env.AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH;
  const gitRunner = createFakeGitRunner({ failOn: 'push', failMessage: 'remote: connection reset' });
  const out = applyDirectToMainBatch([batchTriageTask('h1')], { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });
  assert.equal(out.pushed, false);
  assert.equal(out.results.h1.succeeded, false);
  assert.match(out.results.h1.reason, /agent\/triage-queue failed after commit/);
  assert.ok(!gitRunner.calls.some((c) => c.name === 'pushMain'));
});

test('recordApplyOutcome: a coordinating result stamps the hub serial and leads the hub title with it, replacing a candidate id', () => {
  const task = { id: 'function-length-fix-ac-2', title: 'AC-2 · Extract pure geometry', promptContext: { candidateId: 'AC-2' } };
  recordApplyOutcome(task, { coordinating: true, subTasks: [{ id: 'HUB0004-01-a', title: 'HUB0004 · 1/2 · a', status: 'pending' }], hubSerial: 4, hubLabel: 'HUB0004' });
  assert.equal(task.hubSerial, 4);
  assert.equal(task.hubLabel, 'HUB0004');
  assert.equal(task.title, 'HUB0004 · Extract pure geometry');
  assert.equal(task.id, 'function-length-fix-ac-2', 'the record keeps its file id');
  const legacy = { id: 'x', title: 'Untouched' };
  recordApplyOutcome(legacy, { coordinating: true, subTasks: [] });
  assert.equal(legacy.title, 'Untouched');
  assert.equal(legacy.hubSerial, undefined);
});

// --- the shared checkout is never left on the triage branch (2026-09-20, PF) -----------------------------------------------------------------
// The rolling triage branch is never rebased, so a checkout parked on it reads ancient code. Only the fully successful path used to return to main.
const idxOf = (calls, name) => calls.map((c) => c.name).indexOf(name);
const checkoutMains = (calls) => calls.filter((c) => c.name === 'checkoutMain').length;

test('gated triage batch: a fully successful batch returns to main exactly once, after the push', () => {
  delete process.env.AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH;
  const gitRunner = createFakeGitRunner();
  applyDirectToMainBatch([batchTriageTask('back-1')], { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });
  assert.equal(checkoutMains(gitRunner.calls), 1);
  assert.ok(idxOf(gitRunner.calls, 'checkoutMain') > idxOf(gitRunner.calls, 'push'));
});

test('gated triage batch: a batch that stages NOTHING still returns to main (it used to stay on the triage branch)', () => {
  delete process.env.AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH;
  const name = 'batch_nothing_staged_probe';
  if (!getRegisteredSource(name)) registerTaskSource(name, { priority: 80, next: () => null, directToMain: true, apply: () => ({ skipped: true, reason: 'nothing to add' }) });
  const gitRunner = createFakeGitRunner();
  const out = applyDirectToMainBatch([baseTask({ source: name, id: 'nothing-staged-1' })], { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });
  assert.equal(out.committed, false);
  const names = gitRunner.calls.map((c) => c.name);
  assert.ok(names.includes('prepareStackedBranch'), 'the triage branch was entered');
  assert.ok(!names.includes('commit') && !names.includes('push'));
  assert.equal(checkoutMains(gitRunner.calls), 1, 'and left again');
  assert.ok(idxOf(gitRunner.calls, 'checkoutMain') > idxOf(gitRunner.calls, 'prepareStackedBranch'));
});

test('gated triage batch: a THROWN commit still returns to main, and the error still propagates', () => {
  delete process.env.AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH;
  const gitRunner = createFakeGitRunner({ failOn: 'commit', failMessage: 'index.lock exists' });
  assert.throws(() => applyDirectToMainBatch([batchTriageTask('back-2')], { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner }), /index\.lock/);
  assert.equal(checkoutMains(gitRunner.calls), 1);
});

test('gated triage batch: a failed push returns to main too (the commit stays on the branch ref)', () => {
  delete process.env.AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH;
  const gitRunner = createFakeGitRunner({ failOn: 'push', failMessage: 'remote: connection reset' });
  const out = applyDirectToMainBatch([batchTriageTask('back-3')], { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });
  assert.equal(out.pushed, false);
  assert.equal(checkoutMains(gitRunner.calls), 1);
});

test('gated triage batch: a checkoutMain that itself fails is swallowed (the next apply resets)', () => {
  delete process.env.AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH;
  const gitRunner = createFakeGitRunner({ failOn: 'checkoutMain', failMessage: 'local changes would be overwritten' });
  const out = applyDirectToMainBatch([batchTriageTask('back-4')], { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });
  assert.equal(out.results['back-4'].succeeded, true);
});

ungatedTest('ungated triage batch: unchanged, no extra checkout (resetToMain already ends on main)', () => {
  const gitRunner = createFakeGitRunner();
  applyDirectToMainBatch([batchTriageTask('back-5')], { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });
  assert.equal(checkoutMains(gitRunner.calls), 0);
});

// 2026-09-23 (change_review backlog incident): the GATED triage batch checks the clone up front.
test('gated applyDirectToMainBatch: a dirty apply clone fails the batch ONCE at the pre-flight -- before entering the triage branch', () => {
  const saved = process.env.AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH;
  delete process.env.AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH;
  try {
    const gitRunner = createFakeGitRunner({ dirtyTree: 'Docs/OBSERVABILITY_FIX_CANDIDATES.md' });
    assert.throws(
      () => applyDirectToMainBatch([batchTriageTask('dirty-1'), batchTriageTask('dirty-2')], { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner }),
      /apply clone is dirty .*OBSERVABILITY_FIX_CANDIDATES\.md/,
    );
    const names = gitRunner.calls.map((c) => c.name);
    assert.deepEqual(names.filter((n) => ['quarantineDirtyTree', 'assertCleanTree'].includes(n)), ['quarantineDirtyTree', 'assertCleanTree'], 'self-heal is attempted first, then the assert');
    assert.ok(!names.includes('prepareStackedBranch'), 'never reaches the checkout/rebase that used to abort once per task');
    assert.ok(!names.includes('checkoutMain'), 'never entered the triage branch, so nothing to return from');
  } finally {
    if (saved === undefined) delete process.env.AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH; else process.env.AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH = saved;
  }
});

test('gated applyDirectToMainBatch: a clean apply clone proceeds to prepareStackedBranch after the pre-flight', () => {
  const saved = process.env.AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH;
  delete process.env.AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH;
  try {
    const gitRunner = createFakeGitRunner();
    applyDirectToMainBatch([batchTriageTask('clean-1')], { repoRoot: REPO_ROOT, pipelineDir: PIPELINE_DIR, gitRunner });
    const names = gitRunner.calls.map((c) => c.name);
    assert.ok(names.indexOf('assertCleanTree') !== -1 && names.indexOf('assertCleanTree') < names.indexOf('prepareStackedBranch'));
  } finally {
    if (saved === undefined) delete process.env.AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH; else process.env.AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH = saved;
  }
});
