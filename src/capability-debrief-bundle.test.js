'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const B = require('./capability-debrief-bundle.js');
const { logPipelineEvent } = require('./pipeline-history.js');

const SMALL = 'qwen3-vl:8b-instruct';
const BIG = 'qwen3.8:27b';
const entry = (taskId, outcome, extra = {}) => ({ at: new Date().toISOString(), taskId, source: 'change_review', lane: 'worker-rx580', model: SMALL, tier: 8, numCtx: 16384, outcome, wallMs: 300000, reason: 'Ollama request timed out after 300000ms', ...extra });

test('failureSignature normalises numbers so differently-timed timeouts cluster together', () => {
  assert.equal(B.failureSignature(entry('a', 'timeout')), B.failureSignature(entry('b', 'timeout', { reason: 'Ollama request timed out after 120000ms' })));
  assert.notEqual(B.failureSignature(entry('a', 'timeout')), B.failureSignature(entry('a', 'degenerate', { reason: 'truncated' })));
});

test('collectFailureClusters: only small-tier failures, at least minFailures, grouped by source/model/signature', () => {
  const entries = [
    entry('t1', 'timeout'), entry('t2', 'timeout'), entry('t3', 'timeout'), entry('t4', 'ok'),
    entry('t5', 'timeout', { source: 'staleness_audit' }),
    entry('b1', 'timeout', { model: BIG, tier: 27, lane: 'worker-3090' }), entry('b2', 'timeout', { model: BIG, tier: 27 }), entry('b3', 'timeout', { model: BIG, tier: 27 }),
  ];
  const clusters = B.collectFailureClusters(entries, { minFailures: 3 });
  assert.equal(clusters.length, 1, 'the top tier never forms a cluster, and a single staleness failure is below the threshold');
  assert.equal(clusters[0].source, 'change_review');
  assert.equal(clusters[0].failures, 3);
  assert.deepEqual(clusters[0].taskIds, ['t1', 't2', 't3']);
  assert.equal(B.collectFailureClusters(entries, { minFailures: 4 }).length, 0);
  assert.equal(B.collectFailureClusters([entry('t1', 'timeout'), entry('t2', 'timeout'), entry('t3', 'timeout')]).length, 0, 'no larger tier in the ledger = nothing to compare against');
});

test('pendingClusters / markDebriefed / resetCluster: one debrief per cluster until a fix lands', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-debrief-state-'));
  const clusters = B.collectFailureClusters([entry('t1', 'timeout'), entry('t2', 'timeout'), entry('t3', 'timeout'), entry('b', 'ok', { model: BIG, tier: 27 })]);
  assert.equal(B.pendingClusters(clusters, dir).length, 1);
  B.markDebriefed(dir, clusters[0], { note: 'x' });
  assert.equal(B.pendingClusters(clusters, dir).length, 0);
  B.resetCluster(dir, clusters[0]);
  assert.equal(B.pendingClusters(clusters, dir).length, 1);
});

test('buildCapabilityDebriefBundle: framing, scorecard, ledger failures, paired outcome and a contrast success', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-debrief-'));
  const done = path.join(dir, 'queue', 'done');
  fs.mkdirSync(done, { recursive: true });
  const t0 = new Date(Date.now() - 400000).toISOString();
  const t1 = new Date(Date.now() - 100000).toISOString();
  const failed = (id) => ({
    id, source: 'change_review', title: `review ${id}`, history: [{ stage: 'draft-attempt', detail: 'attempt 1: error' }],
    draftAttempts: [
      { attemptNo: 1, lane: 'worker-rx580', outcome: 'error', reason: 'Ollama request timed out after 300000ms', at: t0, finishedAt: t1, tiers: [] },
      { attemptNo: 2, lane: 'worker-3090', outcome: 'succeeded', at: t1, finishedAt: new Date().toISOString(), tiers: [] },
    ],
  });
  for (const id of ['t1', 't2', 't3']) fs.writeFileSync(path.join(done, `${id}.json`), JSON.stringify(failed(id)));
  fs.writeFileSync(path.join(done, 'ok1.json'), JSON.stringify({ id: 'ok1', source: 'change_review', title: 'fine', history: [], draftAttempts: [] }));
  const entries = [entry('t1', 'timeout'), entry('t2', 'timeout'), entry('t3', 'timeout'), entry('ok1', 'ok', { wallMs: 40000 }), entry('big1', 'ok', { model: BIG, tier: 27, lane: 'worker-3090', wallMs: 90000 })];
  const [cluster] = B.collectFailureClusters(entries);
  const bundle = B.buildCapabilityDebriefBundle({ pipelineDir: dir, dbPath: path.join(dir, 'none.db'), cluster, entries });
  assert.match(bundle.evidenceText, /CAPABILITY DEBRIEF BUNDLE/);
  assert.match(bundle.evidenceText, /SCORECARD for change_review/);
  assert.match(bundle.evidenceText, /numCtx=16384 outcome=timeout/);
  assert.match(bundle.evidenceText, /PAIRED OUTCOMES/);
  assert.match(bundle.evidenceText, /attempt 2 on worker-3090 → succeeded/);
  assert.match(bundle.evidenceText, /SUCCEEDED ON qwen3-vl:8b-instruct 1: ok1/);
  assert.deepEqual(bundle.subjectIds, ['t1', 't2', 't3']);
  assert.deepEqual(bundle.contrastIds, ['ok1']);
  assert.ok(bundle.stats.chars > 500);
});

