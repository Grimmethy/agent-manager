'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  classifyTask, scanTaskActivity, computeDowntime, computeTimeAccounting,
  computeQueueHealth, computeSelfAuditActivity, computeBlockedPatterns, buildPlainEnglishSummary,
  renderMarkdown, generateReport, checkDue, loadSchedule,
} = require('./system-report.js');
const { appendSample } = require('./uptime-log.js');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'system-report-test-'));
}

function writeTask(dir, id, task) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, ...task }));
}

test('classifyTask: blocked/archived tasks are always junk regardless of source', () => {
  assert.equal(classifyTask({ source: 'manual' }, 'blocked'), 'junk');
  assert.equal(classifyTask({ source: 'arch_import' }, 'archived'), 'junk');
});

test('classifyTask: observability/performance review verdicts split into filtering vs benefit', () => {
  assert.equal(classifyTask({ source: 'observability_review', implementResponse: 'This is a false positive, no action needed.' }, 'done'), 'filtering');
  assert.equal(classifyTask({ source: 'performance_review', implementResponse: 'Confirmed genuine issue, fixed.' }, 'done'), 'benefit');
  assert.equal(classifyTask({ source: 'observability_review', implementResponse: 'unrelated text' }, 'done'), 'unclear');
});

test('classifyTask: manual/adhoc and arch_import/discovery/deep_dive/project_search are benefit', () => {
  assert.equal(classifyTask({ source: 'manual', domain: 'adhoc' }, 'done'), 'benefit');
  assert.equal(classifyTask({ source: 'arch_discovery' }, 'done'), 'benefit');
  assert.equal(classifyTask({ source: 'deep_dive' }, 'done'), 'benefit');
});

test('classifyTask: brain_dump_sort/path_prefetch_resolve are housekeeping', () => {
  assert.equal(classifyTask({ source: 'brain_dump_sort' }, 'done'), 'housekeeping');
  assert.equal(classifyTask({ source: 'path_prefetch_resolve' }, 'done'), 'housekeeping');
});

test('scanTaskActivity: only includes tasks whose terminal history timestamp falls in the window', () => {
  const dir = tempDir();
  const queueDir = path.join(dir, 'queue');
  writeTask(path.join(queueDir, 'done'), 'in-window', { source: 'manual', history: [{ at: '2026-08-19T10:30:00.000Z' }] });
  writeTask(path.join(queueDir, 'done'), 'before-window', { source: 'manual', history: [{ at: '2026-08-19T08:00:00.000Z' }] });
  writeTask(path.join(queueDir, 'blocked'), 'blocked-in-window', { source: 'observability_review', history: [{ at: '2026-08-19T10:45:00.000Z' }] });
  writeTask(path.join(queueDir, 'done', '_archived_no_action'), 'archived-in-window', { source: 'performance_review', createdAt: '2026-08-19T10:15:00.000Z' });

  const tasks = scanTaskActivity(dir, '2026-08-19T10:00:00.000Z', '2026-08-19T11:00:00.000Z');
  const ids = tasks.map((t) => t.id).sort();
  assert.deepEqual(ids, ['archived-in-window', 'blocked-in-window', 'in-window']);
  assert.equal(tasks.find((t) => t.id === 'blocked-in-window').classification, 'junk');
  assert.equal(tasks.find((t) => t.id === 'archived-in-window').classification, 'junk');
  assert.equal(tasks.find((t) => t.id === 'in-window').classification, 'benefit');
});

test('scanTaskActivity: malformed task JSON is skipped, not fatal', () => {
  const dir = tempDir();
  const doneDir = path.join(dir, 'queue', 'done');
  fs.mkdirSync(doneDir, { recursive: true });
  fs.writeFileSync(path.join(doneDir, 'bad.json'), '{not valid json');
  assert.doesNotThrow(() => scanTaskActivity(dir, '2026-08-19T00:00:00.000Z', '2026-08-20T00:00:00.000Z'));
});

