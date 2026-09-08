'use strict';

// Thin wrapper around task-links-db.js's CLI (record-link), letting real pipeline
// consumers (Requeue Attribution's contributing-task links first, per the confirmed build
// order) call it as a normal function instead of hand-rolling execFileSync boilerplate --
// mirrors model-stats-client.js's own runEvent() split exactly.
// task-links-db.js itself can't be require()'d directly: it runs its own schema-create and
// dispatch logic unconditionally at module-load time (no `require.main === module` guard)
// and calls process.exit() on error/completion, so it has to be invoked as a real
// subprocess -- same reason model-stats-db.js is invoked this way.
//
// Best-effort by design: a link-write failure must never break real pipeline work (a
// locked db file, a bad payload) -- recordLink() swallows its own errors, same
// "log-and-continue" contract model-stats-client.js's runEvent() already has.
//
// Reads (getIncomingLinks/getOutgoingLinks) are NOT subprocess-based -- unlike a write,
// a read has no destructive side effect needing process-per-call isolation, so these open
// the db in-process, read-only, mirroring forensic-bundle.js's/system-report.js's own
// reader convention (new DatabaseSync(dbPath, { readOnly: true }), fail-open to an empty
// result rather than throwing).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT_PATH = path.join(__dirname, 'task-links-db.js');

function resolveDbPath() {
  return process.env.AGENT_MANAGER_TASK_LINKS_DB_PATH ||
    path.join(process.env.AGENT_MANAGER_PIPELINE_DIR || process.env.AGENT_MANAGER_REPO_ROOT, 'task-links.db');
}

// links[] is the WEAK/general "mention" class only -- see the Task Linking concept.
// `type` is a free-text label the caller defines (e.g. 'contributes-to-signature',
// 'relates-to') -- this module doesn't constrain the vocabulary, callers do.
function recordLink({ sourceId, targetId, type, label = null }) {
  if (!sourceId || !targetId || !type) return;
  const tmpPath = path.join(os.tmpdir(), `task-links-record-link-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  try {
    fs.writeFileSync(tmpPath, JSON.stringify({ sourceId, targetId, type, label }));
    execFileSync('node', ['--no-warnings', SCRIPT_PATH, 'record-link', tmpPath], { stdio: 'pipe' });
  } catch (e) {
    // Non-fatal -- see header.
  } finally {
    try { fs.unlinkSync(tmpPath); } catch (e) { /* best-effort cleanup */ }
  }
}

// Reverse lookup -- the whole reason this table's idx_task_links_target index exists.
// "Everything that links TO this task" -- what a Related Tasks section needs.
function getIncomingLinks(targetId) {
  return queryLinks('target_id', targetId);
}

// Forward lookup -- "everything this task links to" -- normally already present as
// task.links[] on the task's own JSON record, but exposed here too for completeness/
// consistency (e.g. a caller with only an id, no task object in hand).
function getOutgoingLinks(sourceId) {
  return queryLinks('source_id', sourceId);
}

function queryLinks(column, value) {
  if (!value) return [];
  const dbPath = resolveDbPath();
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch (e) { return []; }
  if (!fs.existsSync(dbPath)) return [];
  let db;
  try { db = new DatabaseSync(dbPath, { readOnly: true }); } catch (e) { return []; }
  try {
    return db.prepare(`
      SELECT source_id AS sourceId, target_id AS targetId, type, label, created_at AS createdAt
      FROM task_links WHERE ${column} = ? ORDER BY created_at DESC
    `).all(value);
  } catch (e) {
    return [];
  } finally {
    try { db.close(); } catch (e) { /* best-effort */ }
  }
}

module.exports = { recordLink, getIncomingLinks, getOutgoingLinks };
