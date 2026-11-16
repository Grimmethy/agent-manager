'use strict';

// pass-runs.js -- an append-only JSONL record of every pipeline pass run (produced vs. delivered counts), plus a pure stalled-delivery rule.
// Format: one JSON object per line in <pipelineDir>/pass-runs.jsonl, shaped { source, startedAt, endedAt, status, produced, queued }.
// Best-effort by design: recordPassRun never throws, so a pass is never crashed by its own bookkeeping.

const fs = require('fs');
const path = require('path');
const { getConfig } = require('./config');

const FILE = 'pass-runs.jsonl';
const STATUSES = new Set(['ok', 'partial', 'failed', 'skipped-out-of-window', 'skipped-already-ran', 'skipped-paused']);
const KEYS = ['source', 'startedAt', 'endedAt', 'status', 'produced', 'queued'];
const KEY_SET = new Set(KEYS);
const loggedReasons = new Set();

// opts.file overrides the default. Otherwise the path comes from getConfig().pipelineDir, resolved lazily so requiring this module never throws.
function resolveFile(opts = {}) {
  if (opts.file) return opts.file;
  return path.join(getConfig().pipelineDir, FILE);
}

// Returns null when the record is valid, otherwise a reason string.
function validate(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return 'record must be a plain object';
  for (const k of Object.keys(record)) if (!KEY_SET.has(k)) return `unknown key: ${k}`;
  if (typeof record.source !== 'string' || record.source === '') return 'source must be a non-empty string';
  if (!Number.isFinite(record.startedAt)) return 'startedAt must be a finite number';
  if (!Number.isFinite(record.endedAt)) return 'endedAt must be a finite number';
  if (!STATUSES.has(record.status)) return `invalid status: ${record.status}`;
  if (!Number.isInteger(record.produced) || record.produced < 0) return 'produced must be an integer >= 0';
  if (!Number.isInteger(record.queued) || record.queued < 0) return 'queued must be an integer >= 0';
  return null;
}

// Returns { ok: true } when appended, otherwise { ok: false, reason }.
function recordPassRun(record, opts = {}) {
  const reason = validate(record);
  if (reason) {
    if (!loggedReasons.has(reason)) {
      loggedReasons.add(reason);
      console.warn(`[pass-runs] refused record: ${reason}`);
    }
    return { ok: false, reason };
  }
  const out = {};
  for (const k of KEYS) out[k] = record[k];
  try {
    const file = resolveFile(opts);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(out)}\n`);
    return { ok: true };
  } catch (err) {
    console.warn(`[pass-runs] could not record pass run for ${record.source}: ${err.message}`);
    return { ok: false, reason: `write-failed: ${err.message}` };
  }
}

// Records for one source with startedAt >= sinceMs, in file order. A missing file is an empty store; malformed lines are skipped.
function readPassRuns({ source, sinceMs = 0 } = {}, opts = {}) {
  const file = resolveFile(opts);
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (validate(rec) !== null) continue;
    if (rec.source !== source || rec.startedAt < sinceMs) continue;
    out.push(rec);
  }
  return out;
}

// Pure: no I/O. A source is stalled when its last minRuns runs (by endedAt) are all status 'ok' with produced 0.
// lastNonZeroDate is the UTC date (YYYY-MM-DD) of the latest run with produced > 0, or null if none.
function deliveryStalled(runs, { minRuns = 5 } = {}) {
  const groups = new Map();
  for (const r of runs || []) {
    if (!groups.has(r.source)) groups.set(r.source, []);
    groups.get(r.source).push(r);
  }
  const out = [];
  for (const [source, list] of groups) {
    const sorted = [...list].sort((a, b) => a.endedAt - b.endedAt);
    if (sorted.length < minRuns) continue;
    const tail = sorted.slice(-minRuns);
    if (!tail.every((r) => r.status === 'ok' && r.produced === 0)) continue;
    const lastNonZero = [...sorted].reverse().find((r) => r.produced > 0);
    out.push({
      source,
      count: sorted.length,
      lastNonZeroDate: lastNonZero ? new Date(lastNonZero.endedAt).toISOString().slice(0, 10) : null,
    });
  }
  return out;
}

module.exports = { recordPassRun, readPassRuns, deliveryStalled };