test('buildCapabilityDebriefBundle tolerates missing task records and a missing stats db', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-debrief-empty-'));
  const entries = [entry('x1', 'timeout'), entry('x2', 'timeout'), entry('x3', 'timeout'), entry('b', 'ok', { model: BIG, tier: 27 })];
  const [cluster] = B.collectFailureClusters(entries);
  const bundle = B.buildCapabilityDebriefBundle({ pipelineDir: dir, dbPath: path.join(dir, 'nope.db'), cluster, entries });
  assert.deepEqual(bundle.subjectIds, []);
  assert.match(bundle.evidenceText, /FAILED ATTEMPTS ON THE SMALL LANE/);
});

test('readLedgerEntries reads back what the ledger wrote', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-debrief-read-'));
  logPipelineEvent(dir, 'attempt', { source: 's', model: 'm:8b', outcome: 'ok' });
  logPipelineEvent(dir, 'degenerate', { x: 1 });
  assert.equal(B.readLedgerEntries(dir).length, 1);
});

test('a cluster on a lane the health probe flagged is a hardware suspect: marked, kept out of pendingClusters, and warned in the bundle', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-debrief-suspect-'));
  const entries = [entry('t1', 'timeout'), entry('t2', 'timeout'), entry('t3', 'timeout'), entry('b', 'ok', { model: BIG, tier: 27 })];
  const [cluster] = B.collectFailureClusters(entries, { isDegraded: (lane) => lane === 'worker-rx580' });
  assert.equal(cluster.suspect, true);
  assert.equal(B.pendingClusters([cluster], dir).length, 0);
  assert.match(B.buildCapabilityDebriefBundle({ pipelineDir: dir, dbPath: path.join(dir, 'x.db'), cluster, entries }).evidenceText, /flagged this lane as degraded/);
  const [healthy] = B.collectFailureClusters(entries, { isDegraded: () => false });
  assert.equal(healthy.suspect, false);
});

test('capabilityDebrief prompts carry the evidence, the closed file list, the four cause classes and the NOT SHRINKABLE escape', () => {
  const P = require('./prompts.js');
  const task = { promptContext: { evidenceText: 'EVIDENCE-BLOB', clusterSource: 'change_review', taskIds: ['t1'], contrastIds: ['ok1'], harnessHits: [{ file: 'src/prompts.js', line: 10, query: 'changeReview', text: 'x' }], harnessFiles: [{ path: 'src/prompts.js', content: 'code' }] } };
  const plan = P.capabilityDebriefPlanPrompt(task);
  assert.match(plan, /EVIDENCE-BLOB/);
  assert.match(plan, /change_review/);
  assert.match(plan, /QUERY:/);
  const impl = P.capabilityDebriefImplementPrompt(task, 'QUERY: changeReview');
  for (const needle of ['EVIDENCE-BLOB', 'PROMPT/CONTEXT TOO LARGE', 'SEVERAL JOBS IN ONE CALL', 'MECHANICALLY DECIDABLE', 'NEEDS REASONING DEPTH', 'NOT SHRINKABLE AT THIS TIER', 'AVAILABLE FILES', '- src/prompts.js', 'NOW WHAT']) {
    assert.ok(impl.includes(needle), `implement prompt should include ${needle}`);
  }
});
