'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  hasZeroHitHarnessSearch, categorizeBlockedReason, signatureForTask,
  findAuditClusters, buildAuditRawText, buildAuditTask, CLUSTER_THRESHOLD,
} = require('./pipeline-self-audit.js');

function makeBlocked(id, source, blockedReason, history = []) {
  return { id, source, blockedReason, history };
}

test('hasZeroHitHarnessSearch detects the exact "0 hit(s), 0 file(s)" harness-search signature', () => {
  const task = makeBlocked('t1', 'arch_import', 'no grounding', [
    { stage: 'harness-search', detail: '3 quer(y/ies), 0 hit(s), 0 file(s)' },
  ]);
  assert.equal(hasZeroHitHarnessSearch(task), true);
});

test('hasZeroHitHarnessSearch is false when the harness search found something', () => {
  const task = makeBlocked('t1', 'arch_import', 'no grounding', [
    { stage: 'harness-search', detail: '3 quer(y/ies), 2 hit(s), 1 file(s)' },
  ]);
  assert.equal(hasZeroHitHarnessSearch(task), false);
});

test('categorizeBlockedReason matches known failure keywords', () => {
  assert.equal(categorizeBlockedReason('The draft fabricates a repo that does not exist'), 'fabricated-ungrounded-claim');
  assert.equal(categorizeBlockedReason('resolution=no-changes-needed, a clear refusal'), 'refusal-no-changes-needed');
  assert.equal(categorizeBlockedReason('the draft contains no implementation'), 'empty-degenerate-draft');
  assert.equal(categorizeBlockedReason('Ornith review inconclusive, no confident majority'), 'inconclusive-review');
  assert.equal(categorizeBlockedReason('some genuinely unique one-off problem'), null);
});

test('signatureForTask prefers the harness-search signal over blockedReason categorization', () => {
  const task = makeBlocked('t1', 'arch_import', 'the draft is empty', [
    { stage: 'harness-search', detail: '2 quer(y/ies), 0 hit(s), 0 file(s)' },
  ]);
  assert.equal(signatureForTask(task), 'arch_import::harness-search-zero-results');
});

test('signatureForTask returns null for an uncategorizable task rather than guessing', () => {
  const task = makeBlocked('t1', 'manual', 'a genuinely one-off unclear situation');
  assert.equal(signatureForTask(task), null);
});

test('findAuditClusters only returns clusters at or above CLUSTER_THRESHOLD', () => {
  const tasks = Array.from({ length: CLUSTER_THRESHOLD - 1 }, (_, i) =>
    makeBlocked(`t${i}`, 'arch_import', 'refuses to implement, no code'));
  assert.deepEqual(findAuditClusters(tasks), []);
});

test('findAuditClusters returns a cluster once it reaches CLUSTER_THRESHOLD', () => {
  const tasks = Array.from({ length: CLUSTER_THRESHOLD }, (_, i) =>
    makeBlocked(`t${i}`, 'arch_import', 'refuses to implement, no code'));
  const clusters = findAuditClusters(tasks);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].signature, 'arch_import::refusal-no-changes-needed');
  assert.equal(clusters[0].tasks.length, CLUSTER_THRESHOLD);
});

test('findAuditClusters skips a signature already present in coverage', () => {
  const tasks = Array.from({ length: CLUSTER_THRESHOLD }, (_, i) =>
    makeBlocked(`t${i}`, 'arch_import', 'refuses to implement, no code'));
  const coverage = { 'arch_import::refusal-no-changes-needed': { reportedAt: '2026-08-19T00:00:00.000Z' } };
  assert.deepEqual(findAuditClusters(tasks, coverage), []);
});

test('findAuditClusters returns the largest cluster first', () => {
  const small = Array.from({ length: CLUSTER_THRESHOLD }, (_, i) => makeBlocked(`s${i}`, 'deep_dive', 'no code'));
  const big = Array.from({ length: CLUSTER_THRESHOLD + 3 }, (_, i) => makeBlocked(`b${i}`, 'arch_import', 'refuses to implement'));
  const clusters = findAuditClusters([...small, ...big]);
  assert.equal(clusters[0].signature, 'arch_import::refusal-no-changes-needed');
  assert.equal(clusters[1].signature, 'deep_dive::empty-degenerate-draft');
});

test('buildAuditRawText includes example task ids/reasons', () => {
  const tasks = Array.from({ length: 7 }, (_, i) => makeBlocked(`arch-import-x-${i}`, 'arch_import', `blocked reason ${i}`));
  const text = buildAuditRawText({ signature: 'arch_import::empty-degenerate-draft', tasks });
  assert.match(text, /7 tasks/);
  assert.match(text, /arch-import-x-0/);
  assert.match(text, /and 2 more/);
});

// 2026-08-20: moved off domain:'adhoc' (Claude-only) onto domain:defaultDomain (the local
// Ornith model, via the same harness-grounded flow arch_import already uses) -- see
// pipeline-self-audit.js's own header for why.
test('buildAuditTask produces a task on the given domain with the evidence embedded', () => {
  const tasks = Array.from({ length: CLUSTER_THRESHOLD }, (_, i) => makeBlocked(`t${i}`, 'project_search', 'fabricated URL'));
  const task = buildAuditTask({ signature: 'project_search::fabricated-ungrounded-claim', tasks }, 'default');
  assert.equal(task.domain, 'default');
  assert.equal(task.source, 'pipeline_self_audit');
  assert.match(task.title, /project_search/);
  assert.ok(task.promptContext.evidenceText.length > 0);
  assert.equal(task.promptContext.signature, 'project_search::fabricated-ungrounded-claim');
  assert.equal(task.promptContext.taskCount, CLUSTER_THRESHOLD);
});