test('computeDowntime: a gap wider than the threshold is reported as pipeline-down', () => {
  const dir = tempDir();
  appendSample(dir, new Date('2026-08-19T10:00:00.000Z'));
  appendSample(dir, new Date('2026-08-19T10:30:00.000Z')); // 30 min gap, well over threshold
  appendSample(dir, new Date('2026-08-19T10:31:00.000Z')); // resumes normal cadence
  const result = computeDowntime(dir, '2026-08-19T10:00:00.000Z', '2026-08-19T10:35:00.000Z');
  assert.ok(result.pipelineDownSec > 0);
  assert.equal(result.pipelineDownIntervals.length, 1);
});

test('computeDowntime: normal tick cadence reports zero pipeline downtime', () => {
  const dir = tempDir();
  appendSample(dir, new Date('2026-08-19T10:00:00.000Z'));
  appendSample(dir, new Date('2026-08-19T10:01:00.000Z'));
  appendSample(dir, new Date('2026-08-19T10:02:00.000Z'));
  const result = computeDowntime(dir, '2026-08-19T10:00:00.000Z', '2026-08-19T10:03:00.000Z');
  assert.equal(result.pipelineDownSec, 0);
});

test('computeDowntime: no samples at all reports the whole window as down', () => {
  const dir = tempDir();
  const result = computeDowntime(dir, '2026-08-19T10:00:00.000Z', '2026-08-19T11:00:00.000Z');
  assert.equal(result.pipelineDownSec, 3600);
});

test('computeTimeAccounting: returns null when the db file does not exist', () => {
  const dir = tempDir();
  const result = computeTimeAccounting(path.join(dir, 'nope.db'), [], '2026-08-19T00:00:00.000Z', '2026-08-20T00:00:00.000Z');
  assert.equal(result, null);
});

test('computeTimeAccounting: sums latency_ms per classification bucket, unmatched calls go to in-progress', () => {
  const { DatabaseSync } = require('node:sqlite');
  const dir = tempDir();
  const dbPath = path.join(dir, 'model-stats.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE model_calls (call_id TEXT, task_id TEXT, started_at TEXT, latency_ms INTEGER)');
  db.prepare('INSERT INTO model_calls (call_id, task_id, started_at, latency_ms) VALUES (?, ?, ?, ?)').run('c1', 'task-a', '2026-08-19T10:10:00.000Z', 5000);
  db.prepare('INSERT INTO model_calls (call_id, task_id, started_at, latency_ms) VALUES (?, ?, ?, ?)').run('c2', 'task-unmatched', '2026-08-19T10:20:00.000Z', 3000);
  db.close();

  const tasks = [{ id: 'task-a', classification: 'benefit' }];
  const result = computeTimeAccounting(dbPath, tasks, '2026-08-19T10:00:00.000Z', '2026-08-19T11:00:00.000Z');
  assert.equal(result.bucketSec.benefit, 5);
  assert.equal(result.bucketSec['in-progress'], 3);
});

