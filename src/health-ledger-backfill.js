'use strict';

// health-ledger-backfill.js -- one-shot backfill of the daily health ledger for days that have no row yet.
//
// Why (C4 of Docs/tuning-loops-design.md): the ledger (src/health-ledger-schema.js) only starts filling when a loop first writes, so the days
// before that have no row to compare against. The facts for those days still exist in two places: model-stats.db (table model_calls, one row
// per model call) and the pipeline history log (<pipelineDir>/instances/pipeline-history.log, src/pipeline-history.js). This reads both,
// read-only, and appends ONE row per missing day through the real schema's appendRow (never rewrites, never touches a day that has any row).
//
// Run by hand: node src/health-ledger-backfill.js [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--dry-run]. Default range: the 30 days up to and
// including yesterday (UTC). One-shot like expiry-sweep.js, NOT a daemon; nothing calls it automatically (the ask names "manually or from the
// watchdog tick"; adding it to the tick is a separate owner decision). Per-day log lines go to stderr, which scripts/queue-watcher.sh already
// redirects into the standard logs directory when a tick runs a sweep.
//
// Schema fit: the real validator (health-ledger-schema.js validateRow) requires NUMBERS for metric.before/after and cost.gpu_minutes/peak_ram_mb,
// so the null the original ask used for "not measured" is rejected. A backfilled row therefore carries 0 in those four fields and says so
// explicitly: verdict.inputs.unknown_fields lists them and the note repeats it, so a reader never mistakes 0 for a measurement. NULL token/cost
// columns in model_calls are counted per column, never summed as zero.

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { appendRow, readRows, validateRow } = require('./health-ledger-schema.js');
const { readPipelineHistory } = require('./pipeline-history.js');

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAYS = 30;
const UNKNOWN_FIELDS = ['metric.before', 'metric.after', 'cost.gpu_minutes', 'cost.peak_ram_mb'];

function assertDay(label, value) {
  if (!DAY_RE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`${label} must be a real date in YYYY-MM-DD form, got "${value}"`);
  }
}

function dayString(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// Inclusive list of YYYY-MM-DD between from and to (UTC).
function daysBetween(from, to) {
  const out = [];
  for (let ms = Date.parse(`${from}T00:00:00Z`); ms <= Date.parse(`${to}T00:00:00Z`); ms += DAY_MS) out.push(dayString(ms));
  return out;
}

// Resolves { from, to } from the options: both given, or the default window ending yesterday. Throws a clear error for a bad or reversed range.
function resolveRange({ from, to }, nowMs = Date.now()) {
  const end = to || dayString(nowMs - DAY_MS);
  assertDay('--to', end);
  const start = from || dayString(Date.parse(`${end}T00:00:00Z`) - (DEFAULT_DAYS - 1) * DAY_MS);
  assertDay('--from', start);
  if (start > end) throw new Error(`--from (${start}) is after --to (${end})`);
  return { from: start, to: end };
}

// Per-day aggregates from model_calls, opened read-only. Throws a clear error when the file or the table is missing.
function readModelCallDays(dbPath, from, to) {
  if (!dbPath || !fs.existsSync(dbPath)) throw new Error(`model-stats database not found at ${dbPath}`);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const cols = new Set(db.prepare(`SELECT name FROM pragma_table_info('model_calls')`).all().map((r) => r.name));
    if (!cols.has('started_at')) throw new Error(`model_calls table with a started_at column not found in ${dbPath}`);
    const nullExpr = (col) => (cols.has(col) ? `SUM(CASE WHEN ${col} IS NULL THEN 1 ELSE 0 END)` : 'COUNT(*)');
    const outcomeExpr = cols.has('outcome') ? `COALESCE(outcome, '(none)')` : `'(none)'`;
    const range = [from, to];
    const totals = db.prepare(`
      SELECT substr(started_at, 1, 10) AS day, COUNT(*) AS calls,
             ${nullExpr('prompt_eval_count')} AS null_prompt_eval_count,
             ${nullExpr('eval_count')} AS null_eval_count,
             ${nullExpr('cost_usd')} AS null_cost_usd
      FROM model_calls WHERE substr(started_at, 1, 10) BETWEEN ? AND ? GROUP BY day
    `).all(...range);
    const outcomes = db.prepare(`
      SELECT substr(started_at, 1, 10) AS day, ${outcomeExpr} AS outcome, COUNT(*) AS n
      FROM model_calls WHERE substr(started_at, 1, 10) BETWEEN ? AND ? GROUP BY day, outcome
    `).all(...range);
    const byDay = new Map();
    for (const t of totals) {
      byDay.set(t.day, {
        calls: Number(t.calls),
        null_prompt_eval_count: Number(t.null_prompt_eval_count),
        null_eval_count: Number(t.null_eval_count),
        null_cost_usd: Number(t.null_cost_usd),
        outcomes: {},
      });
    }
    for (const o of outcomes) {
      const d = byDay.get(o.day);
      if (d) d.outcomes[o.outcome] = Number(o.n);
    }
    return byDay;
  } finally {
    db.close();
  }
}

