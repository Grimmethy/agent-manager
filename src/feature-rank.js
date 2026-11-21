'use strict';

// feature-rank.js -- a shared rank map for the Feature Forge sortable feature list.
//
// One JSON file in the shared instances dir holds the current slug->rank map:
//   {ranks: {<slug>: <integer>}, receivedAt: <ISO>, count: <n>}
//
// The only event that rewrites it is the Feature Forge push (POST /api/feature-rank).
// No timer, no poll. Lanes read it live at claim time (next-claimable-task.js).
//
// Contract:
//   writeRankMap(map, now) -- validate, then atomically replace the whole file.
//                              Throws on invalid payload; old file untouched on error.
//   readRankMap()            -- mtime-cached read. Never throws. Returns {ok, ...}.
//   rankForSlug(slug)        -- integer rank or null.
//   syncStatus()             -- {synced, reason, receivedAt, count}.
//
// Audit trail: when the read state changes (ok <-> missing/unreadable/empty) we
// append ONE JSON line to feature-rank-audit.log. Identical consecutive states
// are skipped -- a busy tick re-evaluating the same queue must not grow the log.

const fs = require('fs');
const path = require('path');
const { writeJsonAtomicSync } = require('./atomic-write.js');
const { sharedInstancesDir } = require('./instances-dir.js');

const FILE_NAME = 'feature-rank.json';
const AUDIT_FILE = 'feature-rank-audit.log';
const MAX_ENTRIES = 5000;

// Module-level mtime cache so a tick that finds the file unchanged pays one stat
// and skips JSON.parse. Mirrors queue-cache.js's same-mtime fast path.
let cachedMtimeMs = 0;
let cachedData = null;

// Audit state: track last state to dedup consecutive identical writes.
// States are: 'ok' | 'missing' | 'unreadable' | 'empty'
let lastAuditState = null;

function getInstancesDir(pipelineDir) {
  return sharedInstancesDir(pipelineDir || process.cwd());
}

function getRankMapPath(pipelineDir) {
  return path.join(getInstancesDir(pipelineDir), FILE_NAME);
}

function getAuditLogPath(pipelineDir) {
  return path.join(getInstancesDir(pipelineDir), AUDIT_FILE);
}

// ---- Validation ----

function validateMap(map) {
  if (map === null || typeof map !== 'object' || Array.isArray(map)) {
    throw new Error('feature-rank: map must be a plain object');
  }
  const keys = Object.keys(map);
  if (keys.length === 0) {
    throw new Error('feature-rank: map must not be empty');
  }
  if (keys.length > MAX_ENTRIES) {
    throw new Error(`feature-rank: map exceeds ${MAX_ENTRIES} entries (got ${keys.length})`);
  }
  for (const key of keys) {
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error(`feature-rank: slug must be a non-empty string (got ${JSON.stringify(key)})`);
    }
    const val = map[key];
    if (typeof val !== 'number' || !Number.isInteger(val)) {
      throw new Error(`feature-rank: rank for "${key}" must be an integer (got ${JSON.stringify(val)})`);
    }
  }
}

function validateNow(now) {
  let d;
  if (now instanceof Date) {
    d = now;
  } else if (typeof now === 'string') {
    d = new Date(now);
  } else {
    throw new Error('feature-rank: now must be a Date or ISO string');
  }
  if (isNaN(d.getTime())) {
    throw new Error('feature-rank: now is not a valid date');
  }
  return d;
}

// ---- Audit writer (deduped) ----

