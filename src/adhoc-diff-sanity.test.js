'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { adhocDiffSubstanceProblem, parseChangedFiles, extractForbiddenPaths } = require('./adhoc-diff-sanity.js');

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