test('renderMarkdown: includes all major sections', () => {
  const md = renderMarkdown({
    period: 'hourly',
    startIso: '2026-08-19T10:00:00.000Z',
    endIso: '2026-08-19T11:00:00.000Z',
    tasks: [{ id: 't1', source: 'manual', classification: 'benefit' }],
    downtime: { pipelineDownSec: 0, pipelineDownIntervals: [], perInstanceDownSec: {} },
    timeAccounting: null,
  });
  assert.match(md, /# Hourly Report/);
  assert.match(md, /## By Source/);
  assert.match(md, /## Junk vs\. Benefit \(by task count\)/);
  assert.match(md, /## Downtime/);
  assert.match(md, /## Methodology & Limitations/);
});

test('generateReport: writes a markdown file under secondBrainDir/Agent Manager Reports/<period>/', () => {
  const dir = tempDir();
  writeTask(path.join(dir, 'queue', 'done'), 'task-a', { source: 'manual', history: [{ at: '2026-08-19T10:30:00.000Z' }] });
  const secondBrainDir = tempDir();

  const result = generateReport({
    period: 'hourly', startIso: '2026-08-19T10:00:00.000Z', endIso: '2026-08-19T11:00:00.000Z',
    pipelineDir: dir, instancesDir: path.join(dir, 'instances'), dbPath: path.join(dir, 'model-stats.db'), secondBrainDir,
  });

  assert.ok(fs.existsSync(result.filePath));
  assert.match(result.filePath, /Agent Manager Reports[\\/]hourly[\\/]/);
  assert.equal(result.taskCount, 1);
});

test('checkDue: bootstraps schedule on first run without generating any report', () => {
  const dir = tempDir();
  const instancesDir = path.join(dir, 'instances');
  fs.mkdirSync(instancesDir, { recursive: true });
  const secondBrainDir = tempDir();

  const generated = checkDue({ pipelineDir: dir, instancesDir, dbPath: path.join(dir, 'model-stats.db'), secondBrainDir, now: new Date('2026-08-19T10:00:00.000Z') });
  assert.deepEqual(generated, []);
  const schedule = loadSchedule(instancesDir);
  assert.equal(schedule.hourly.lastGeneratedAt, '2026-08-19T10:00:00.000Z');
  assert.equal(schedule.daily.lastGeneratedAt, '2026-08-19T10:00:00.000Z');
  assert.equal(schedule.weekly.lastGeneratedAt, '2026-08-19T10:00:00.000Z');
});

test('checkDue: generates only the periods whose interval has elapsed since last run', () => {
  const dir = tempDir();
  const instancesDir = path.join(dir, 'instances');
  fs.mkdirSync(instancesDir, { recursive: true });
  const secondBrainDir = tempDir();

  checkDue({ pipelineDir: dir, instancesDir, dbPath: path.join(dir, 'model-stats.db'), secondBrainDir, now: new Date('2026-08-19T10:00:00.000Z') });

  const oneHourLater = new Date('2026-08-19T11:05:00.000Z');
  const generated = checkDue({ pipelineDir: dir, instancesDir, dbPath: path.join(dir, 'model-stats.db'), secondBrainDir, now: oneHourLater });

  assert.equal(generated.length, 1);
  assert.equal(generated[0].period, 'hourly');
  const schedule = loadSchedule(instancesDir);
  assert.equal(schedule.hourly.lastGeneratedAt, oneHourLater.toISOString());
  assert.equal(schedule.daily.lastGeneratedAt, '2026-08-19T10:00:00.000Z'); // untouched
});

// Queue Health / Self-Audit Activity / Failure Patterns (2026-08-20, Grimmethy: "We need
// to build this sort of analysis into the daily report" -- after a manual investigation
// found a multi-day review-runner stall the report's own task-count numbers had no way to
// show, since nothing had reached a terminal state to be counted).

test('computeQueueHealth counts every live queue state, including nested drafting/<instance>/', () => {
  const dir = tempDir();
  writeTask(path.join(dir, 'queue', 'pending'), 'p1', {});
  writeTask(path.join(dir, 'queue', 'review'), 'r1', {});
  writeTask(path.join(dir, 'queue', 'review'), 'r2', {});
  writeTask(path.join(dir, 'queue', 'drafting', 'worker-1'), 'd1', {});
  writeTask(path.join(dir, 'queue', 'blocked'), 'b1', {});

  const health = computeQueueHealth(dir, new Date('2026-08-20T12:00:00.000Z'));
  assert.equal(health.counts.pending, 1);
  assert.equal(health.counts.review, 2);
  assert.equal(health.counts.drafting, 1);
  assert.equal(health.counts.blocked, 1);
  assert.equal(health.counts.approved, 0);
});

test('computeQueueHealth reports the oldest review/pending item age in seconds', () => {
  const dir = tempDir();
  const reviewDir = path.join(dir, 'queue', 'review');
  fs.mkdirSync(reviewDir, { recursive: true });
  fs.writeFileSync(path.join(reviewDir, 'old.json'), '{}');
  const oldTime = new Date('2026-08-17T00:00:00.000Z');
  fs.utimesSync(path.join(reviewDir, 'old.json'), oldTime, oldTime);

  const health = computeQueueHealth(dir, new Date('2026-08-20T00:00:00.000Z'));
  assert.equal(health.oldestReviewAgeSec, 3 * 24 * 60 * 60);
  assert.equal(health.oldestPendingAgeSec, null); // no pending/ dir at all
});

test('computeSelfAuditActivity only returns entries whose reportedAt falls in the window', () => {
  const dir = tempDir();
  const coveragePath = path.join(dir, 'self-audit-coverage.json');
  fs.writeFileSync(coveragePath, JSON.stringify({
    'arch_import::harness-search-zero-results': { reportedAt: '2026-08-20T05:00:00.000Z', taskId: 'pipeline-self-audit-1' },
    'project_search::fabricated-ungrounded-claim': { reportedAt: '2026-08-19T05:00:00.000Z', taskId: 'pipeline-self-audit-2' },
  }));

  const activity = computeSelfAuditActivity(coveragePath, '2026-08-20T00:00:00.000Z', '2026-08-21T00:00:00.000Z');
  assert.equal(activity.length, 1);
  assert.equal(activity[0].taskId, 'pipeline-self-audit-1');
});

test('computeSelfAuditActivity on a missing coverage file returns an empty array, not a throw', () => {
  assert.deepEqual(computeSelfAuditActivity('/does/not/exist.json', '2026-08-20T00:00:00.000Z', '2026-08-21T00:00:00.000Z'), []);
});

test('computeBlockedPatterns groups junk tasks by the same signature pipeline-self-audit.js clusters on', () => {
  const tasks = [
    { classification: 'junk', source: 'arch_import', history: [{ stage: 'harness-search', detail: '3 quer(y/ies), 0 hit(s), 0 file(s)' }] },
    { classification: 'junk', source: 'arch_import', history: [{ stage: 'harness-search', detail: '2 quer(y/ies), 0 hit(s), 0 file(s)' }] },
    { classification: 'junk', source: 'manual', blockedReason: 'The draft fabricates a repo that does not exist.' },
    { classification: 'benefit', source: 'manual' }, // not junk -- excluded
  ];
  const result = computeBlockedPatterns(tasks);
  assert.equal(result.totalJunk, 3);
  assert.deepEqual(result.patterns, [
    { signature: 'arch_import::harness-search-zero-results', count: 2 },
    { signature: 'manual::fabricated-ungrounded-claim', count: 1 },
  ]);
  assert.equal(result.uncategorized, 0);
});

test('renderMarkdown includes Queue Health, Failure Patterns, and Self-Audit Activity sections when given the data', () => {
  const md = renderMarkdown({
    period: 'hourly',
    startIso: '2026-08-20T10:00:00.000Z',
    endIso: '2026-08-20T11:00:00.000Z',
    tasks: [{ id: 't1', source: 'arch_import', classification: 'junk', history: [{ stage: 'harness-search', detail: '0 hit(s), 0 file(s)' }] }],
    downtime: { pipelineDownSec: 0, pipelineDownIntervals: [], perInstanceDownSec: {} },
    timeAccounting: null,
    queueHealth: { counts: { pending: 0, drafting: 0, review: 5, approved: 0, 'awaiting-confirm': 0, 'needs-clarification': 0, blocked: 10 }, oldestReviewAgeSec: 4 * 3600, oldestPendingAgeSec: null },
    selfAuditActivity: [{ signature: 'arch_import::harness-search-zero-results', taskId: 'pipeline-self-audit-1', reportedAt: '2026-08-20T10:30:00.000Z' }],
    blockedPatterns: { patterns: [{ signature: 'arch_import::harness-search-zero-results', count: 1 }], uncategorized: 0, totalJunk: 1 },
  });
  assert.match(md, /## Queue Health/);
  assert.match(md, /review: 5/);
  assert.match(md, /unusually old/); // 4h oldest review item should trip the warning
  assert.match(md, /## Failure Patterns/);
  assert.match(md, /arch_import::harness-search-zero-results.*1\/1/);
  assert.match(md, /## Self-Audit Activity/);
  assert.match(md, /pipeline-self-audit-1/);
});

// Plain-English period summary (2026-08-20, Grimmethy: "Every time tracking entry should
// contain a plain english description of the specific benefit and results of that
// period. This includes hourly, daily and weekly reports").

test('buildPlainEnglishSummary names real task titles for benefit tasks, not just a count', () => {
  const summary = buildPlainEnglishSummary({
    period: 'hourly',
    tasks: [
      { classification: 'benefit', title: 'Fix silent-catch-block in budget-monitor.js' },
      { classification: 'filtering' },
      { classification: 'filtering' },
      { classification: 'junk' },
    ],
    byClassification: { benefit: 1, filtering: 2, junk: 1, housekeeping: 0, unclear: 0 },
    blockedPatterns: { patterns: [], uncategorized: 1, totalJunk: 1 },
    downtime: { pipelineDownSec: 0, pipelineDownIntervals: [], perInstanceDownSec: {} },
  });
  assert.match(summary, /This hour, the pipeline completed 4 tasks\./);
  assert.match(summary, /Fix silent-catch-block in budget-monitor\.js/);
  assert.match(summary, /2 scanner alerts were correctly identified as false positives/);
  assert.match(summary, /ran continuously with no detected downtime/);
});

test('buildPlainEnglishSummary calls out a dominant failure pattern by name', () => {
  const summary = buildPlainEnglishSummary({
    period: 'daily',
    tasks: Array.from({ length: 21 }, () => ({ classification: 'junk' })),
    byClassification: { benefit: 0, filtering: 0, junk: 21, housekeeping: 0, unclear: 0 },
    blockedPatterns: { patterns: [{ signature: 'arch_import::harness-search-zero-results', count: 19 }], uncategorized: 2, totalJunk: 21 },
    downtime: { pipelineDownSec: 0, pipelineDownIntervals: [], perInstanceDownSec: {} },
  });
  assert.match(summary, /No task this period shipped a real fix/);
  assert.match(summary, /90% of which shared the same "arch_import::harness-search-zero-results" failure pattern/);
  assert.match(summary, /likely one root cause, not 19 independent problems/);
});

test('buildPlainEnglishSummary reports downtime plainly when it happened', () => {
  const summary = buildPlainEnglishSummary({
    period: 'weekly',
    tasks: [{ classification: 'benefit', title: 'Something shipped' }],
    byClassification: { benefit: 1, filtering: 0, junk: 0, housekeeping: 0, unclear: 0 },
    blockedPatterns: { patterns: [], uncategorized: 0, totalJunk: 0 },
    downtime: { pipelineDownSec: 3600, pipelineDownIntervals: [], perInstanceDownSec: {} },
  });
  assert.match(summary, /was down for 1h during this period/);
});

test('buildPlainEnglishSummary handles a completely empty period honestly, including downtime as a likely cause', () => {
  const summary = buildPlainEnglishSummary({
    period: 'hourly',
    tasks: [],
    byClassification: { benefit: 0, filtering: 0, junk: 0, housekeeping: 0, unclear: 0 },
    blockedPatterns: { patterns: [], uncategorized: 0, totalJunk: 0 },
    downtime: { pipelineDownSec: 1800, pipelineDownIntervals: [], perInstanceDownSec: {} },
  });
  assert.match(summary, /completed no tasks/);
  assert.match(summary, /down for 30m during that stretch/);
});

test('renderMarkdown includes a ## Summary section with the plain-English narrative', () => {
  const md = renderMarkdown({
    period: 'daily',
    startIso: '2026-08-20T00:00:00.000Z',
    endIso: '2026-08-21T00:00:00.000Z',
    tasks: [{ id: 't1', source: 'observability_fix', classification: 'benefit', title: 'Fix silent catch in worker.js' }],
    downtime: { pipelineDownSec: 0, pipelineDownIntervals: [], perInstanceDownSec: {} },
    timeAccounting: null,
  });
  assert.match(md, /## Summary/);
  assert.match(md, /Fix silent catch in worker\.js/);
  // Summary section must come before the By Source breakdown -- the narrative is the
  // headline, not an afterthought at the bottom.
  assert.ok(md.indexOf('## Summary') < md.indexOf('## By Source'));
});
