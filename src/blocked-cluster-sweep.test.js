'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  normalizeBlockedReason, findBlockedClusters, runBlockedClusterSweep, shouldReport,
} = require('./blocked-cluster-sweep.js');

function makePipeline() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blocked-cluster-sweep-test-'));
  fs.mkdirSync(path.join(dir, 'queue', 'blocked'), { recursive: true });
  return dir;
}

function writeBlocked(dir, id, blockedReason, extra = {}) {
  fs.writeFileSync(path.join(dir, 'queue', 'blocked', `${id}.json`), JSON.stringify({ id, blockedReason, ...extra }, null, 2));
}

function inboxFiles(dir) {
  const inbox = path.join(dir, 'queue', 'side-findings-inbox');
  if (!fs.existsSync(inbox)) return [];
  return fs.readdirSync(inbox).map((f) => JSON.parse(fs.readFileSync(path.join(inbox, f), 'utf8')));
}

// --- normalizeBlockedReason (the fingerprint) -------------------------------------------

test('normalizeBlockedReason collapses two real messages that differ only in the variable parts to the same fingerprint', () => {
  // Real shape from this session's own AVAILABLE-FILES cluster.
  const a = 'NOW WHAT items 1 and 2 omit the required "Files" citation for `src/foo.js` and cite 25 tasks';
  const b = 'NOW WHAT items 1 and 2 omit the required "Files" citation for `src/bar.js` and cite 13 tasks';
  assert.equal(normalizeBlockedReason(a), normalizeBlockedReason(b));
});

test('normalizeBlockedReason returns null for an empty/missing reason', () => {
  assert.equal(normalizeBlockedReason(''), null);
  assert.equal(normalizeBlockedReason(null), null);
  assert.equal(normalizeBlockedReason(undefined), null);
});

test('normalizeBlockedReason does NOT collapse two genuinely different messages', () => {
  const a = 'Agentic implement pass produced a diff that is not a real implementation';
  const b = 'Plan pass degenerate: truncated';
  assert.notEqual(normalizeBlockedReason(a), normalizeBlockedReason(b));
});

// --- findBlockedClusters -----------------------------------------------------------------

test('findBlockedClusters groups real near-identical reasons into one cluster, ignores singletons', () => {
  const dir = makePipeline();
  writeBlocked(dir, 't1', 'NOW WHAT omits `Files` for 25 tasks', { source: 'pipeline_debrief' });
  writeBlocked(dir, 't2', 'NOW WHAT omits `Files` for 13 tasks', { source: 'pipeline_debrief' });
  writeBlocked(dir, 't3', 'NOW WHAT omits `Files` for 9 tasks', { source: 'pipeline_debrief' });
  writeBlocked(dir, 't4', 'A completely unrelated one-off reason', { source: 'manual' });

  const clusters = findBlockedClusters(dir, { minClusterSize: 3 });
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].count, 3);
  assert.deepEqual(clusters[0].taskIds.sort(), ['t1', 't2', 't3']);
  assert.deepEqual(clusters[0].sources, ['pipeline_debrief']);
});

test('findBlockedClusters returns [] below minClusterSize', () => {
  const dir = makePipeline();
  writeBlocked(dir, 't1', 'Same reason `x.js`');
  writeBlocked(dir, 't2', 'Same reason `y.js`');
  assert.deepEqual(findBlockedClusters(dir, { minClusterSize: 3 }), []);
});

test('findBlockedClusters sorts largest cluster first', () => {
  const dir = makePipeline();
  writeBlocked(dir, 'a1', 'Small cluster reason A `x.js`');
  writeBlocked(dir, 'a2', 'Small cluster reason A `y.js`');
  writeBlocked(dir, 'a3', 'Small cluster reason A `z.js`');
  writeBlocked(dir, 'b1', 'Big cluster reason B `x.js`');
  writeBlocked(dir, 'b2', 'Big cluster reason B `y.js`');
  writeBlocked(dir, 'b3', 'Big cluster reason B `z.js`');
  writeBlocked(dir, 'b4', 'Big cluster reason B `w.js`');

  const clusters = findBlockedClusters(dir, { minClusterSize: 3 });
  assert.equal(clusters.length, 2);
  assert.equal(clusters[0].count, 4);
  assert.equal(clusters[1].count, 3);
});

