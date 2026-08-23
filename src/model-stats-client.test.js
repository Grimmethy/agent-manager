'use strict';

// Unit tests for model-stats-client.js -- previously untested entirely, despite being
// the wrapper every real drafting/review call routes through to record into
// model-stats.db. Run against a real throwaway sqlite db (model-stats-db.js itself
// can't be require()'d, see its own header -- these tests exercise it as the real
// subprocess it's built to be, same as production).
//
// Added 2026-08-23 alongside the costUsd feature (Grimmethy: "Do we have any way of
// knowing how much these tasks would cost using anthropic API?") -- claude-client.js's
// call() had always computed a real per-call Anthropic-API cost estimate
// (total_cost_usd) and nothing downstream ever stored or read it back.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

function freshDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-stats-client-test-'));
  return path.join(dir, 'model-stats.db');
}

function withFreshDb(dbPath, fn) {
  process.env.AGENT_MANAGER_MODEL_STATS_DB_PATH = dbPath;
  delete require.cache[require.resolve('./model-stats-client.js')];
  return fn(require('./model-stats-client.js'));
}

test('recordCall stores a real Claude call\'s costUsd, getCostSummary reads it back', async () => {
  const dbPath = freshDbPath();
  await withFreshDb(dbPath, async ({ recordCall, getCostSummary }) => {
    recordCall({ taskId: 't1', model: 'claude:sonnet', startedAt: new Date().toISOString(), latencyMs: 1000, result: { costUsd: 0.42 } });
    // record-call shells out synchronously (execFileSync inside runEvent), so by the
    // time recordCall() returns the row is already committed -- no wait needed.
    const summary = getCostSummary();
    assert.equal(summary.totalCostUsd, 0.42);
    assert.equal(summary.callsWithCost, 1);
  });
});

test('recordCall stores null cost_usd for a local (Ornith) result -- a free call, not an unknown one', async () => {
  const dbPath = freshDbPath();
  await withFreshDb(dbPath, async ({ recordCall, getCostSummary }) => {
    recordCall({ taskId: 't1', model: 'qwen3.8:27b-q4_K_M', startedAt: new Date().toISOString(), latencyMs: 500, result: { eval_count: 100 } });
    const summary = getCostSummary();
    assert.equal(summary.totalCostUsd, 0);
    assert.equal(summary.callsWithCost, 0);
    assert.equal(summary.freeCalls, 1);
  });
});

test('getCostSummary aggregates totalCostUsd and byModel across multiple calls, mixing costed and free', async () => {
  const dbPath = freshDbPath();
  await withFreshDb(dbPath, async ({ recordCall, getCostSummary }) => {
    recordCall({ taskId: 't1', model: 'claude:sonnet', startedAt: new Date().toISOString(), latencyMs: 1, result: { costUsd: 0.10 } });
    recordCall({ taskId: 't2', model: 'claude:sonnet', startedAt: new Date().toISOString(), latencyMs: 1, result: { costUsd: 0.20 } });
    recordCall({ taskId: 't3', model: 'claude:opus', startedAt: new Date().toISOString(), latencyMs: 1, result: { costUsd: 1.50 } });
    recordCall({ taskId: 't4', model: 'qwen3.8:27b-q4_K_M', startedAt: new Date().toISOString(), latencyMs: 1, result: {} });

    const summary = getCostSummary();
    assert.ok(Math.abs(summary.totalCostUsd - 1.80) < 1e-9);
    assert.equal(summary.callsWithCost, 3);
    assert.equal(summary.freeCalls, 1);
    const sonnet = summary.byModel.find((m) => m.model === 'claude:sonnet');
    assert.equal(sonnet.calls, 2);
    assert.ok(Math.abs(sonnet.totalCost - 0.30) < 1e-9);
    // Highest-cost model first.
    assert.equal(summary.byModel[0].model, 'claude:opus');
  });
});

