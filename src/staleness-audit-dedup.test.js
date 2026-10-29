'use strict';

// Tests for src/staleness-audit-dedup.js -- the staleness flagger's 'duplicate-of' rule.
// node:test style, same as the rest of src/*.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  findDuplicateTask, normalizeTaskTokens, dupSimilarityThreshold,
  relatedAsHubAndChild, namesDisjointFiles,
} = require('./staleness-audit-dedup.js');

// --- HUB0133-01 vs HUB0134-01 (live-observed 2026-10-17 false positive) -------------
// Trimming of the two real queue records: HUB0133-01-implement-isnoopcandidate-and-early-
// exit-logic.json (a coordinating hub, subTasks includes the HUB0134-01 child) and the
// HUB0134-01-implement-isnoopcandidate-and-early-exit-logic-in-apply-group-a-brain-dump-
// js child. The pair shared ~100% of their tokens and each carried a 'duplicate-of
// (medium, retire)' flag pointing at the other -- the retire advice on live, undone work
// the bug this module now guards against.
const HUB0133_01_TEXT = 'HUB0134 . Implement isNoOpCandidate and early-exit logic. '
  + 'Implement isNoOpCandidate and early-exit logic in the apply pipeline: detect no-op '
  + 'candidates before applying and return early when nothing would change, covering group '
  + 'A of the brain-dump work. Decomposed from HUB0133-01-implement-isnoopcandidate-and-early-exit-logic.';

const HUB0134_01_TEXT = 'Implement isNoOpCandidate and early-exit logic. '
  + 'Implement isNoOpCandidate and early-exit logic in apply-group-a-brain-dump.js: '
  + 'detect no-op candidates before applying and return early when nothing would change.';

function hubRecord() {
  return {
    id: 'HUB0133-01-implement-isnoopcandidate-and-early-exit-logic',
    title: 'HUB0134 . Implement isNoOpCandidate and early-exit logic',
    state: 'coordinating',
    subTasks: ['HUB0134-01-implement-isnoopcandidate-and-early-exit-logic-in-apply-group-a-brain-dump-js'],
    promptContext: { rawText: HUB0133_01_TEXT },
  };
}

function childRecord() {
  return {
    id: 'HUB0134-01-implement-isnoopcandidate-and-early-exit-logic-in-apply-group-a-brain-dump-js',
    title: 'Implement isNoOpCandidate and early-exit logic',
    state: 'pending',
    parentHub: 'HUB0133-01-implement-isnoopcandidate-and-early-exit-logic',
    promptContext: {
      rawText: HUB0134_01_TEXT,
      decomposedFrom: 'HUB0133-01-implement-isnoopcandidate-and-early-exit-logic',
    },
  };
}

// Sanity precondition (not an assertion on the fix itself): the two records really do
// overlap at or above the default threshold, so the ONLY thing keeping them unflagged is
// the new relationship guard. This also documents that the trimmed texts are faithful
// enough to the real pair for the regression test to be meaningful.
test('precondition: hub/child texts overlap above the dup threshold', () => {
  const { jaccardSimilarity } = require('./text-similarity.js');
  const sim = jaccardSimilarity(normalizeTaskTokens(hubRecord()), normalizeTaskTokens(childRecord()));
  assert.ok(sim >= dupSimilarityThreshold(), `expected sim >= ${dupSimilarityThreshold()}, got ${sim}`);
});

test('hub is not flagged as duplicate of its own child', () => {
  assert.strictEqual(findDuplicateTask(hubRecord(), [childRecord()]), null);
});

test('child is not flagged as duplicate of its own hub', () => {
  assert.strictEqual(findDuplicateTask(childRecord(), [hubRecord()]), null);
});

test('mutation check: with the relation check disabled the hub/child pair flags again', () => {
  const hub = hubRecord();
  const child = childRecord();
  const hubFlags = findDuplicateTask(hub, [child], { relationCheck: false });
  const childFlags = findDuplicateTask(child, [hub], { relationCheck: false });
  assert.ok(hubFlags && hubFlags.id === child.id, `expected hub to flag the child, got ${JSON.stringify(hubFlags)}`);
  assert.ok(childFlags && childFlags.id === hub.id, `expected child to flag the hub, got ${JSON.stringify(childFlags)}`);
});

