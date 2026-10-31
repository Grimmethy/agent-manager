'use strict';

// health-ledger-backfill.js: one row per missing day, from a seeded model-stats.db and a pipeline-history.log, through the REAL schema (health-ledger-schema.js).
// The fixture DB uses the real model_calls column names (model-stats-db.js DDL); the CLI tests spawn the real entry point.
// Run: node --test src/health-ledger-backfill.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { backfill, resolveRange, parseArgs } = require('./health-ledger-backfill.js');
const { readRows, validateRow, appendRow, rowPath } = require('./health-ledger-schema.js');

const SCRIPT = path.join(__dirname, 'health-ledger-backfill.js');
const DAY = '2026-10-20';
const NOW = Date.parse('2026-10-30T12:00:00Z');

function fixture({ calls = [], events = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-backfill-'));
  const dbPath = path.join(dir, 'model-stats.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE model_calls (
    call_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, stage TEXT NOT NULL DEFAULT 'implement', model TEXT NOT NULL, started_at TEXT NOT NULL,
    latency_ms INTEGER, prompt_eval_count INTEGER, eval_count INTEGER, attempts INTEGER, degenerate TEXT, call_error TEXT,
    outcome TEXT, outcome_stage TEXT, outcome_reason TEXT, outcome_at TEXT, cost_usd REAL, instance_id TEXT, source TEXT)`);
  const ins = db.prepare('INSERT INTO model_calls (call_id, task_id, model, started_at, prompt_eval_count, eval_count, outcome, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  calls.forEach((c, i) => ins.run(`c${i}`, `t${i}`, 'ornith:35b', c.at, c.prompt === undefined ? 100 : c.prompt, c.eval === undefined ? 20 : c.eval, c.outcome ?? 'approved', c.cost === undefined ? 0.01 : c.cost));
  db.close();
  fs.mkdirSync(path.join(dir, 'instances'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'instances', 'pipeline-history.log'), events.map((at) => JSON.stringify({ at, type: 'context_audit', taskId: 'x' })).join('\n') + (events.length ? '\n' : ''));
  return { dir, dbPath };
}
const quiet = () => {};
const seeded = () => fixture({
  calls: [{ at: `${DAY}T01:00:00Z` }, { at: `${DAY}T02:00:00Z`, outcome: 'rejected' }, { at: `${DAY}T03:00:00Z`, cost: null, prompt: null }],
  events: [`${DAY}T05:00:00Z`],
});

test('a seeded day gets exactly one row that passes the real validator, with the call count and the NULL counts in the note', () => {
  const { dir, dbPath } = seeded();
  const results = backfill({ pipelineDir: dir, dbPath, from: DAY, to: DAY, now: NOW, log: quiet });
  assert.deepEqual(results.map((r) => r.status), ['written']);
  const rows = readRows(dir, { fromDate: DAY, toDate: DAY });
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(validateRow(row).ok, true);
  assert.equal(row.loop_id, 'backfill');
  assert.deepEqual(row.trigger, { kind: 'schedule', detail: 'manual-backfill' });
  assert.equal(row.verdict.value, 'backfilled');
  assert.equal(row.cost.model_calls, 3);
  assert.equal(row.verdict.inputs.pipeline_history_events, 1);
  assert.deepEqual(row.verdict.inputs.outcomes, { approved: 2, rejected: 1 });
  assert.equal(row.verdict.inputs.null_cost_usd, 1);
  assert.equal(row.verdict.inputs.null_prompt_eval_count, 1);
  assert.match(row.note, /1 of 3 calls had NULL prompt_eval_count, 0 NULL eval_count, 1 NULL cost_usd \(unknown, not zero\)/);
  assert.deepEqual(row.items, { released: [], held: [], filed: [] });
});

test('the real schema rejects null for the fields that are not measured, so they are written as 0 and listed as unknown', () => {
  const { dir, dbPath } = seeded();
  backfill({ pipelineDir: dir, dbPath, from: DAY, to: DAY, now: NOW, log: quiet });
  const row = readRows(dir)[0];
  assert.equal(validateRow({ ...row, metric: { name: 'backfill', before: null, after: null } }).ok, false, 'a null metric is invalid in the real schema');
  assert.equal(validateRow({ ...row, cost: { ...row.cost, gpu_minutes: null } }).ok, false);
  assert.deepEqual(row.verdict.inputs.unknown_fields, ['metric.before', 'metric.after', 'cost.gpu_minutes', 'cost.peak_ram_mb']);
  assert.equal(row.metric.before, 0);
  assert.match(row.note, /not measured and are written as 0/);
});

test('running again writes nothing: the ledger file is byte for byte unchanged', () => {
  const { dir, dbPath } = seeded();
  backfill({ pipelineDir: dir, dbPath, from: DAY, to: DAY, now: NOW, log: quiet });
  const before = fs.readFileSync(rowPath(dir, DAY), 'utf8');
  const again = backfill({ pipelineDir: dir, dbPath, from: DAY, to: DAY, now: NOW + 1000, log: quiet });
  assert.deepEqual(again.map((r) => r.status), ['skipped-existing']);
  assert.equal(fs.readFileSync(rowPath(dir, DAY), 'utf8'), before);
});

test('a day that already has a row from ANOTHER loop is left alone', () => {
  const { dir, dbPath } = seeded();
  const other = { ts: `${DAY}T09:00:00Z`, loop_id: 'some-loop', trigger: { kind: 'event', detail: 'x' }, verdict: { value: true, inputs: {} }, items: { released: [], held: [], filed: [] }, metric: { name: 'm', before: 1, after: 2 }, cost: { gpu_minutes: 1, peak_ram_mb: 1, model_calls: 1 } };
  appendRow(dir, DAY, other);
  const results = backfill({ pipelineDir: dir, dbPath, from: DAY, to: DAY, now: NOW, log: quiet });
  assert.equal(results[0].status, 'skipped-existing');
  assert.equal(readRows(dir).length, 1);
});

test('a day with no model calls and no history events is skipped, not turned into an invented all-zero row', () => {
  const { dir, dbPath } = seeded();
  const results = backfill({ pipelineDir: dir, dbPath, from: '2026-10-19', to: '2026-10-21', now: NOW, log: quiet });
  assert.deepEqual(results.map((r) => `${r.day}:${r.status}`), ['2026-10-19:no-data', `${DAY}:written`, '2026-10-21:no-data']);
});

test('a day with history events but no model calls still gets a row, with zero calls', () => {
  const { dir, dbPath } = fixture({ events: [`${DAY}T05:00:00Z`, `${DAY}T06:00:00Z`] });
  backfill({ pipelineDir: dir, dbPath, from: DAY, to: DAY, now: NOW, log: quiet });
  const row = readRows(dir)[0];
  assert.equal(row.cost.model_calls, 0);
  assert.equal(row.verdict.inputs.pipeline_history_events, 2);
});

test('dry run writes nothing but reports would-write', () => {
  const { dir, dbPath } = seeded();
  const results = backfill({ pipelineDir: dir, dbPath, from: DAY, to: DAY, now: NOW, dryRun: true, log: quiet });
  assert.equal(results[0].status, 'would-write');
  assert.equal(fs.existsSync(path.join(dir, 'health-ledger')), false);
});

test('the database is opened read-only: its bytes are unchanged and a missing database is a clear error', () => {
  const { dir, dbPath } = seeded();
  const before = fs.readFileSync(dbPath);
  backfill({ pipelineDir: dir, dbPath, from: DAY, to: DAY, now: NOW, log: quiet });
  assert.deepEqual(fs.readFileSync(dbPath), before);
  assert.throws(() => backfill({ pipelineDir: dir, dbPath: path.join(dir, 'nope.db'), from: DAY, to: DAY, now: NOW, log: quiet }), /model-stats database not found/);
});

test('each day logs one line with its status and key counts', () => {
  const { dir, dbPath } = seeded();
  const lines = [];
  backfill({ pipelineDir: dir, dbPath, from: DAY, to: '2026-10-21', now: NOW, log: (l) => lines.push(l) });
  assert.equal(lines.length, 2);
  assert.match(lines[0], new RegExp(`\\[health-ledger-backfill\\] ${DAY} written model_calls=3 null_cost_usd=1 history_events=1`));
  assert.match(lines[1], /2026-10-21 no-data/);
});

test('the default range is the 30 days ending yesterday; a reversed or malformed range is an error', () => {
  assert.deepEqual(resolveRange({}, NOW), { from: '2026-09-30', to: '2026-10-29' });
  assert.throws(() => resolveRange({ from: '2026-10-05', to: '2026-10-01' }, NOW), /--from \(2026-10-05\) is after --to \(2026-10-01\)/);
  assert.throws(() => resolveRange({ from: '2026-13-40', to: '2026-10-01' }, NOW), /real date/);
  assert.throws(() => resolveRange({ from: 'yesterday' }, NOW), /YYYY-MM-DD/);
  assert.throws(() => parseArgs(['--bogus']), /unknown argument/);
});

test('real entry point: node src/health-ledger-backfill.js writes the row through the real config, then a second run writes nothing', () => {
  const { dir, dbPath } = seeded();
  const env = { ...process.env, AGENT_MANAGER_PIPELINE_DIR: dir, AGENT_MANAGER_REPO_ROOT: dir, AGENT_MANAGER_MODEL_STATS_DB_PATH: dbPath };
  const run = () => JSON.parse(execFileSync('node', [SCRIPT, '--from', DAY, '--to', DAY], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.deepEqual(run(), { written: 1, skipped: 0, noData: 0 });
  assert.equal(readRows(dir).length, 1);
  assert.deepEqual(run(), { written: 0, skipped: 1, noData: 0 });
  assert.equal(readRows(dir).length, 1);
});

test('real entry point: --from after --to exits non-zero with a clear message and writes nothing', () => {
  const { dir, dbPath } = seeded();
  const env = { ...process.env, AGENT_MANAGER_PIPELINE_DIR: dir, AGENT_MANAGER_REPO_ROOT: dir, AGENT_MANAGER_MODEL_STATS_DB_PATH: dbPath };
  const r = spawnSync('node', [SCRIPT, '--from', '2026-10-25', '--to', '2026-10-20'], { env, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--from \(2026-10-25\) is after --to \(2026-10-20\)/);
  assert.equal(fs.existsSync(path.join(dir, 'health-ledger')), false);
});