test('recordCall stamps instanceId from AGENT_MANAGER_INSTANCE_ID, getCostSummary breaks cost down by instance', async () => {
  const dbPath = freshDbPath();
  const prevInstanceId = process.env.AGENT_MANAGER_INSTANCE_ID;
  await withFreshDb(dbPath, async ({ recordCall, getCostSummary }) => {
    process.env.AGENT_MANAGER_INSTANCE_ID = 'worker-reasoning';
    recordCall({ taskId: 't1', model: 'claude:sonnet', startedAt: new Date().toISOString(), latencyMs: 1, result: { costUsd: 0.30 } });
    process.env.AGENT_MANAGER_INSTANCE_ID = 'worker-1';
    recordCall({ taskId: 't2', model: 'claude:sonnet', startedAt: new Date().toISOString(), latencyMs: 1, result: { costUsd: 0.10 } });

    const summary = getCostSummary();
    const byInstance = Object.fromEntries(summary.byInstance.map((i) => [i.instanceId, i]));
    assert.ok(Math.abs(byInstance['worker-reasoning'].totalCost - 0.30) < 1e-9);
    assert.ok(Math.abs(byInstance['worker-1'].totalCost - 0.10) < 1e-9);
  });
  if (prevInstanceId === undefined) delete process.env.AGENT_MANAGER_INSTANCE_ID;
  else process.env.AGENT_MANAGER_INSTANCE_ID = prevInstanceId;
});

test('recordCall stores a null instanceId (not a crash) when AGENT_MANAGER_INSTANCE_ID is unset', async () => {
  const dbPath = freshDbPath();
  const prevInstanceId = process.env.AGENT_MANAGER_INSTANCE_ID;
  delete process.env.AGENT_MANAGER_INSTANCE_ID;
  await withFreshDb(dbPath, async ({ recordCall, getCostSummary }) => {
    recordCall({ taskId: 't1', model: 'claude:sonnet', startedAt: new Date().toISOString(), latencyMs: 1, result: { costUsd: 0.05 } });
    const summary = getCostSummary();
    assert.equal(summary.byInstance[0].instanceId, '(unknown)');
  });
  if (prevInstanceId === undefined) delete process.env.AGENT_MANAGER_INSTANCE_ID;
  else process.env.AGENT_MANAGER_INSTANCE_ID = prevInstanceId;
});

test('getCostSummary returns a real (not null) summary even with zero calls recorded yet', async () => {
  const dbPath = freshDbPath();
  await withFreshDb(dbPath, async ({ getCostSummary }) => {
    const summary = getCostSummary();
    assert.equal(summary.totalCostUsd, 0);
    assert.equal(summary.callsWithCost, 0);
    assert.deepEqual(summary.byModel, []);
  });
});

// Migration safety: a database created BEFORE this feature shipped has model_calls with
// no cost_usd column at all -- model-stats-db.js must ALTER TABLE it in, not crash.
test('a pre-existing database with no cost_usd column is migrated cleanly, not crashed on', async () => {
  const dbPath = freshDbPath();
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE model_calls (
      call_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, stage TEXT NOT NULL DEFAULT 'implement',
      model TEXT NOT NULL, candidates TEXT, started_at TEXT NOT NULL, latency_ms INTEGER,
      eval_duration_ns INTEGER, prompt_eval_count INTEGER, eval_count INTEGER, attempts INTEGER,
      degenerate TEXT, call_error TEXT, outcome TEXT, outcome_stage TEXT, outcome_reason TEXT, outcome_at TEXT
    );
  `);
  // A real pre-existing row from before this feature -- must survive the migration untouched.
  db.prepare(`INSERT INTO model_calls (call_id, task_id, model, started_at) VALUES ('old-1', 'old-task', 'qwen3.8:27b-q4_K_M', '2026-08-01T00:00:00.000Z')`).run();
  db.close();

  await withFreshDb(dbPath, async ({ recordCall, getCostSummary }) => {
    recordCall({ taskId: 't-new', model: 'claude:sonnet', startedAt: new Date().toISOString(), latencyMs: 1, result: { costUsd: 5.00 } });
    const summary = getCostSummary();
    assert.equal(summary.totalCostUsd, 5.00);
    assert.equal(summary.freeCalls, 1, 'the pre-existing old row must still be counted, now with a null cost_usd');
  });
});
