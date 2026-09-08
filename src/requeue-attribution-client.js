'use strict';

// Thin wrapper around requeue-attribution-db.js's CLI (record-cause), mirroring
// task-links-client.js's own runEvent()-style split exactly (itself mirroring
// model-stats-client.js). requeue-attribution-db.js can't be require()'d directly -- same
// reason as its siblings: it runs schema-create + dispatch unconditionally at module-load
// time and calls process.exit(), so it has to be invoked as a real subprocess.
//
// Best-effort by design: a classification-write failure must never break real pipeline
// work (a locked db file, a bad payload) -- recordRequeueCause() swallows its own errors,
// same "log-and-continue" contract every sibling client in this codebase already has.
//
// getBurnRate() is a plain read (no destructive side effect), so it opens the db
// in-process read-only rather than shelling out -- same convention task-links-client.js's
// getIncomingLinks/getOutgoingLinks already established. It returns RAW counts per window
// only -- the actual burn-rate tier comparison (Google SRE's dual-window "ticket" tier)
// is policy that belongs in requeue-attribution.js, not this data-access layer.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT_PATH = path.join(__dirname, 'requeue-attribution-db.js');

function resolveDbPath() {
  return process.env.AGENT_MANAGER_REQUEUE_ATTRIBUTION_DB_PATH ||
    path.join(process.env.AGENT_MANAGER_PIPELINE_DIR || process.env.AGENT_MANAGER_REPO_ROOT, 'requeue-attribution.db');
}

function recordRequeueCause({ taskId, signature, blockedStage = null, requeueWriter }) {
  if (!taskId || !signature || !requeueWriter) return;
  const tmpPath = path.join(os.tmpdir(), `requeue-attribution-record-cause-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  try {
    fs.writeFileSync(tmpPath, JSON.stringify({ taskId, signature, blockedStage, requeueWriter }));
    execFileSync('node', ['--no-warnings', SCRIPT_PATH, 'record-cause', tmpPath], { stdio: 'pipe' });
  } catch (e) {
    // Non-fatal -- see header.
  } finally {
    try { fs.unlinkSync(tmpPath); } catch (e) { /* best-effort cleanup */ }
  }
}

// Raw occurrence counts for one signature in each of two rolling windows, ending now.
// { shortCount, longCount } -- burn-rate tier comparison happens in requeue-attribution.js.
function getBurnRate(signature, { shortWindowMs, longWindowMs, now = Date.now() } = {}) {
  const empty = { shortCount: 0, longCount: 0 };
  if (!signature) return empty;
  const dbPath = resolveDbPath();
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch (e) { return empty; }
  if (!fs.existsSync(dbPath)) return empty;
  let db;
  try { db = new DatabaseSync(dbPath, { readOnly: true }); } catch (e) { return empty; }
  try {
    const shortSince = new Date(now - shortWindowMs).toISOString();
    const longSince = new Date(now - longWindowMs).toISOString();
    const shortCount = db.prepare(`SELECT COUNT(*) AS c FROM requeue_causes WHERE signature = ? AND at >= ?`).get(signature, shortSince).c;
    const longCount = db.prepare(`SELECT COUNT(*) AS c FROM requeue_causes WHERE signature = ? AND at >= ?`).get(signature, longSince).c;
    return { shortCount, longCount };
  } catch (e) {
    return empty;
  } finally {
    try { db.close(); } catch (e) { /* best-effort */ }
  }
}

module.exports = { recordRequeueCause, getBurnRate };
