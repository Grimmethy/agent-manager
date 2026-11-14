'use strict';

// HUB0280-01: src/task-compute.js sums model_calls rows per task and reads model-stats.db read-only. Every db here is a temp file.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { taskCompute, sumCompute, getTaskCompute } = require('../src/task-compute.js');

// getTaskCompute prefers AGENT_MANAGER_MODEL_STATS_DB_PATH over <pipelineDir>/model-stats.db (a dry-run sandbox sets it), so these tests must not inherit it.
let savedStatsPath;
test.before(() => { savedStatsPath = process.env.AGENT_MANAGER_MODEL_STATS_DB_PATH; delete process.env.AGENT_MANAGER_MODEL_STATS_DB_PATH; });
test.after(() => { if (savedStatsPath === undefined) delete process.env.AGENT_MANAGER_MODEL_STATS_DB_PATH; else process.env.AGENT_MANAGER_MODEL_STATS_DB_PATH = savedStatsPath; });

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'task-compute-')); }

const FULL_SCHEMA = `CREATE TABLE model_calls (call_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, stage TEXT, model TEXT, started_at TEXT, latency_ms INTEGER,
  eval_duration_ns INTEGER, prompt_eval_count INTEGER, eval_count INTEGER, cost_usd REAL, gpu_name TEXT)`;
const OLD_SCHEMA = `CREATE TABLE model_calls (call_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, stage TEXT, model TEXT, started_at TEXT, latency_ms INTEGER,
  prompt_eval_count INTEGER, eval_count INTEGER)`;