function emitAudit(pipelineDir, state, reason) {
  if (state === lastAuditState) return; // dedup: identical consecutive state
  lastAuditState = state;
  try {
    const auditPath = getAuditLogPath(pipelineDir);
    const dir = path.dirname(auditPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(auditPath, JSON.stringify({ ts: new Date().toISOString(), state, reason }) + '\n');
  } catch {
    // best-effort audit trail -- must never break the real call
  }
}

// ---- Public API ----

/**
 * Validate and atomically write the rank map.
 * @param {Object<string, number>} map - slug -> integer rank
 * @param {Date|string} now - timestamp to stamp the file with
 * @returns {Object} {ok: true, path, receivedAt, count}
 * @throws {Error} on invalid payload; old file untouched
 */
function writeRankMap(map, now, pipelineDir) {
  validateMap(map);
  const date = validateNow(now);
  const file = getRankMapPath(pipelineDir);
  const payload = {
    ranks: map,
    receivedAt: date.toISOString(),
    count: Object.keys(map).length,
  };
  writeJsonAtomicSync(file, payload);
  // Invalidate cache on successful write
  cachedMtimeMs = 0;
  cachedData = null;
  emitAudit(pipelineDir, 'ok', 'written');
  return { ok: true, path: file, receivedAt: payload.receivedAt, count: payload.count };
}

/**
 * Read the rank map. Never throws.
 * @returns {Object} {ok: boolean, ranks?: Object, receivedAt?: string, count?: number, reason?: string}
 */
function readRankMap(pipelineDir) {
  const file = getRankMapPath(pipelineDir);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    emitAudit(pipelineDir, 'missing', 'no file');
    return { ok: false, reason: 'missing' };
  }
  const mtimeMs = stat.mtimeMs;
  // Mtime cache: skip parse if file unchanged
  if (mtimeMs === cachedMtimeMs && cachedData !== null) {
    return {
      ok: true,
      ranks: cachedData.ranks,
      receivedAt: cachedData.receivedAt,
      count: cachedData.count,
      reason: 'cached',
    };
  }
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    emitAudit(pipelineDir, 'unreadable', 'read failed');
    return { ok: false, reason: 'unreadable' };
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    emitAudit(pipelineDir, 'unreadable', 'invalid JSON');
    return { ok: false, reason: 'unreadable' };
  }
  if (!data || typeof data !== 'object' || !data.ranks || typeof data.ranks !== 'object' || Array.isArray(data.ranks)) {
    emitAudit(pipelineDir, 'empty', 'missing ranks');
    return { ok: false, reason: 'empty' };
  }
  if (typeof data.receivedAt !== 'string' || typeof data.count !== 'number') {
    emitAudit(pipelineDir, 'empty', 'malformed metadata');
    return { ok: false, reason: 'empty' };
  }
  // Update cache
  cachedMtimeMs = mtimeMs;
  cachedData = { ranks: data.ranks, receivedAt: data.receivedAt, count: data.count };
  emitAudit(pipelineDir, 'ok', 'read');
  return {
    ok: true,
    ranks: data.ranks,
    receivedAt: data.receivedAt,
    count: data.count,
    reason: 'read',
  };
}

/**
 * Look up a single slug in the rank map.
 * @param {string} slug
 * @param {string} [pipelineDir]
 * @returns {number|null}
 */
function rankForSlug(slug, pipelineDir) {
  if (!slug || typeof slug !== 'string') return null;
  const state = readRankMap(pipelineDir);
  if (!state.ok || !state.ranks || !(slug in state.ranks)) return null;
  const v = state.ranks[slug];
  return (typeof v === 'number' && Number.isInteger(v)) ? v : null;
}

/**
 * Current sync status of the rank map.
 * @param {string} [pipelineDir]
 * @returns {Object} {synced: boolean, reason?: string, receivedAt?: string, count?: number}
 */
function syncStatus(pipelineDir) {
  const state = readRankMap(pipelineDir);
  return {
    synced: state.ok,
    reason: state.reason,
    receivedAt: state.receivedAt,
    count: state.count,
  };
}

module.exports = {
  writeRankMap,
  readRankMap,
  rankForSlug,
  syncStatus,
  // Exposed for testing / introspection
  _resetCache() { cachedMtimeMs = 0; cachedData = null; },
  _resetAudit() { lastAuditState = null; },
  _getRankMapPath: getRankMapPath,
  _getAuditLogPath: getAuditLogPath,
};
