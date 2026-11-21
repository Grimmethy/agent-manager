'use strict';

// Unit tests for normalizeTaskPathsToRoot in src/root-drift.js. Covers the
// TaxHarvest/ -> git root rewrite across promptContext.files, the Files: line in
// promptContext.body, and fetchedFiles[].path; unmatched paths reported in
// unresolved; the TaxHarvest vs TaxHarvestX prefix collision; and equal-root
// no-ops. Style follows pre-dispatch-gate.test.js (node:test + node:assert/strict,
// CommonJS require).

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeTaskPathsToRoot } = require('./root-drift.js');

// Fresh fixture per call so each test starts from an unmodified task.
function makeTask() {
  return {
    id: 'task-1',
    generatedForRepoRoot: 'TaxHarvest',
    promptContext: {
      files: ['TaxHarvest/src/a.js', 'TaxHarvest/src/b.js'],
      body: 'Intro line\nFiles: TaxHarvest/src/a.js, TaxHarvest/src/b.js\nTrailing line',
      fetchedFiles: [{ path: 'TaxHarvest/src/a.js', content: 'x' }],
    },
  };
}

test('TaxHarvest/ changed to git root rewrites files, Files: line, and fetchedFiles', () => {
  const task = makeTask();
  const { task: out, unresolved } = normalizeTaskPathsToRoot(task, 'TaxHarvest/', '');

  assert.deepEqual(out.promptContext.files, ['src/a.js', 'src/b.js']);
  assert.equal(
    out.promptContext.body,
    'Intro line\nFiles: src/a.js, src/b.js\nTrailing line',
  );
  assert.equal(out.promptContext.fetchedFiles[0].path, 'src/a.js');
  assert.equal(out.promptContext.fetchedFiles[0].content, 'x');
  assert.deepEqual(unresolved, []);
});

test('normalization returns a new object and does not mutate the input', () => {
  const task = makeTask();
  const before = makeTask();
  const { task: out } = normalizeTaskPathsToRoot(task, 'TaxHarvest/', '');

  assert.notEqual(out, task);
  assert.deepEqual(task, before);
});

test('path not starting with the old root is unchanged and reported in unresolved', () => {
  const task = makeTask();
  task.promptContext.files.push('other/lib/x.js');
  const { task: out, unresolved } = normalizeTaskPathsToRoot(task, 'TaxHarvest/', '');

  assert.deepEqual(out.promptContext.files, ['src/a.js', 'src/b.js', 'other/lib/x.js']);
  assert.deepEqual(unresolved, ['other/lib/x.js']);
});

test('TaxHarvestX/ is not rewritten by a TaxHarvest root (segment-wise match)', () => {
  const task = makeTask();
  task.promptContext.files.push('TaxHarvestX/src/y.js');
  const { task: out, unresolved } = normalizeTaskPathsToRoot(task, 'TaxHarvest', '');

  // Segment-wise match: 'TaxHarvestX' is a different first segment than 'TaxHarvest',
  // so rebase returns null and the path is left as-is and reported as unresolved.
  assert.equal(out.promptContext.files[2], 'TaxHarvestX/src/y.js');
  assert.deepEqual(unresolved, ['TaxHarvestX/src/y.js']);
});

test('equal old and new roots is a no-op returning the same task reference', () => {
  const task = makeTask();
  const r1 = normalizeTaskPathsToRoot(task, 'TaxHarvest', 'TaxHarvest');
  assert.equal(r1.task, task);
  assert.deepEqual(r1.unresolved, []);

  const r2 = normalizeTaskPathsToRoot(task, 'TaxHarvest/', 'TaxHarvest');
  assert.equal(r2.task, task);
  assert.deepEqual(r2.unresolved, []);
});
