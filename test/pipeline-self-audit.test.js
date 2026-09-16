'use strict';

// Tests for the MAX_DEBRIEF_ACTIONS cap in findAuditClusters (src/pipeline-self-audit.js).
//
// Runner note: this repo's own test convention is `node --test` (see package.json's
// "test" script), but this file also works under `npx jest test/pipeline-self-audit.test.js`
// -- it resolves whichever `test`/`describe`/`assert` surface is available instead of
// hardcoding one, so it runs green under either.
const assert =
  (typeof globalThis.assert === 'object' && globalThis.assert.ok)
    ? globalThis.assert
    : require('assert');

const test =
  typeof globalThis.test === 'function'
    ? globalThis.test
    : require('node:test').test;

const { findAuditClusters, MAX_DEBRIEF_ACTIONS } = require('../src/pipeline-self-audit.js');

// Each of these blockedReason texts maps (first-match-wins) to a DISTINCT entry of
// REASON_CATEGORIES in src/blocked-task-classifiers.js, so with one shared task.source
// they produce 5 distinct signatures `${source}::${category}`:
//   - 'fabricat'            -> fabricated-ungrounded-claim
//   - 'no-changes-needed'   -> refusal-no-changes-needed
//   - 'empty' / 'no code'   -> empty-degenerate-draft
//   - 'truncat'             -> truncated-draft
//   - 'invalid json'        -> json-parse-failure
// (None of them trip the earlier structural classifiers -- no history entries, no
// reviewInconclusive flag, no promptContext.fetchedFiles, no "ungrounded draft:" or
// "Invalid premise:" prefixes.)
const CATEGORIES = [
  'This draft contains a fabricated claim that cannot be verified against the codebase',
  'Model refused: no-changes-needed, the code is already correct',
  'empty response: no code was produced at all',
  'truncated draft output, the response was cut off mid-edit',
  'Invalid JSON in Group B implementResponse: unexpected token',
];

const SOURCE = 'synthetic_audit_source';
const PER_CLUSTER = 5; // == CLUSTER_THRESHOLD: exactly enough to qualify as a cluster

function makeCluster(categoryReason, index) {
  return Array.from({ length: PER_CLUSTER }, (_, i) => ({
    id: `synthetic-t${index}-${i}`,
    source: SOURCE,
    blockedReason: categoryReason,
  }));
}

function makeBlockedTasks(numClusters) {
  const tasks = [];
  for (let c = 0; c < numClusters; c += 1) {
    tasks.push(...makeCluster(CATEGORIES[c], c));
  }
  return tasks;
}

test('findAuditClusters caps qualifying clusters at MAX_DEBRIEF_ACTIONS', () => {
  // 5 distinct qualifying clusters (5 tasks each) -- more than the cap of 3.
  const blockedTasks = makeBlockedTasks(5);
  const clusters = findAuditClusters(blockedTasks, {});
  const items = Array.isArray(clusters) ? clusters : clusters.items;
  assert.ok(Array.isArray(items), 'findAuditClusters must return an array of clusters');
  assert.ok(
    items.length <= MAX_DEBRIEF_ACTIONS,
    `expected <= ${MAX_DEBRIEF_ACTIONS} clusters, got ${items.length}`
  );
  // Sanity: every returned cluster is genuinely one of our 5 distinct signatures.
  for (const cluster of items) {
    assert.ok(cluster.signature.startsWith(`${SOURCE}::`), `unexpected signature: ${cluster.signature}`);
    assert.ok(cluster.tasks.length >= 5, `cluster should have >= 5 tasks, got ${cluster.tasks.length}`);
  }
});

test('findAuditClusters does not over-truncate below the cap', () => {
  // Only 2 distinct qualifying clusters -- both must survive, untruncated.
  const blockedTasks = makeBlockedTasks(2);
  const clusters = findAuditClusters(blockedTasks, {});
  const items = Array.isArray(clusters) ? clusters : clusters.items;
  assert.strictEqual(items.length, 2, `expected exactly 2 clusters, got ${items.length}`);
  const signatures = items.map((c) => c.signature).sort();
  assert.deepStrictEqual(
    signatures,
    [`${SOURCE}::fabricated-ungrounded-claim`, `${SOURCE}::refusal-no-changes-needed`].sort()
  );
});