function makeDb(dir, schema, rows) {
  const file = path.join(dir, 'model-stats.db');
  const db = new DatabaseSync(file);
  db.exec(schema);
  const cols = Object.keys(rows[0] || { call_id: 1 });
  const ins = db.prepare(`INSERT INTO model_calls (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
  for (const r of rows) ins.run(...cols.map((c) => r[c]));
  db.close();
  return file;
}

test('an empty list gives zeros and empty maps', () => {
  assert.deepEqual(taskCompute([]), { calls: 0, promptTokens: 0, evalTokens: 0, modelMs: 0, evalMs: 0, costUsd: 0, byStage: {}, byModel: {}, gpus: [] });
});

test('one row is summed into the totals, its stage and its model', () => {
  const c = taskCompute([{ stage: 'plan', model: 'm1', latency_ms: 1500, prompt_eval_count: 100, eval_count: 40, eval_duration_ns: 2_000_000_000, cost_usd: 0.5, gpu_name: 'RTX 3090' }]);
  assert.equal(c.calls, 1);
  assert.equal(c.promptTokens, 100);
  assert.equal(c.evalTokens, 40);
  assert.equal(c.modelMs, 1500);
  assert.equal(c.evalMs, 2000);
  assert.equal(c.costUsd, 0.5);
  assert.deepEqual(c.byStage.plan, { calls: 1, promptTokens: 100, evalTokens: 40, modelMs: 1500 });
  assert.deepEqual(c.byModel.m1, { calls: 1, promptTokens: 100, evalTokens: 40, modelMs: 1500 });
  assert.deepEqual(c.gpus, ['RTX 3090']);
});

test('several stages and models are summed separately and the gpu list is deduplicated', () => {
  const c = taskCompute([
    { stage: 'plan', model: 'a', latency_ms: 10, prompt_eval_count: 1, eval_count: 2, gpu_name: 'g1' },
    { stage: 'plan', model: 'b', latency_ms: 20, prompt_eval_count: 3, eval_count: 4, gpu_name: 'g1' },
    { stage: 'implement', model: 'a', latency_ms: 30, prompt_eval_count: 5, eval_count: 6, gpu_name: 'g2' },
  ]);
  assert.equal(c.calls, 3);
  assert.equal(c.promptTokens, 9);
  assert.equal(c.evalTokens, 12);
  assert.equal(c.modelMs, 60);
  assert.deepEqual(c.byStage.plan, { calls: 2, promptTokens: 4, evalTokens: 6, modelMs: 30 });
  assert.deepEqual(c.byStage.implement, { calls: 1, promptTokens: 5, evalTokens: 6, modelMs: 30 });
  assert.deepEqual(c.byModel.a, { calls: 2, promptTokens: 6, evalTokens: 8, modelMs: 40 });
  assert.deepEqual(c.gpus, ['g1', 'g2']);
});

test('null columns count as 0 in the sums but the call is still counted', () => {
  const c = taskCompute([{ stage: 'plan', model: 'a', latency_ms: null, prompt_eval_count: null, eval_count: null, eval_duration_ns: null }, { stage: 'plan', model: 'a', latency_ms: 5, prompt_eval_count: 7, eval_count: 9 }]);
  assert.equal(c.calls, 2);
  assert.equal(c.modelMs, 5);
  assert.equal(c.promptTokens, 7);
  assert.equal(c.evalTokens, 9);
  assert.equal(c.byStage.plan.calls, 2);
});

test('prompt tokens and eval tokens are kept apart', () => {
  const c = taskCompute([{ stage: 's', model: 'm', prompt_eval_count: 11, eval_count: 3 }]);
  assert.equal(c.promptTokens, 11);
  assert.equal(c.evalTokens, 3);
});

test('sumCompute adds two rollups and merges stages, models and gpus', () => {
  const a = taskCompute([{ stage: 'plan', model: 'm1', latency_ms: 10, prompt_eval_count: 1, eval_count: 2, eval_duration_ns: 3_000_000, cost_usd: 1, gpu_name: 'g1' }]);
  const b = taskCompute([{ stage: 'plan', model: 'm2', latency_ms: 20, prompt_eval_count: 3, eval_count: 4, eval_duration_ns: 4_000_000, cost_usd: 2, gpu_name: 'g2' }, { stage: 'critique', model: 'm1', latency_ms: 1 }]);
  const s = sumCompute([a, null, b]);
  assert.equal(s.calls, 3);
  assert.equal(s.promptTokens, 4);
  assert.equal(s.modelMs, 31);
  assert.equal(s.evalMs, 7);
  assert.equal(s.costUsd, 3);
  assert.deepEqual(s.byStage.plan, { calls: 2, promptTokens: 4, evalTokens: 6, modelMs: 30 });
  assert.equal(s.byStage.critique.calls, 1);
  assert.equal(s.byModel.m1.calls, 2);
  assert.deepEqual(s.gpus, ['g1', 'g2']);
  assert.equal(sumCompute([]).calls, 0);
});

test('getTaskCompute returns only the asked task from a db holding two tasks', () => {
  const dir = tmpDir();
  makeDb(dir, FULL_SCHEMA, [
    { call_id: 'c1', task_id: 'T1', stage: 'plan', model: 'm', started_at: 'x', latency_ms: 100, eval_duration_ns: 1e9, prompt_eval_count: 10, eval_count: 5, cost_usd: 0, gpu_name: 'g' },
    { call_id: 'c2', task_id: 'T2', stage: 'plan', model: 'm', started_at: 'x', latency_ms: 900, eval_duration_ns: 1e9, prompt_eval_count: 90, eval_count: 50, cost_usd: 0, gpu_name: 'g' },
  ]);
  const c = getTaskCompute(dir, 'T1');
  assert.equal(c.calls, 1);
  assert.equal(c.promptTokens, 10);
  assert.equal(c.modelMs, 100);
  assert.equal(getTaskCompute(dir, 'T3').calls, 0);
});

test('getTaskCompute returns null for a missing file, a missing pipelineDir and a db without the table', () => {
  const dir = tmpDir();
  assert.equal(getTaskCompute(dir, 'T1'), null);
  assert.equal(getTaskCompute(null, 'T1'), null);
  const db = new DatabaseSync(path.join(dir, 'model-stats.db'));
  db.exec('CREATE TABLE other (x INTEGER)');
  db.close();
  assert.equal(getTaskCompute(dir, 'T1'), null);
});

test('an old db without cost_usd, gpu_name and eval_duration_ns still gives a rollup', () => {
  const dir = tmpDir();
  makeDb(dir, OLD_SCHEMA, [{ call_id: 'c1', task_id: 'T1', stage: 'plan', model: 'm', started_at: 'x', latency_ms: 40, prompt_eval_count: 8, eval_count: 2 }]);
  const c = getTaskCompute(dir, 'T1');
  assert.equal(c.calls, 1);
  assert.equal(c.promptTokens, 8);
  assert.equal(c.evalMs, 0);
  assert.equal(c.costUsd, 0);
  assert.deepEqual(c.gpus, []);
});

test('AGENT_MANAGER_MODEL_STATS_DB_PATH overrides the pipeline location, and the reader never writes', () => {
  const dir = tmpDir();
  const other = tmpDir();
  const file = makeDb(other, FULL_SCHEMA, [{ call_id: 'c1', task_id: 'T1', stage: 'plan', model: 'm', started_at: 'x', latency_ms: 1, eval_duration_ns: 1, prompt_eval_count: 1, eval_count: 1, cost_usd: 0, gpu_name: 'g' }]);
  const before = fs.statSync(file).mtimeMs;
  const prev = process.env.AGENT_MANAGER_MODEL_STATS_DB_PATH;
  process.env.AGENT_MANAGER_MODEL_STATS_DB_PATH = file;
  try {
    assert.equal(getTaskCompute(dir, 'T1').calls, 1);
  } finally {
    if (prev === undefined) delete process.env.AGENT_MANAGER_MODEL_STATS_DB_PATH; else process.env.AGENT_MANAGER_MODEL_STATS_DB_PATH = prev;
  }
  assert.equal(fs.statSync(file).mtimeMs, before);
});
