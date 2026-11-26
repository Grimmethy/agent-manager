#!/usr/bin/env node
'use strict';

// direct-cap-report: read-only summary of direct-pipeline call durations over a
// configurable window (default 14 days). Opens model-stats.db via AGENT_MANAGER_MODEL_STATS_DB_PATH
// in read-only mode, queries duration_ms for call_class = 'direct', computes p50/p95/p99/max,
// and prints a formatted table.
//   node scripts/direct-cap-report.js [--days N]   (N = positive integer, default 14)
// Uses only node:sqlite, fs, path. No network, no child processes, no file writes.

const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_DAYS = 14;
const DAY_MS = 86400000;
const USAGE = `usage: node scripts/direct-cap-report.js [--days N]   (N = positive integer, default ${DEFAULT_DAYS})`;

function fail(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

function parseDays(argv) {
  let days = DEFAULT_DAYS;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg !== '--days') fail(`unknown argument: ${arg}\n${USAGE}`);
    const value = argv[i + 1];
    if (value === undefined || !/^[1-9]\d*$/.test(value)) {
      fail(`--days needs a positive integer, got: ${value === undefined ? '(nothing)' : value}\n${USAGE}`);
    }
    days = Number(value);
    i += 1;
  }
  return days;
}

// Nearest-rank percentile on an already-sorted array (1-indexed rank, clamped to [1, n]).
function pct(sorted, p) {
  const n = sorted.length;
  if (n === 0) return null;
  const rank = Math.max(1, Math.min(n, Math.ceil((p / 100) * n)));
  return sorted[rank - 1];
}

function fmtMs(ms) {
  if (ms == null) return 'n/a';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  return `${(ms / 60000).toFixed(1)} min`;
}

function main() {
  const days = parseDays(process.argv.slice(2));
  const cutoffMs = Date.now() - days * DAY_MS;

  const dbPath = process.env.AGENT_MANAGER_MODEL_STATS_DB_PATH;
  if (!dbPath || !dbPath.trim()) {
    fail('AGENT_MANAGER_MODEL_STATS_DB_PATH is not set; point it at the model-stats.db path and rerun.');
  }

  const abs = path.resolve(dbPath);
  let db;
  try {
    db = new DatabaseSync(abs, { readonly: true });
  } catch (err) {
    fail(`failed to open model-stats.db at ${abs}: ${err.message}`);
  }

  try {
    const stmt = db.prepare(
      "SELECT duration_ms FROM model_calls " +
      "WHERE call_class = 'direct' AND timestamp >= ? " +
      "ORDER BY duration_ms ASC"
    );
    const rows = stmt.all(cutoffMs);
    const durations = rows.map((r) => Number(r.duration_ms)).filter((v) => Number.isFinite(v));
    durations.sort((a, b) => a - b);

    if (durations.length === 0) {
      process.stderr.write(
        `no direct-class duration rows in the last ${days} day(s) (since ${new Date(cutoffMs).toISOString()})\n`
      );
      process.exit(1);
    }

    const p50 = pct(durations, 50);
    const p95 = pct(durations, 95);
    const p99 = pct(durations, 99);
    const max = durations[durations.length - 1];

    const out = [];
    out.push(`direct pipeline capacity report -- window: last ${days} day(s), since ${new Date(cutoffMs).toISOString()}`);
    out.push(`row count: ${durations.length}`);
    out.push(`p50: ${fmtMs(p50)}, p95: ${fmtMs(p95)}, p99: ${fmtMs(p99)}, max: ${fmtMs(max)}`);

    console.log(out.join('\n'));
  } finally {
    db.close();
  }
}

main();
