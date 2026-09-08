#!/usr/bin/env node
// Requeue Attribution's real storage (2026-09-08) -- a cheap, ungated classifier that
// fires on EVERY requeue across this pipeline, deliberately in its OWN db file, not
// merged into task-links.db (Grimmethy: "the concepts are all going to be related but we
// will likely end up with more concepts similar to requeue attribution that will use the
// task linking [primitive]" -- Task Linking stays a clean, general substrate). Mirrors
// task-links-db.js's own shape exactly, which itself mirrors model-stats-db.js
// (node:sqlite, not better-sqlite3: this checkout's noexec mount fails better-sqlite3's
// native addon dlopen -- see model-stats-db.js's own header). Invoked as a short-lived CLI
// subprocess per write (this codebase's real concurrency-safety mechanism -- no WAL/
// locking needed, just keeping each writer's DB handle open for milliseconds).
//
// idx_requeue_causes_signature is the whole point of this table -- the tally/burn-rate
// query key. Built from day one, not deferred, matching Task Linking's own scale
// correction (this pipeline's task corpus is already ~7,668 records, growing
// ~282-895/day, never pruned).
const fs = require('fs')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')

try {
  const dbPath = process.env.AGENT_MANAGER_REQUEUE_ATTRIBUTION_DB_PATH ||
    path.join(process.env.AGENT_MANAGER_PIPELINE_DIR || process.env.AGENT_MANAGER_REPO_ROOT, 'requeue-attribution.db')

  const db = new DatabaseSync(dbPath)

  db.exec(`
    CREATE TABLE IF NOT EXISTS requeue_causes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      signature TEXT NOT NULL,
      blocked_stage TEXT,
      requeue_writer TEXT NOT NULL,
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_requeue_causes_signature ON requeue_causes(signature);
    CREATE INDEX IF NOT EXISTS idx_requeue_causes_task_id ON requeue_causes(task_id);
  `)

  const [event, payloadPath] = process.argv.slice(2)

  if (!event || !payloadPath) {
    console.error('Usage: node requeue-attribution-db.js record-cause <payloadPath>')
    db.close()
    process.exit(1)
  }

  const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'))

  if (event === 'record-cause') {
    if (!payload.taskId || !payload.signature || !payload.requeueWriter) {
      db.close()
      process.exit(0)
    }
    db.prepare(`
      INSERT INTO requeue_causes (task_id, signature, blocked_stage, requeue_writer, at)
      VALUES (@taskId, @signature, @blockedStage, @requeueWriter, @at)
    `).run({
      taskId: payload.taskId,
      signature: payload.signature,
      blockedStage: payload.blockedStage != null ? payload.blockedStage : null,
      requeueWriter: payload.requeueWriter,
      at: new Date().toISOString(),
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
