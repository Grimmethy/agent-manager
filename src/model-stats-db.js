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

  // hypothetical_cost_usd (2026-08-23, Grimmethy: "I'd like estimates for if we had used
  // the API. Even if we used the local models.") -- cost_usd above is real spend for an
  // ACTUAL Claude call, null for a local one; this is "what would this call have cost on
  // the API regardless of what actually ran it" (the same real cost_usd when it WAS a
  // Claude call, a token-based estimate via anthropic-pricing.js when it wasn't) --
  // always populated, never null, so SUM(hypothetical_cost_usd) alone answers "what if
  // everything this period had gone through the API." Same ALTER-guarded-by-pragma
  // migration shape as cost_usd/instance_id above.
  const hasHypotheticalCostColumn = db.prepare(`SELECT COUNT(*) AS c FROM pragma_table_info('model_calls') WHERE name = 'hypothetical_cost_usd'`).get().c > 0
  if (!hasHypotheticalCostColumn) {
    db.exec(`ALTER TABLE model_calls ADD COLUMN hypothetical_cost_usd REAL`)
  }

  // hostname/platform/gpu_name (2026-08-24, Grimmethy: "We need to start acquiring more
  // models within the system and A/B testing them against certain jobs... Logs should
  // include what hardware/software was used for each test") -- the A/B mechanism
  // (ab-model-select.js, LOCAL_AB_MODELS) and outcome/latency tracking already existed;
  // this was the one real gap -- a call's row said WHICH model ran but nothing about WHERE
  // (which physical box/GPU) or on what OS, both of which matter for comparing candidates
  // fairly across a mixed-hardware fleet. Same ALTER-guarded-by-pragma migration shape as
  // cost_usd/instance_id/hypothetical_cost_usd above.
  const hasHostnameColumn = db.prepare(`SELECT COUNT(*) AS c FROM pragma_table_info('model_calls') WHERE name = 'hostname'`).get().c > 0
  if (!hasHostnameColumn) {
    db.exec(`ALTER TABLE model_calls ADD COLUMN hostname TEXT`)
  }
  const hasPlatformColumn = db.prepare(`SELECT COUNT(*) AS c FROM pragma_table_info('model_calls') WHERE name = 'platform'`).get().c > 0
  if (!hasPlatformColumn) {
    db.exec(`ALTER TABLE model_calls ADD COLUMN platform TEXT`)
  }
  const hasGpuNameColumn = db.prepare(`SELECT COUNT(*) AS c FROM pragma_table_info('model_calls') WHERE name = 'gpu_name'`).get().c > 0
  if (!hasGpuNameColumn) {
    db.exec(`ALTER TABLE model_calls ADD COLUMN gpu_name TEXT`)
  }

  // turns_used/source (2026-08-26, Grimmethy: "add turnsUsed recording... a data point we
  // track for each job type in the Job List itself (min/max/average)" -- the arch-review
  // turn-budget investigation this followed found ZERO telemetry for how many
  // runPlanWithTools() turns a real call actually used, for any caller: local-agentic-
  // draft.js's own multi-turn tier never called record_call() at all, and Chat's calls
  // (chat_sessions.py) recorded latency/tokens but dropped result.turnsUsed on the floor.
  // `source` is deliberately separate from the existing `stage` column -- stage already
  // carries real, distinct meaning (implement/discuss/chat/ghost, the PIPELINE PHASE a
  // call happened in), while `source` is the task-type/job-type (arch_discovery,
  // secondbrain, chat, ...) the Job List tab groups by -- overloading `stage` with both
  // meanings would make neither query clean. Same ALTER-guarded-by-pragma migration shape
  // as every column above.
  const hasTurnsUsedColumn = db.prepare(`SELECT COUNT(*) AS c FROM pragma_table_info('model_calls') WHERE name = 'turns_used'`).get().c > 0
  if (!hasTurnsUsedColumn) {
    db.exec(`ALTER TABLE model_calls ADD COLUMN turns_used INTEGER`)
  }
  const hasSourceColumn = db.prepare(`SELECT COUNT(*) AS c FROM pragma_table_info('model_calls') WHERE name = 'source'`).get().c > 0
  if (!hasSourceColumn) {
    db.exec(`ALTER TABLE model_calls ADD COLUMN source TEXT`)
  }

  const [event, payloadPath] = process.argv.slice(2)
  const NO_PAYLOAD_EVENTS = new Set(['cost-summary', 'turns-summary'])
  if (!event || (!NO_PAYLOAD_EVENTS.has(event) && !payloadPath)) {
    console.error('Usage: node model-stats-db.js <record-call|record-outcome> <payloadPath>')
    console.error('       node model-stats-db.js cost-summary')
    console.error('       node model-stats-db.js turns-summary')
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

    // Hypothetical: "what if EVERY call this pipeline ever made -- including the local
    // ones -- had gone through the Anthropic API" (2026-08-23, Grimmethy: "I'd like
    // estimates for if we had used the API. Even if we used the local models."). Covers
    // every row with a hypothetical_cost_usd value, not just the ones that were actually
    // real Claude calls -- see model-stats-client.js's own recordCall() for how this
    // column is always populated (real cost when it was a real Claude call, a
    // token-based estimate via anthropic-pricing.js otherwise).
    const hasHypotheticalColumn = db.prepare(`SELECT COUNT(*) AS c FROM pragma_table_info('model_calls') WHERE name = 'hypothetical_cost_usd'`).get().c > 0
    let hypothetical = { totalCostUsd: 0, totalCalls: 0, byModel: [], byDay: [] }
    if (hasHypotheticalColumn) {
      const hTotalRow = db.prepare(`SELECT COALESCE(SUM(hypothetical_cost_usd), 0) AS total, COUNT(*) AS calls FROM model_calls WHERE hypothetical_cost_usd IS NOT NULL`).get()
      const hByModel = db.prepare(`
        SELECT model, COALESCE(SUM(hypothetical_cost_usd), 0) AS totalCost, COUNT(*) AS calls
        FROM model_calls WHERE hypothetical_cost_usd IS NOT NULL GROUP BY model ORDER BY totalCost DESC
      `).all()
      const hByDay = db.prepare(`
        SELECT substr(started_at, 1, 10) AS day, COALESCE(SUM(hypothetical_cost_usd), 0) AS totalCost, COUNT(*) AS calls
        FROM model_calls WHERE hypothetical_cost_usd IS NOT NULL GROUP BY day ORDER BY day DESC LIMIT 30
      `).all()
      hypothetical = { totalCostUsd: hTotalRow.total, totalCalls: hTotalRow.calls, byModel: hByModel, byDay: hByDay }
    }

    console.log(JSON.stringify({
      totalCostUsd: totalRow.total,
      callsWithCost: totalRow.callsWithCost,
      freeCalls: freeRow.calls,
      byModel,
      byDay,
      byInstance,
      hypothetical,
    }))
    db.close()
    process.exit(0)
  }

  if (event === 'turns-summary') {
    // Read-only, no payload file needed (same shape as cost-summary above) -- per-source
    // MIN/MAX/AVG(turns_used), for the Job List tab's "is this job type's turn budget
    // actually enough?" question. Only rows that recorded a real turnsUsed count at all
    // (runPlanWithTools()-backed callers) show up; a source with no rows here just means
    // nothing on that path has been instrumented yet, not that it uses zero turns.
    const bySource = db.prepare(`
      SELECT COALESCE(source, '(unknown)') AS source,
        MIN(turns_used) AS minTurns, MAX(turns_used) AS maxTurns,
        AVG(turns_used) AS avgTurns, COUNT(*) AS calls
      FROM model_calls WHERE turns_used IS NOT NULL GROUP BY source ORDER BY source
    `).all()
    console.log(JSON.stringify({ bySource }))
    db.close()
    process.exit(0)
  }

  const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'))

  if (event === 'record-call') {
    db.prepare(`
      INSERT INTO model_calls (
        call_id, task_id, stage, model, candidates, started_at, latency_ms,
        eval_duration_ns, prompt_eval_count, eval_count, attempts, degenerate, call_error, cost_usd, instance_id, hypothetical_cost_usd,
        hostname, platform, gpu_name, turns_used, source
      ) VALUES (
        @callId, @taskId, @stage, @model, @candidates, @startedAt, @latencyMs,
        @evalDurationNs, @promptEvalCount, @evalCount, @attempts, @degenerate, @callError, @costUsd, @instanceId, @hypotheticalCostUsd,
        @hostname, @platform, @gpuName, @turnsUsed, @source
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
      hypotheticalCostUsd: payload.hypotheticalCostUsd != null ? payload.hypotheticalCostUsd : null,
      hostname: payload.hostname != null ? payload.hostname : null,
      platform: payload.platform != null ? payload.platform : null,
      gpuName: payload.gpuName != null ? payload.gpuName : null,
      turnsUsed: payload.turnsUsed != null ? payload.turnsUsed : null,
      source: payload.source != null ? payload.source : null,
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
