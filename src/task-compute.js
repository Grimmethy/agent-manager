'use strict';

// Per-task compute rollup over model_calls rows (HUB0280-01). Pure sums in taskCompute/sumCompute; getTaskCompute is the only reader of
// model-stats.db and it opens the file read-only, so a missing file, table or column gives null / zeros instead of an error.

const fs = require('fs');
const path = require('path');

const OPTIONAL_COLUMNS = ['cost_usd', 'gpu_name', 'eval_duration_ns'];

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function emptyBucket() {
  return { calls: 0, promptTokens: 0, evalTokens: 0, modelMs: 0 };
}

function addToBucket(bucket, b) {
  bucket.calls += b.calls;
  bucket.promptTokens += b.promptTokens;
  bucket.evalTokens += b.evalTokens;
  bucket.modelMs += b.modelMs;
}

function emptyCompute() {
  return { calls: 0, promptTokens: 0, evalTokens: 0, modelMs: 0, evalMs: 0, costUsd: 0, byStage: {}, byModel: {}, gpus: [] };
}

// rows (model_calls rows as plain objects) -> the rollup. A null column counts as 0 in the sums, the call is still counted.
function taskCompute(rows) {
  const out = emptyCompute();
  let evalNs = 0;
  for (const r of rows || []) {
    if (!r) continue;
    const one = { calls: 1, promptTokens: num(r.prompt_eval_count), evalTokens: num(r.eval_count), modelMs: num(r.latency_ms) };
    addToBucket(out, one);
    evalNs += num(r.eval_duration_ns);
    out.costUsd += num(r.cost_usd);
    const stage = r.stage == null ? 'unknown' : String(r.stage);
    const model = r.model == null ? 'unknown' : String(r.model);
    addToBucket(out.byStage[stage] || (out.byStage[stage] = emptyBucket()), one);
    addToBucket(out.byModel[model] || (out.byModel[model] = emptyBucket()), one);
    if (r.gpu_name && !out.gpus.includes(String(r.gpu_name))) out.gpus.push(String(r.gpu_name));
  }
  out.evalMs = Math.round(evalNs / 1e6);
  return out;
}

// [rollup, ...] -> one rollup (a hub = its children plus itself). Null entries are skipped.
function sumCompute(list) {
  const out = emptyCompute();
  for (const c of list || []) {
    if (!c) continue;
    addToBucket(out, c);
    out.evalMs += num(c.evalMs);
    out.costUsd += num(c.costUsd);
    for (const [k, v] of Object.entries(c.byStage || {})) addToBucket(out.byStage[k] || (out.byStage[k] = emptyBucket()), v);
    for (const [k, v] of Object.entries(c.byModel || {})) addToBucket(out.byModel[k] || (out.byModel[k] = emptyBucket()), v);
    for (const g of c.gpus || []) if (!out.gpus.includes(g)) out.gpus.push(g);
  }
  return out;
}

function dbPathFor(pipelineDir) {
  if (process.env.AGENT_MANAGER_MODEL_STATS_DB_PATH) return process.env.AGENT_MANAGER_MODEL_STATS_DB_PATH;
  return pipelineDir ? path.join(pipelineDir, 'model-stats.db') : null;
}

// -> rollup for one task, or null when the file, the table or the pipelineDir is missing. Never throws.
function getTaskCompute(pipelineDir, taskId) {
  const dbPath = dbPathFor(pipelineDir);
  if (!dbPath || !taskId || !fs.existsSync(dbPath)) return null;
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch { return null; }
  let db;
  try { db = new DatabaseSync(dbPath, { readOnly: true }); } catch { return null; }
  try {
    const present = new Set(db.prepare(`SELECT name FROM pragma_table_info('model_calls')`).all().map((r) => r.name));
    if (!present.has('task_id')) return null;
    const cols = ['task_id', 'stage', 'model', 'latency_ms', 'prompt_eval_count', 'eval_count', ...OPTIONAL_COLUMNS].filter((c) => present.has(c));
    const rows = db.prepare(`SELECT ${cols.join(', ')} FROM model_calls WHERE task_id = ?`).all(String(taskId));
    return taskCompute(rows);
  } catch {
    return null;
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

module.exports = { taskCompute, sumCompute, getTaskCompute };
