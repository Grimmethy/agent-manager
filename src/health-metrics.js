'use strict';

// Health metrics module (C3): pure functions over queue dirs, requeue-attribution
// records, and pipeline-history / task rows. Reuses wilsonLower() from src/capability-ledger.js
// (shared implementation at src/capability-ledger.js:64, exported, tested in
// capability-ledger.test.js:34, used by replay-lab.js:17) — do not write a second
// Wilson implementation here.

const fs = require('fs');
const path = require('path');
const { QUEUE_STATES } = require('./task-anywhere.js');
const { wilsonLower: _wilsonLower } = require('./capability-ledger.js');

// Thin re-export of the shared wilsonLower from capability-ledger.js:64 so consumers
// import from one place. The real implementation lives in src/capability-ledger.js.
module.exports.wilsonLower = _wilsonLower;

// --- bucketCounts(queueDir) ---
//
// Count task files (.json) currently sitting in each QUEUE_STATES subdirectory.
//
// @param {string} queueDir - absolute path to the queue root (e.g. "/repo/queue")
// @returns {Object.<string, number>} e.g. { blocked: 2, pending: 0, ... } for every QUEUE_STATES
// @example
//   bucketCounts('/data/queue')
//   // => { pending: 5, review: 0, approved: 0, blocked: 2, done: 120, needs-clarification: 1, awaiting-confirm: 0, coordinating: 0 }
function bucketCounts(queueDir) {
  const result = {};
  for (const state of QUEUE_STATES) {
    result[state] = 0;
  }
  if (!queueDir) return result;
  let entries;
  try {
    entries = fs.readdirSync(queueDir, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!QUEUE_STATES.includes(entry.name)) continue;
    let files;
    try {
      files = fs.readdirSync(path.join(queueDir, entry.name));
    } catch {
      continue;
    }
    let count = 0;
    for (const f of files) {
      if (typeof f === 'string' && f.endsWith('.json')) count++;
    }
    result[entry.name] = count;
  }
  return result;
}

module.exports.bucketCounts = bucketCounts;

// --- requeueRateByCause(rows, windowDays) ---
//
// Group requeue-attribution records by their `signature` cause, within the last
// `windowDays` days from the newest `at` in the dataset, and compute a per-day rate.
//
// @param {Array<{signature: string, at: string, actor?: string}>} rows - requeue-attribution records (shape per requeue_causes table)
// @param {number} windowDays - size of the sliding window in days
// @returns {Array<{cause: string, count: number, ratePerDay: number}>} sorted by count desc; empty array for no data
// @example
//   requeueRateByCause([{signature:'manual',at:'2026-10-20T00:00:00Z'},{signature:'manual',at:'2026-10-19T00:00:00Z'},{signature:'auto',at:'2026-10-18T00:00:00Z'}], 7)
//   // => [{cause:'manual',count:2,ratePerDay:2/7},{cause:'auto',count:1,ratePerDay:1/7}]
function requeueRateByCause(rows, windowDays) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const days = Number(windowDays) || 1;
  // Find the newest `at` to anchor the window end.
  let maxAt = null;
  for (const r of rows) {
    if (r && r.at) {
      const t = new Date(r.at).getTime();
      if (Number.isFinite(t) && (!maxAt || t > maxAt)) maxAt = t;
    }
  }
  // If no valid `at` fields, include everything.
  const windowStart = maxAt != null ? maxAt - days * 86400000 : null;
  const groups = new Map();
  for (const r of rows) {
    if (!r || !r.signature) continue;
    let include = true;
    if (windowStart != null && r.at) {
      const t = new Date(r.at).getTime();
      if (!Number.isFinite(t) || t < windowStart) include = false;
    }
    if (!include) continue;
    const cause = r.signature;
    const cur = groups.get(cause) || 0;
    groups.set(cause, cur + 1);
  }
  const out = [];
  for (const [cause, count] of groups) {
    out.push({ cause, count, ratePerDay: count / days });
  }
  out.sort((a, b) => b.count - a.count || a.cause.localeCompare(b.cause));
  return out;
}

