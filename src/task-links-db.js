#!/usr/bin/env node
// Task Linking's real storage (2026-09-08) -- a general, forward-only cross-referencing
// primitive for task records, scoped to the WEAK/general "mention" class (see the Task
// Linking concept: NOT a replacement for dependsOn[]/parentHub/decomposedFrom/stacked/
// subTasks[], which stay exactly as they are). Mirrors model-stats-db.js's own established
// shape exactly -- node:sqlite (not better-sqlite3: this checkout's noexec mount fails
// better-sqlite3's native addon dlopen, see model-stats-db.js's own header), invoked as a
// short-lived CLI subprocess per write (this codebase's real concurrency-safety mechanism:
// no WAL/busy_timeout anywhere, just keeping each writer's DB handle open for milliseconds).
//
// idx_task_links_target is the whole point of this table -- the reverse-lookup index a
// scan-and-cache-in-memory approach would have deferred building. Built from day one per
// the concept's own 2026-09-08 scale correction (real corpus already ~7,668 records,
// growing ~282-895/day, never pruned).
const fs = require('fs')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')

try {
  const dbPath = process.env.AGENT_MANAGER_TASK_LINKS_DB_PATH ||
    path.join(process.env.AGENT_MANAGER_PIPELINE_DIR || process.env.AGENT_MANAGER_REPO_ROOT, 'task-links.db')

  const db = new DatabaseSync(dbPath)

  db.exec(`
    CREATE TABLE IF NOT EXISTS task_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      type TEXT NOT NULL,
      label TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_task_links_target ON task_links(target_id);
    CREATE INDEX IF NOT EXISTS idx_task_links_source ON task_links(source_id);
  `)

  const [event, payloadPath] = process.argv.slice(2)

  if (!event || !payloadPath) {
    console.error('Usage: node task-links-db.js record-link <payloadPath>')
    db.close()
    process.exit(1)
  }

  const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'))

  if (event === 'record-link') {
    if (!payload.sourceId || !payload.targetId || !payload.type) {
      db.close()
      process.exit(0)
    }
    db.prepare(`
      INSERT INTO task_links (source_id, target_id, type, label, created_at)
      VALUES (@sourceId, @targetId, @type, @label, @createdAt)
    `).run({
      sourceId: payload.sourceId,
      targetId: payload.targetId,
      type: payload.type,
      label: payload.label != null ? payload.label : null,
      createdAt: new Date().toISOString(),
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