// Count of pipeline-history events per day, from the unified log.
function countHistoryEvents(pipelineDir, from, to) {
  const counts = new Map();
  for (const ev of readPipelineHistory(pipelineDir)) {
    const day = typeof ev.at === 'string' ? ev.at.slice(0, 10) : '';
    if (day >= from && day <= to) counts.set(day, (counts.get(day) || 0) + 1);
  }
  return counts;
}

function buildRow(day, calls, historyEvents, nowIso) {
  const c = calls || { calls: 0, null_prompt_eval_count: 0, null_eval_count: 0, null_cost_usd: 0, outcomes: {} };
  const nullNote = `${c.null_prompt_eval_count} of ${c.calls} calls had NULL prompt_eval_count, ${c.null_eval_count} NULL eval_count, ${c.null_cost_usd} NULL cost_usd (unknown, not zero)`;
  return {
    ts: nowIso,
    loop_id: 'backfill',
    trigger: { kind: 'schedule', detail: 'manual-backfill' },
    verdict: {
      value: 'backfilled',
      inputs: {
        day,
        model_calls: c.calls,
        outcomes: c.outcomes,
        null_prompt_eval_count: c.null_prompt_eval_count,
        null_eval_count: c.null_eval_count,
        null_cost_usd: c.null_cost_usd,
        pipeline_history_events: historyEvents,
        unknown_fields: UNKNOWN_FIELDS,
      },
    },
    items: { released: [], held: [], filed: [] },
    metric: { name: 'backfill', before: 0, after: 0 },
    cost: { gpu_minutes: 0, peak_ram_mb: 0, model_calls: c.calls },
    note: `Backfilled for ${day} from model-stats.db and pipeline-history. ${nullNote}. ${UNKNOWN_FIELDS.join(', ')} were not measured and are written as 0.`,
  };
}

// Writes one row per day in [from, to] that has no row yet and has source data. Returns [{ day, status, ... }] with status written | skipped-existing | no-data.
function backfill({ pipelineDir, dbPath, from, to, now = Date.now(), dryRun = false, log = (line) => console.error(line) }) {
  if (!pipelineDir) throw new Error('pipelineDir is required');
  const range = resolveRange({ from, to }, now);
  const calls = readModelCallDays(dbPath, range.from, range.to);
  const events = countHistoryEvents(pipelineDir, range.from, range.to);
  const nowIso = new Date(now).toISOString();
  const results = [];
  for (const day of daysBetween(range.from, range.to)) {
    let result;
    if (readRows(pipelineDir, { fromDate: day, toDate: day }).length > 0) {
      result = { day, status: 'skipped-existing' };
    } else if (!calls.has(day) && !events.has(day)) {
      result = { day, status: 'no-data' };
    } else {
      const row = buildRow(day, calls.get(day), events.get(day) || 0, nowIso);
      const check = validateRow(row);
      if (!check.ok) throw new Error(`backfill built an invalid row for ${day}: ${check.errors.join('; ')}`);
      if (!dryRun) appendRow(pipelineDir, day, row);
      result = { day, status: dryRun ? 'would-write' : 'written', model_calls: row.cost.model_calls, null_cost_usd: row.verdict.inputs.null_cost_usd, pipeline_history_events: row.verdict.inputs.pipeline_history_events };
    }
    results.push(result);
    log(`[health-ledger-backfill] ${result.day} ${result.status}${result.model_calls !== undefined ? ` model_calls=${result.model_calls} null_cost_usd=${result.null_cost_usd} history_events=${result.pipeline_history_events}` : ''}`);
  }
  return results;
}

function parseArgs(argv) {
  const args = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--from' || argv[i] === '--to') {
      if (!argv[i + 1]) throw new Error(`${argv[i]} needs a value`);
      args[argv[i].slice(2)] = argv[++i];
    } else if (argv[i] === '--dry-run') {
      args.dryRun = true;
    } else {
      throw new Error(`unknown argument ${argv[i]}`);
    }
  }
  return args;
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const { getConfig } = require('./config.js');
    const pipelineDir = getConfig().pipelineDir;
    const dbPath = process.env.AGENT_MANAGER_MODEL_STATS_DB_PATH || path.join(pipelineDir, 'model-stats.db');
    const results = backfill({ pipelineDir, dbPath, from: args.from, to: args.to, dryRun: args.dryRun });
    process.stdout.write(`${JSON.stringify({ written: results.filter((r) => r.status === 'written').length, skipped: results.filter((r) => r.status === 'skipped-existing').length, noData: results.filter((r) => r.status === 'no-data').length })}\n`);
  } catch (e) {
    console.error(`[health-ledger-backfill] ${e.message}`);
    process.exit(1);
  }
}

module.exports = { backfill, resolveRange, parseArgs, readModelCallDays, buildRow, UNKNOWN_FIELDS };

if (require.main === module) main();