module.exports.requeueRateByCause = requeueRateByCause;

// --- shipRatePerSource(taskRows, windowDays) ---
//
// Per source: count shipped (ok=true) vs total attempted within the window, with
// a Wilson lower bound on the shipped rate via the shared wilsonLower.
//
// @param {Array<{source: string, ok?: boolean, at?: string}>} taskRows - task or pipeline-history records
// @param {number} windowDays - size of the sliding window in days
// @returns {Array<{source: string, ok: number, total: number, rate: number, lower: number}>} sorted by source asc
// @example
//   shipRatePerSource([{source:'manual',ok:true,at:'2026-10-20T00:00:00Z'},{source:'manual',ok:false,at:'2026-10-19T00:00:00Z'}], 30)
//   // => [{source:'manual',ok:1,total:2,rate:0.5,lower:<wilsonLower(1,2)>}]
function shipRatePerSource(taskRows, windowDays) {
  if (!Array.isArray(taskRows) || taskRows.length === 0) return [];
  const days = Number(windowDays) || 1;
  // Anchor the window on the newest `at`.
  let maxAt = null;
  for (const r of taskRows) {
    if (r && r.at) {
      const t = new Date(r.at).getTime();
      if (Number.isFinite(t) && (!maxAt || t > maxAt)) maxAt = t;
    }
  }
  const windowStart = maxAt != null ? maxAt - days * 86400000 : null;
  const groups = new Map();
  for (const r of taskRows) {
    if (!r || !r.source) continue;
    let include = true;
    if (windowStart != null && r.at) {
      const t = new Date(r.at).getTime();
      if (!Number.isFinite(t) || t < windowStart) include = false;
    }
    if (!include) continue;
    const g = groups.get(r.source) || { ok: 0, total: 0 };
    g.total += 1;
    if (r.ok) g.ok += 1;
    groups.set(r.source, g);
  }
  const out = [];
  for (const [source, { ok, total }] of groups) {
    const rate = total ? ok / total : 0;
    out.push({ source, ok, total, rate, lower: _wilsonLower(ok, total) });
  }
  out.sort((a, b) => a.source.localeCompare(b.source));
  return out;
}

module.exports.shipRatePerSource = shipRatePerSource;

// --- successBySourceModel(taskRows) ---
//
// Cross-tab of source × model: for each (source, model) pair count ok/total and
// compute a Wilson lower bound on the success rate.
//
// @param {Array<{source: string, model: string, ok?: boolean}>} taskRows - task records
// @returns {Array<{source: string, model: string, ok: number, total: number, rate: number, lower: number}>} sorted by source then model
// @example
//   successBySourceModel([{source:'manual',model:'claude-3',ok:true},{source:'manual',model:'claude-3',ok:false}])
//   // => [{source:'manual',model:'claude-3',ok:1,total:2,rate:0.5,lower:<wilsonLower(1,2)>}]
function successBySourceModel(taskRows) {
  if (!Array.isArray(taskRows) || taskRows.length === 0) return [];
  const groups = new Map();
  for (const r of taskRows) {
    if (!r || !r.source || !r.model) continue;
    const key = `${r.source}\u0000${r.model}`;
    const g = groups.get(key) || { ok: 0, total: 0 };
    g.total += 1;
    if (r.ok) g.ok += 1;
    groups.set(key, g);
  }
  const out = [];
  for (const [key, { ok, total }] of groups) {
    const [source, model] = key.split('\u0000');
    const rate = total ? ok / total : 0;
    out.push({ source, model, ok, total, rate, lower: _wilsonLower(ok, total) });
  }
  out.sort((a, b) => a.source.localeCompare(b.source) || a.model.localeCompare(b.model));
  return out;
}

module.exports.successBySourceModel = successBySourceModel;
