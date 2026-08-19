'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  classifyTask, scanTaskActivity, computeDowntime, computeTimeAccounting,
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
