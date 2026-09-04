'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  adhocDiffSubstanceProblem, adhocNoChangesClaimProblem, parseChangedFiles, extractForbiddenPaths,
} = require('./adhoc-diff-sanity.js');

// Stubs arch-import-fetch.js's fetchForQueries for the duration of fn(), via require-cache
// substitution (adhocNoChangesClaimProblem requires it lazily, inside the function, so this
// is the only way to control its grep result without a real repo/grep call).
function withStubbedFetchForQueries(hits, fn) {
  const key = require.resolve('./arch-import-fetch.js');
  const real = require.cache[key];
  require.cache[key] = { id: key, filename: key, loaded: true, exports: { fetchForQueries: () => ({ hits }) } };
  try {
    return fn();
  } finally {
    if (real) require.cache[key] = real; else delete require.cache[key];
  }
}

const editDiff = (p) => `diff --git a/${p} b/${p}\nindex 1a2b3c..4d5e6f 100644\n--- a/${p}\n+++ b/${p}\n@@ -1 +1,2 @@\n x\n+y\n`;
const createDiff = (p) => `diff --git a/${p} b/${p}\nnew file mode 100644\nindex 0000000..abc1234\n--- /dev/null\n+++ b/${p}\n@@ -0,0 +1 @@\n+content\n`;
const deleteDiff = (p) => `diff --git a/${p} b/${p}\ndeleted file mode 100644\nindex abc1234..0000000\n--- a/${p}\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n`;
const adhoc = (rawText, planResponse) => ({ source: 'manual', promptContext: { rawText }, planResponse });

test('parseChangedFiles classifies create / edit / delete', () => {
  const d = createDiff('a.js') + editDiff('b/c.py') + deleteDiff('d.txt');
  assert.deepEqual(parseChangedFiles(d), [
    { path: 'a.js', kind: 'create' },
    { path: 'b/c.py', kind: 'edit' },
    { path: 'd.txt', kind: 'delete' },
  ]);
});

test('docs-only: an ADR for a task that clearly wants code is not an implementation', () => {
  const t = adhoc('Combine job types into expandable rows in python/dashboard/templates/index.html -- renderJobListTab().');
  const p = adhocDiffSubstanceProblem(t, createDiff('docs/adr/0021-job-list.md'));
  assert.equal(p.code, 'docs-only');
  assert.match(p.retryFeedback, /only created\/edited documentation/);
});

test('docs-only: a pure "write an ADR" task with a docs-only diff PASSES', () => {
  const t = adhoc('Decide and document the mobile access architecture. Write a short ADR in docs/adr/ recording the decision.');
  assert.equal(adhocDiffSubstanceProblem(t, createDiff('docs/adr/0022-mobile.md')), null);
});

test('docs-only: a diff that also touches real code is fine (ADR alongside implementation)', () => {
  const t = adhoc('Add a new task source in src/task-sources.js. Write an ADR in docs/adr/ alongside the implementation.');
  assert.equal(adhocDiffSubstanceProblem(t, editDiff('src/task-sources.js') + createDiff('docs/adr/0019-x.md')), null);
});

test('unrequested-delete: deleting a file the task never mentioned removing is flagged', () => {
  const t = adhoc('Add a health-check endpoint to python/dashboard/app.py.');
  const p = adhocDiffSubstanceProblem(t, deleteDiff('src/apply-adhoc-diff.js'));
  assert.equal(p.code, 'unrequested-delete');
  assert.match(p.reason, /deletes src\/apply-adhoc-diff\.js/);
});

test('unrequested-delete: a task that DOES ask to remove something is not flagged', () => {
  const t = adhoc('Remove the deprecated legacy shim src/old-thing.js and update its importers.');
  assert.equal(adhocDiffSubstanceProblem(t, deleteDiff('src/old-thing.js')), null);
});

test('forbidden-path: extractForbiddenPaths pulls src/ and a named file from real restriction phrasing', () => {
  const txt = 'this is a PRESENTATION-ONLY reorganization in python/dashboard/templates/index.html. '
    + 'Do NOT modify anything under src/, do NOT touch src/apply-adhoc-diff.js or any pipeline logic. '
    + 'This task never touches src/.';
  const f = extractForbiddenPaths(txt);
  assert.ok(f.includes('src/'));
  assert.ok(f.some((x) => x.startsWith('src/apply-adhoc-diff')));
});

test('forbidden-path: a diff touching an explicitly off-limits dir is flagged', () => {
  const t = adhoc('Reorganize the Job List tab in python/dashboard/templates/index.html. Do NOT modify anything under src/.');
  const p = adhocDiffSubstanceProblem(t, editDiff('src/adhoc-harness-draft.js'));
  assert.equal(p.code, 'forbidden-path');
  assert.match(p.retryFeedback, /EXPLICITLY forbids/);
});

test('forbidden-path: no false positive when the "do not" clause names no path', () => {
  const t = adhoc('Add a retry counter to src/reject-retry-check.js. Do not change the public API of rejectRetryCheck.');
  assert.equal(adhocDiffSubstanceProblem(t, editDiff('src/reject-retry-check.js')), null);
});

