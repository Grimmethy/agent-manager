#!/usr/bin/env node
// Migrated off better-sqlite3 to node:sqlite (2026-08-19, Grimmethy: building the system-
// report feature turned up that model-stats.db had recorded ZERO calls since
// 2026-08-17T22:53 -- silently, since model-stats-client.js's runEvent() deliberately
// swallows every error here (see that file's own header: "stats tracking must never break
// real pipeline work"). Root cause: better-sqlite3's native .node addon needs to be
// mmap'd with PROT_EXEC, and this package's own checkout lives on a filesystem mounted
// noexec (`mount | grep model-cache/github` -> `noexec`) -- confirmed live, `node -e
// "require('better-sqlite3')"` fails with ERR_DLOPEN_FAILED / "failed to map segment from
// shared object" every single time, exactly matching the silent-swallow shape. node:sqlite
// is a real (if still experimental, per its own runtime warning -- suppressed via
// model-stats-client.js's --no-warnings node flag) part of the Node binary itself, no
// separate compiled addon, so it's immune to this class of mount-flag failure entirely.
const fs = require('fs')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')

try {
  const dbPath = process.env.AGENT_MANAGER_MODEL_STATS_DB_PATH ||
    path.join(process.env.AGENT_MANAGER_PIPELINE_DIR || process.env.AGENT_MANAGER_REPO_ROOT, 'model-stats.db')

  const db = new DatabaseSync(dbPath)

  db.exec(`
    CREATE TABLE IF NOT EXISTS model_calls (
      call_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      stage TEXT NOT NULL DEFAULT 'implement',
      model TEXT NOT NULL,
      candidates TEXT,
      started_at TEXT NOT NULL,
      latency_ms INTEGER,
      eval_duration_ns INTEGER,
      prompt_eval_count INTEGER,
      eval_count INTEGER,
      attempts INTEGER,
      degenerate TEXT,
      call_error TEXT,
      outcome TEXT,
      outcome_stage TEXT,
      outcome_reason TEXT,
      outcome_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_model_calls_task_id ON model_calls(task_id);
    CREATE INDEX IF NOT EXISTS idx_model_calls_model ON model_calls(model);
  `)

  // Migration (2026-08-23, Grimmethy: "Do we have any way of knowing how much these
  // tasks would cost using anthropic API?"): claude-client.js's call() has computed a
  // real per-call cost estimate (Claude Code CLI's own total_cost_usd -- a client-side
  // estimate against real Anthropic API pricing, independent of subscription billing)
  // on every single Claude call this whole time, and nothing downstream ever stored it.
  // CREATE TABLE IF NOT EXISTS above is a no-op against an already-existing table (SQLite
  // doesn't retroactively add columns that way), so an explicit ALTER is needed for
  // every database created before this column existed. ALTER TABLE ADD COLUMN has no
  // native "IF NOT EXISTS" guard in SQLite, so this checks pragma_table_info first --
  // safe to run on every invocation, matching this file's own existing best-effort style.
  const hasCostColumn = db.prepare(`SELECT COUNT(*) AS c FROM pragma_table_info('model_calls') WHERE name = 'cost_usd'`).get().c > 0
  if (!hasCostColumn) {
    db.exec(`ALTER TABLE model_calls ADD COLUMN cost_usd REAL`)
  }

  // instance_id (2026-08-23, same request: "Where else would it make sense to track
  // it?" -> Workers tab, per-instance cumulative cost). AGENT_MANAGER_INSTANCE_ID is
  // already a real env var in every worker's process tree (local-worker.sh exports it
  // for exactly this kind of attribution -- see model-inflight-lock.js's own use of it),
  // it just never reached this table. Same ALTER-guarded-by-pragma migration shape as
  // cost_usd above.
  const hasInstanceColumn = db.prepare(`SELECT COUNT(*) AS c FROM pragma_table_info('model_calls') WHERE name = 'instance_id'`).get().c > 0
  if (!hasInstanceColumn) {
    db.exec(`ALTER TABLE model_calls ADD COLUMN instance_id TEXT`)
  }

  const [event, payloadPath] = process.argv.slice(2)
  if (!event || (event !== 'cost-summary' && !payloadPath)) {
    console.error('Usage: node model-stats-db.js <record-call|record-outcome> <payloadPath>')
    console.error('       node model-stats-db.js cost-summary')
    db.close()
    process.exit(1)
  }

  // cost-summary (2026-08-23, see the migration comment above): read-only, no payload
  // file needed -- prints JSON to stdout, unlike record-call/record-outcome which are
  // fire-and-forget through model-stats-client.js's stdio:'pipe' wrapper. Meant to be
  // called directly (or via system-report.js/the dashboard), not through that wrapper.
  if (event === 'cost-summary') {
    const totalRow = db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS total, COUNT(*) AS callsWithCost FROM model_calls WHERE cost_usd IS NOT NULL`).get()
    const byModel = db.prepare(`
      SELECT model, COALESCE(SUM(cost_usd), 0) AS totalCost, COUNT(*) AS calls
      FROM model_calls WHERE cost_usd IS NOT NULL GROUP BY model ORDER BY totalCost DESC
    `).all()
    const byDay = db.prepare(`
      SELECT substr(started_at, 1, 10) AS day, COALESCE(SUM(cost_usd), 0) AS totalCost, COUNT(*) AS calls
      FROM model_calls WHERE cost_usd IS NOT NULL GROUP BY day ORDER BY day DESC LIMIT 30
    `).all()
    const byInstance = db.prepare(`
      SELECT COALESCE(instance_id, '(unknown)') AS instanceId, COALESCE(SUM(cost_usd), 0) AS totalCost, COUNT(*) AS calls
      FROM model_calls WHERE cost_usd IS NOT NULL GROUP BY instanceId ORDER BY totalCost DESC
    `).all()
    const freeRow = db.prepare(`SELECT COUNT(*) AS calls FROM model_calls WHERE cost_usd IS NULL`).get()
    console.log(JSON.stringify({
      totalCostUsd: totalRow.total,
      callsWithCost: totalRow.callsWithCost,
      freeCalls: freeRow.calls,
      byModel,
      byDay,
      byInstance,
    }))
    db.close()
    process.exit(0)
  }

  const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'))

  if (event === 'record-call') {
    db.prepare(`
      INSERT INTO model_calls (
        call_id, task_id, stage, model, candidates, started_at, latency_ms,
        eval_duration_ns, prompt_eval_count, eval_count, attempts, degenerate, call_error, cost_usd, instance_id
      ) VALUES (
        @callId, @taskId, @stage, @model, @candidates, @startedAt, @latencyMs,
        @evalDurationNs, @promptEvalCount, @evalCount, @attempts, @degenerate, @callError, @costUsd, @instanceId
      )
    `).run({
      callId: payload.callId,
      taskId: payload.taskId,
      stage: payload.stage || 'implement',
      model: payload.model,
      candidates: payload.candidates != null ? payload.candidates : null,
      startedAt: payload.startedAt,
      latencyMs: payload.latencyMs != null ? payload.latencyMs : null,
      evalDurationNs: payload.evalDurationNs != null ? payload.evalDurationNs : null,
      promptEvalCount: payload.promptEvalCount != null ? payload.promptEvalCount : null,
      evalCount: payload.evalCount != null ? payload.evalCount : null,
      attempts: payload.attempts != null ? payload.attempts : null,
      degenerate: payload.degenerate != null ? payload.degenerate : null,
      callError: payload.callError != null ? payload.callError : null,
      costUsd: payload.costUsd != null ? payload.costUsd : null,
      instanceId: payload.instanceId != null ? payload.instanceId : null,
    })
  } else if (event === 'record-outcome') {
    if (!payload.callId) {
      db.close()
      process.exit(0)
    }
    db.prepare(`
      UPDATE model_calls SET outcome=@outcome, outcome_stage=@outcomeStage,
        outcome_reason=@outcomeReason, outcome_at=@outcomeAt WHERE call_id=@callId
    `).run({
      callId: payload.callId,
      outcome: payload.outcome != null ? payload.outcome : null,
      outcomeStage: payload.outcomeStage != null ? payload.outcomeStage : null,
      outcomeReason: payload.outcomeReason != null ? payload.outcomeReason : null,
      outcomeAt: new Date().toISOString(),
    })
  } else {
    console.error(`Unknown event: ${event}`)
    db.close()
    process.exit(1)
  }

  db.close()
} catch (e) {
  console.error(e.message)
  process.exit(1)
}
