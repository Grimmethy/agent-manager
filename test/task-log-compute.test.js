'use strict';

// HUB0280-04: the committed-at-apply per-task log carries a `compute` rollup only when one is given; without it the record is unchanged.
// Temp directories only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildTaskLogRecord, writeTaskLogFile } = require('../src/task-log-store.js');
const { taskCompute } = require('../src/task-compute.js');

const task = { id: 'tl-compute-1', title: 'T', domain: 'adhoc', source: 'manual', createdAt: '0', history: [{ stage: 'created', at: '0' }], blockedReason: 'x' };
const compute = taskCompute([{ stage: 'plan', model: 'm', latency_ms: 1000, prompt_eval_count: 50, eval_count: 5 }]);

test('a record built with a compute rollup carries it as `compute`', () => {
  const rec = buildTaskLogRecord(task, { compute });
  assert.deepEqual(rec.compute, compute);
  assert.equal(rec.compute.calls, 1);
});

test('a record built without compute equals the old record (no `compute` key)', () => {
  const old = buildTaskLogRecord(task);
  assert.equal('compute' in old, false);
  assert.deepEqual(buildTaskLogRecord(task, {}), old);
  assert.deepEqual(buildTaskLogRecord(task, { compute: null }), old);
  const { compute: _ignored, ...withoutCompute } = buildTaskLogRecord(task, { compute });
  assert.deepEqual(withoutCompute, old);
});

test('writeTaskLogFile writes the compute into the JSON file, and omits it when none is given', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-compute-'));
  const rel = writeTaskLogFile(repo, task, { compute });
  const withIt = JSON.parse(fs.readFileSync(path.join(repo, rel), 'utf8'));
  assert.equal(withIt.compute.promptTokens, 50);
  writeTaskLogFile(repo, task);
  const without = JSON.parse(fs.readFileSync(path.join(repo, rel), 'utf8'));
  assert.equal('compute' in without, false);
  assert.deepEqual(without, JSON.parse(JSON.stringify(buildTaskLogRecord(task))));
});

test('taskComputeForLog gives a rollup only when the task has recorded calls, and null for no database, no pipelineDir or no rows', () => {
  const { DatabaseSync } = require('node:sqlite');
  const { taskComputeForLog } = require('../src/task-log-store.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-compute-db-'));
  assert.equal(taskComputeForLog(dir, 'T1'), null, 'no database');
  assert.equal(taskComputeForLog(null, 'T1'), null, 'no pipelineDir');
  const db = new DatabaseSync(path.join(dir, 'model-stats.db'));
  db.exec('CREATE TABLE model_calls (call_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, stage TEXT, model TEXT, started_at TEXT, latency_ms INTEGER, prompt_eval_count INTEGER, eval_count INTEGER)');
  db.prepare('INSERT INTO model_calls VALUES (?,?,?,?,?,?,?,?)').run('c1', 'T1', 'plan', 'm', 'x', 10, 5, 2);
  db.close();
  assert.equal(taskComputeForLog(dir, 'T1').calls, 1);
  assert.equal(taskComputeForLog(dir, 'T2'), null, 'a task with no rows');
});