// --- Different-file decompose hubs (live-observed 2026-10-17 ~64% false positive) ----
// The two real file-decompose hubs:
//   file-decompose-hub-proactive-python-dashboard-static-js-analytics-and-discovery
//     (python/dashboard/static/js/analytics-and-discovery.js)
//   file-decompose-hub-proactive-python-dashboard-static-js-core-ui-js-2026-10-01
//     (python/dashboard/static/js/core-ui.js)
// Their overlap is the shared boilerplate title "Decompose python/dashboard/static/js/...
// (N module(s))" plus prompt scaffolding; the named source files differ.
function decomposeHubA() {
  return {
    id: 'file-decompose-hub-proactive-python-dashboard-static-js-analytics-and-discovery',
    title: 'Decompose python/dashboard/static/js/analytics-and-discovery.js (3 module(s))',
    state: 'coordinating',
    promptContext: { rawText: 'Decompose python/dashboard/static/js/analytics-and-discovery.js into 3 modules: '
      + 'split the render functions for the deep-dive and discovery tabs out of this file, '
      + 'moving them into their own module files. Keep the existing behavior identical.' },
  };
}

function decomposeHubB() {
  return {
    id: 'file-decompose-hub-proactive-python-dashboard-static-js-core-ui-js-2026-10-01',
    title: 'Decompose python/dashboard/static/js/core-ui.js (2 module(s))',
    state: 'coordinating',
    promptContext: { rawText: 'Decompose python/dashboard/static/js/core-ui.js into 2 modules: '
      + 'split the shared navigation and render-generation helpers out of this file, '
      + 'moving them into their own module files. Keep the existing behavior identical.' },
  };
}

test('precondition: different-file hubs name disjoint, non-empty file sets', () => {
  assert.ok(namesDisjointFiles(decomposeHubA(), decomposeHubB()), 'expected the two hubs to name disjoint files');
});

test('hubs that split different files are not flagged as duplicates of each other', () => {
  assert.strictEqual(findDuplicateTask(decomposeHubA(), [decomposeHubB()]), null);
  assert.strictEqual(findDuplicateTask(decomposeHubB(), [decomposeHubA()]), null);
});

test('mutation check: with the file-disjoint check disabled the different-file hubs flag', () => {
  const a = decomposeHubA();
  const b = decomposeHubB();
  const aFlags = findDuplicateTask(a, [b], { fileDisjointCheck: false });
  const bFlags = findDuplicateTask(b, [a], { fileDisjointCheck: false });
  assert.ok(aFlags && aFlags.id === b.id, `expected A to flag B, got ${JSON.stringify(aFlags)}`);
  assert.ok(bFlags && bFlags.id === a.id, `expected B to flag A, got ${JSON.stringify(bFlags)}`);
});

// --- Positive: a true duplicate must still flag --------------------------------------
// Two unrelated tasks (no parentHub/subTasks link, no shared lineage) naming the SAME
// file with near-identical wording -- the guards must not over-suppress this.
function dupA() {
  return {
    id: 'adhoc-move-rendernav-out-of-core-ui',
    title: 'Move renderNav out of python/dashboard/static/js/core-ui.js',
    promptContext: { rawText: 'Extract renderNav from python/dashboard/static/js/core-ui.js into its own module file, '
      + 'wiring the same calls through. Keep the tab behavior identical.' },
  };
}

function dupB() {
  return {
    id: 'adhoc-refactor-core-ui-rendernav',
    title: 'Move renderNav out of python/dashboard/static/js/core-ui.js',
    state: 'pending',
    promptContext: { rawText: 'Extract renderNav from python/dashboard/static/js/core-ui.js into its own module file, '
      + 'wiring the same calls through. Keep the tab behavior identical. Do this carefully.' },
  };
}

test('unrelated tasks naming the same file with near-identical text still flag', () => {
  const flag = findDuplicateTask(dupA(), [dupB()]);
  assert.ok(flag, 'expected a duplicate flag');
  assert.equal(flag.id, 'adhoc-refactor-core-ui-rendernav');
  assert.ok(flag.sim >= dupSimilarityThreshold(), `expected sim >= ${dupSimilarityThreshold()}, got ${flag.sim}`);
});

// --- Guards themselves ----------------------------------------------------------------
test('relatedAsHubAndChild: true in both directions, false for unrelated tasks', () => {
  assert.ok(relatedAsHubAndChild(hubRecord(), childRecord()));
  assert.ok(relatedAsHubAndChild(childRecord(), hubRecord()));
  assert.ok(!relatedAsHubAndChild(dupA(), dupB()));
  assert.ok(!relatedAsHubAndChild(decomposeHubA(), decomposeHubB()));
});

test('namesDisjointFiles: false when either side names no file, false when they share a file', () => {
  assert.ok(!namesDisjointFiles(dupA(), dupB()), 'shared file -> not disjoint');
  const noFile = { id: 't-nofiles', title: 'Fix the deploy script', promptContext: { rawText: 'Fix the deploy script for the dashboard.' } };
  assert.ok(!namesDisjointFiles(noFile, decomposeHubA()), 'one side names no file -> not disjoint');
});
