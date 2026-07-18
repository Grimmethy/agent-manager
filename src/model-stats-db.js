#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const Database = require('better-sqlite3')

try {
  const dbPath = process.env.AGENT_MANAGER_MODEL_STATS_DB_PATH ||
    path.join(process.env.AGENT_MANAGER_PIPELINE_DIR || process.env.AGENT_MANAGER_REPO_ROOT, 'model-stats.db')

  const db = new Database(dbPath)

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

  const [event, payloadPath] = process.argv.slice(2)
  if (!event || !payloadPath) {
    console.error('Usage: node model-stats-db.js <event> <payloadPath>')
    db.close()
    process.exit(1)
  }

  const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'))

  if (event === 'record-call') {
    db.prepare(`
      INSERT INTO model_calls (
        call_id, task_id, stage, model, candidates, started_at, latency_ms,
        eval_duration_ns, prompt_eval_count, eval_count, attempts, degenerate, call_error
      ) VALUES (
        @callId, @taskId, @stage, @model, @candidates, @startedAt, @latencyMs,
        @evalDurationNs, @promptEvalCount, @evalCount, @attempts, @degenerate, @callError
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