test('findBlockedClusters never throws on a malformed task file or a missing blocked/ dir', () => {
  const dir = makePipeline();
  fs.writeFileSync(path.join(dir, 'queue', 'blocked', 'bad.json'), '{not json');
  assert.doesNotThrow(() => findBlockedClusters(dir));
  assert.deepEqual(findBlockedClusters(fs.mkdtempSync(path.join(os.tmpdir(), 'no-blocked-dir-'))), []);
});

// --- shouldReport (avoid re-filing the identical finding every tick forever) -------------

test('shouldReport is true for a cluster never reported before', () => {
  assert.equal(shouldReport({ count: 3 }, undefined), true);
});

test('shouldReport is false when the cluster has not grown meaningfully since last report', () => {
  assert.equal(shouldReport({ count: 3 }, { lastReportedSize: 3 }), false);
  assert.equal(shouldReport({ count: 4 }, { lastReportedSize: 3 }), false);
});

test('shouldReport is true once a cluster doubles, or grows by +5, since it was last reported', () => {
  assert.equal(shouldReport({ count: 6 }, { lastReportedSize: 3 }), true); // doubled
  assert.equal(shouldReport({ count: 15 }, { lastReportedSize: 10 }), true); // +5 absolute
  assert.equal(shouldReport({ count: 14 }, { lastReportedSize: 10 }), false); // neither yet
});

// --- runBlockedClusterSweep (the full CLI-callable sweep) --------------------------------

test('runBlockedClusterSweep files exactly one side-finding for a real new cluster', () => {
  const dir = makePipeline();
  writeBlocked(dir, 't1', 'Same reason `x.js`', { source: 'pipeline_debrief' });
  writeBlocked(dir, 't2', 'Same reason `y.js`', { source: 'pipeline_debrief' });
  writeBlocked(dir, 't3', 'Same reason `z.js`', { source: 'pipeline_debrief' });

  const result = runBlockedClusterSweep({ pipelineDir: dir, minClusterSize: 3 });

  assert.equal(result.clustersFound, 1);
  assert.equal(result.newlyReported.length, 1);
  assert.equal(result.newlyReported[0].count, 3);
  const findings = inboxFiles(dir);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].source, 'blocked-cluster-sweep');
  assert.match(findings[0].title, /3 tasks share a fingerprint/);
  assert.match(findings[0].body, /t1|t2|t3/);
});

test('runBlockedClusterSweep does NOT re-file the same cluster on a second tick when it has not grown', () => {
  const dir = makePipeline();
  writeBlocked(dir, 't1', 'Same reason `x.js`');
  writeBlocked(dir, 't2', 'Same reason `y.js`');
  writeBlocked(dir, 't3', 'Same reason `z.js`');

  runBlockedClusterSweep({ pipelineDir: dir, minClusterSize: 3 });
  const secondResult = runBlockedClusterSweep({ pipelineDir: dir, minClusterSize: 3 });

  assert.equal(secondResult.newlyReported.length, 0, 'an unchanged cluster must not be re-filed every tick');
  assert.equal(inboxFiles(dir).length, 1, 'still only the one finding from the first tick');
});

test('runBlockedClusterSweep DOES re-file when a previously-reported cluster grows meaningfully', () => {
  const dir = makePipeline();
  writeBlocked(dir, 't1', 'Same reason `1.js`');
  writeBlocked(dir, 't2', 'Same reason `2.js`');
  writeBlocked(dir, 't3', 'Same reason `3.js`');
  runBlockedClusterSweep({ pipelineDir: dir, minClusterSize: 3 });

  // Grows well past double -- this session's own real truncation cluster went ~9 -> 21.
  for (let i = 4; i <= 9; i++) writeBlocked(dir, `t${i}`, `Same reason \`${i}.js\``);
  const result = runBlockedClusterSweep({ pipelineDir: dir, minClusterSize: 3 });

  assert.equal(result.newlyReported.length, 1);
  assert.equal(result.newlyReported[0].count, 9);
  assert.equal(inboxFiles(dir).length, 2, 'the grown cluster gets a fresh finding, the first one is untouched');
});

test('runBlockedClusterSweep persists state across separate process-like calls (not just in-memory)', () => {
  const dir = makePipeline();
  writeBlocked(dir, 't1', 'Same reason `1.js`');
  writeBlocked(dir, 't2', 'Same reason `2.js`');
  writeBlocked(dir, 't3', 'Same reason `3.js`');
  runBlockedClusterSweep({ pipelineDir: dir, minClusterSize: 3 });

  assert.ok(fs.existsSync(path.join(dir, 'queue', 'blocked-cluster-sweep-state.json')), 'state must survive on disk, not just in the calling process\'s memory');
});