test('non-adhoc tasks and empty diffs are never gated', () => {
  assert.equal(adhocDiffSubstanceProblem({ source: 'observability_fix', promptContext: { rawText: 'x' } }, createDiff('docs/x.md')), null);
  assert.equal(adhocDiffSubstanceProblem(adhoc('implement the thing in src/x.js'), ''), null);
  assert.equal(adhocDiffSubstanceProblem(adhoc('implement the thing in src/x.js'), '   '), null);
});

// --- checks 4-5: false completion claims (2026-09-04) ----------------------

const editWithTestDefs = (p, n) => {
  const defs = Array.from({ length: n }, (_, i) => `+def test_case_${i}():\n+    assert True\n`).join('');
  return `diff --git a/${p} b/${p}\nindex 1a2b3c..4d5e6f 100644\n--- a/${p}\n+++ b/${p}\n@@ -1 +1,${n + 1} @@\n x\n${defs}`;
};

test('false-test-count-claim: summary claims more tests than the diff actually adds', () => {
  const t = adhoc('Add tests for the history collector in python/dashboard/test_hardware_stats.py.');
  const p = adhocDiffSubstanceProblem(t, editWithTestDefs('python/dashboard/test_hardware_stats.py', 1), 'Implemented. All 3 tests pass.');
  assert.equal(p.code, 'false-test-count-claim');
  assert.match(p.reason, /claims 3 tests but the diff only adds 1/);
});

test('false-test-count-claim: a matching count is not flagged', () => {
  const t = adhoc('Add tests for the history collector in python/dashboard/test_hardware_stats.py.');
  assert.equal(adhocDiffSubstanceProblem(t, editWithTestDefs('python/dashboard/test_hardware_stats.py', 3), 'Implemented. All 3 tests pass.'), null);
});

test('false-test-count-claim: no test-count claim in the summary is never checked', () => {
  const t = adhoc('Add a health-check endpoint to python/dashboard/app.py.');
  assert.equal(adhocDiffSubstanceProblem(t, editDiff('python/dashboard/app.py'), 'Implemented the endpoint.'), null);
});

test('false-file-creation-claim: summary claims a file the diff never creates', () => {
  const t = adhoc('Add a new task source in src/task-sources.js.');
  const p = adhocDiffSubstanceProblem(t, editDiff('src/task-sources.js'), 'Implemented. This creates the file `src/new-source.js` with the handler.');
  assert.equal(p.code, 'false-file-creation-claim');
  assert.match(p.reason, /claims it creates `src\/new-source\.js`/);
});

test('false-file-creation-claim: a matching creation is not flagged', () => {
  const t = adhoc('Add a new task source in src/task-sources.js.');
  const diff = editDiff('src/task-sources.js') + createDiff('src/new-source.js');
  assert.equal(adhocDiffSubstanceProblem(t, diff, 'Implemented. This creates the file `src/new-source.js`.'), null);
});

// --- adhocNoChangesClaimProblem (2026-09-04) --------------------------------

test('adhocNoChangesClaimProblem: no "Already covered:" block at all is flagged', () => {
  const t = adhoc('Add a lightweight checker script that validates the second-brain vault.');
  const p = adhocNoChangesClaimProblem(t, "I'm not making code changes here.");
  assert.equal(p.code, 'missing-citation-block');
  assert.match(p.retryFeedback, /Already covered/);
});

test('adhocNoChangesClaimProblem: a full, real citation block passes', () => {
  const t = adhoc('Add a lightweight checker script that validates the second-brain vault.');
  const summary = 'Already covered:\n- checker script -- src/second-brain-checker.js:validateVault\n- second-brain vault -- src/second-brain-checker.js:VAULT_DIR';
  assert.equal(adhocNoChangesClaimProblem(t, summary), null);
});

test('adhocNoChangesClaimProblem: a named object absent from citations AND ungrounded in the repo is flagged', () => {
  const t = adhoc('Render a sparkline for CPU history in the Hardware tab.');
  const summary = 'Already covered:\n- CPU history -- python/dashboard/hardware_stats.py:get_history';
  const p = withStubbedFetchForQueries([], () => adhocNoChangesClaimProblem(t, summary));
  assert.equal(p.code, 'ungrounded-named-object');
  assert.match(p.reason, /sparkline/i);
});

test('adhocNoChangesClaimProblem: a named object absent from citations but grep-findable is NOT flagged', () => {
  const t = adhoc('Render a sparkline for CPU history in the Hardware tab.');
  const summary = 'Already covered:\n- CPU history -- python/dashboard/hardware_stats.py:get_history';
  const p = withStubbedFetchForQueries(
    [{ file: 'templates/index.html', line: 42, query: 'sparkline' }, { file: 'src/x.js', line: 1, query: 'Render' }],
    () => adhocNoChangesClaimProblem(t, summary),
  );
  assert.equal(p, null);
});

test('adhocNoChangesClaimProblem: non-adhoc tasks and empty summaries are never gated', () => {
  assert.equal(adhocNoChangesClaimProblem({ source: 'observability_fix', promptContext: { rawText: 'x' } }, 'no citations here'), null);
  assert.equal(adhocNoChangesClaimProblem(adhoc('do the thing'), ''), null);
});
