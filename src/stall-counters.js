'use strict';

// Daily stall counters for the pipeline (2026-09-08).
//
// Tracks four buckets of stall-related activity, one JSON file per calendar day under
// <pipelineDir>/counters/YYYY-MM-DD.json:
//   - hubs_retired_by_reason:  why a hub was retired (archived / needs-clarification /
//                               design-decision / other)
//   - hubs_restored:            total hubs restored back to active
//   - pieces_escalated_by_rung:  how many stalled pieces were escalated per rung
//   - nc_arrivals_by_category:  new needs-clarification arrivals by category
//   - nc_resolved_by_{bot,re_admit,owner}:  how each needs-clarification was resolved
//   - nc_rerouted_to_blocked:   needs-clarification tasks rerouted into blocked/
//
// Day rollover: when the in-memory cache's active day no longer matches today, the
// previous day's object is flushed to disk and a fresh one is opened.
//
// Archive rollover: days older than 14 are merged into <pipelineDir>/counters/archive.json
// (an array of day objects in chronological order). getRecentDays(n) returns the last N
// days of counter data (merging the live day files with the tail of archive.json) for the
// card to consume.
//
// Best-effort: a write failure here must never break the real stall-tracking call this
// is auditing -- same contract every other audit trail in this codebase holds itself to.

const fs = require('fs');
const path = require('path');

const COUNTERS_SUBDIR = 'counters';
const ARCHIVE_FILENAME = 'archive.json';
const RETENTION_DAYS = 14;

// In-memory cache keyed by date string (YYYY-MM-DD). Each value is the live day object
// plus a flag indicating whether it has been flushed to disk since the last rollover.
const CACHE = new Map();
let activeDate = null;

function pipelineDir() {
  // Mirrors src/config.js's own resolution: AGENT_MANAGER_PIPELINE_DIR overrides
  // AGENT_MANAGER_REPO_ROOT (which itself is required). Same convention every other
  // pipeline-side module uses.
  const repoRoot = process.env.AGENT_MANAGER_REPO_ROOT;
  if (!repoRoot) {
    throw new Error('AGENT_MANAGER_REPO_ROOT env var is required');
  }
  return process.env.AGENT_MANAGER_PIPELINE_DIR || repoRoot;
}

function countersDir(pipelineDirPath) {
  return path.join(pipelineDirPath, COUNTERS_SUBDIR);
}

function today() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function dayFile(pipelineDirPath, date) {
  return path.join(countersDir(pipelineDirPath), `${date}.json`);
}

function archivePath(pipelineDirPath) {
  return path.join(countersDir(pipelineDirPath), ARCHIVE_FILENAME);
}

function emptyDay(date) {
  return {
    date,
    hubs_retired_by_reason: {},
    hubs_restored: { total: 0 },
    pieces_escalated_by_rung: {},
    nc_arrivals_by_category: {},
    nc_resolved_by_bot: 0,
    nc_resolved_by_re_admit: 0,
    nc_resolved_by_owner: 0,
    nc_rerouted_to_blocked: 0,
  };
}

function loadDayFromFile(pipelineDirPath, date) {
  const fp = dayFile(pipelineDirPath, date);
  try {
    const raw = fs.readFileSync(fp, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    return null;
  }
}

function writeDayToFile(pipelineDirPath, date, dayObj) {
  const dir = countersDir(pipelineDirPath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // directory already exists or is otherwise fine
  }
  const fp = dayFile(pipelineDirPath, date);
  fs.writeFileSync(fp, JSON.stringify(dayObj, null, 2));
}

function loadCacheFromDisk(pipelineDirPath) {
  // Populate the in-memory cache from every live day file on disk so rollover
  // works correctly even after a process restart. We do NOT load the archive here --
  // getRecentDays reads the archive separately so the live day files stay cheap to
  // keep in memory.
  const dir = countersDir(pipelineDirPath);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    if (entry.name === ARCHIVE_FILENAME) continue;
    const date = entry.name.replace(/\.json$/, '');
    // Only cache days within the retention window -- older days live in archive.json.
    const d = new Date(date + 'T00:00:00Z');
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - RETENTION_DAYS);
    if (d >= cutoff) {
      const obj = loadDayFromFile(pipelineDirPath, date);
      if (obj) CACHE.set(date, obj);
    }
  }
}

function rotateDay(pipelineDirPath) {
  if (!activeDate) return;
  const dayObj = CACHE.get(activeDate);
  if (dayObj) {
    writeDayToFile(pipelineDirPath, activeDate, dayObj);
  }
  // Check whether the just-closed day has aged out and archive it.
  const d = new Date(activeDate + 'T00:00:00Z');
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - RETENTION_DAYS);
  if (d < cutoff) {
    mergeIntoArchive(pipelineDirPath, dayObj);
    CACHE.delete(activeDate);
  }
  activeDate = today();
  CACHE.set(activeDate, emptyDay(activeDate));
}

function ensureActiveDay(pipelineDirPath) {
  const now = today();
  if (activeDate === now && CACHE.has(now)) return CACHE.get(now);
  // Check disk first so a restart doesn't lose the current day.
  let dayObj = loadDayFromFile(pipelineDirPath, now);
  if (!dayObj) {
    dayObj = emptyDay(now);
  }
  CACHE.set(now, dayObj);
  activeDate = now;
  return dayObj;
}

function mergeIntoArchive(pipelineDirPath, dayObj) {
  const fp = archivePath(pipelineDirPath);
  let arr = [];
  try {
    const raw = fs.readFileSync(fp, 'utf8');
    arr = JSON.parse(raw);
  } catch {
    // file missing or unreadable -- start fresh
  }
  arr.push(dayObj);
  // Keep archive chronological (oldest first).
  arr.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  fs.mkdirSync(countersDir(pipelineDirPath), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(arr, null, 2));
}

// Sweep any day files older than RETENTION_DAYS into archive.json. Called by
// getRecentDays so the archive is always up-to-date when a consumer reads it, and
// idempotent: a day already in archive.json is skipped by the file-exists check.
function sweepArchive(pipelineDirPath) {
  const dir = countersDir(pipelineDirPath);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - RETENTION_DAYS);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    if (entry.name === ARCHIVE_FILENAME) continue;
    const date = entry.name.replace(/\.json$/, '');
    const d = new Date(date + 'T00:00:00Z');
    if (d < cutoff) {
      const obj = loadDayFromFile(pipelineDirPath, date);
      if (obj) {
        mergeIntoArchive(pipelineDirPath, obj);
        try {
          fs.unlinkSync(path.join(dir, entry.name));
        } catch {
          // best-effort
        }
      }
    }
  }
}

/**
 * Return the last N days of counter data in chronological order (oldest first).
 * Merges the tail of archive.json with the live day files that are still within the
 * retention window. Days older than RETENTION_DAYS are never returned here -- they live
 * in archive.json for forensic use only.
 */
function getRecentDays(n) {
  const p = pipelineDir();
  const now = today();
  const result = [];

  // Sweep any stale day files into archive.json before reading it.
  sweepArchive(p);

  // Pull the last N entries from archive.json (which is already chronological).
  let archive = [];
  try {
    const raw = fs.readFileSync(archivePath(p), 'utf8');
    archive = JSON.parse(raw);
  } catch {
    archive = [];
  }

  // Collect live day objects (those still within the retention window).
  const liveDates = [];
  for (const [date, obj] of CACHE) {
    liveDates.push({ date, obj });
  }
  // Also scan disk for any live day files we missed (e.g. process restart).
  const dir = countersDir(p);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    if (entry.name === ARCHIVE_FILENAME) continue;
    const date = entry.name.replace(/\.json$/, '');
    if (!CACHE.has(date)) {
      const obj = loadDayFromFile(p, date);
      if (obj) liveDates.push({ date, obj });
    }
  }

  // Merge archive + live, dedup by date, sort chronological.
  const seen = new Set();
  for (const { date, obj } of archive) {
    if (!seen.has(date)) {
      seen.add(date);
      result.push(obj);
    }
  }
  for (const { date, obj } of liveDates) {
    if (!seen.has(date)) {
      seen.add(date);
      result.push(obj);
    }
  }
  result.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  return result.slice(-n);
}

// ---- Increment writers ----

// Internal: bump a counter in the active day AND flush to disk so the file on disk is
// always up-to-date (the contract every caller relies on: "opens a per-day JSON file,
// increments, writes back"). The in-memory cache is the read path for rapid successive
// calls within the same day -- we never re-read the file, only write it.
function bumpAndFlush(p, day, key, subKey, delta) {
  if (subKey == null) {
    day[key] = (day[key] || 0) + delta;
  } else {
    day[key][subKey] = (day[key][subKey] || 0) + delta;
  }
  // Best-effort write: a failure here must never break the real call.
  try {
    writeDayToFile(p, today(), day);
  } catch {
    // swallow -- audit trail must never break the real call
  }
}

function incrementHubsRetired(reason) {
  const p = pipelineDir();
  const day = ensureActiveDay(p);
  bumpAndFlush(p, day, 'hubs_retired_by_reason', reason, 1);
}

function incrementHubsRestored() {
  const p = pipelineDir();
  const day = ensureActiveDay(p);
  bumpAndFlush(p, day, 'hubs_restored', 'total', 1);
}

function incrementPieceEscalated(rung) {
  const p = pipelineDir();
  const day = ensureActiveDay(p);
  bumpAndFlush(p, day, 'pieces_escalated_by_rung', rung, 1);
}

function incrementNcArrival(category) {
  const p = pipelineDir();
  const day = ensureActiveDay(p);
  bumpAndFlush(p, day, 'nc_arrivals_by_category', category, 1);
}

function incrementNcResolvedByBot() {
  const p = pipelineDir();
  const day = ensureActiveDay(p);
  bumpAndFlush(p, day, 'nc_resolved_by_bot', null, 1);
}

function incrementNcResolvedByReAdmit() {
  const p = pipelineDir();
  const day = ensureActiveDay(p);
  bumpAndFlush(p, day, 'nc_resolved_by_re_admit', null, 1);
}

function incrementNcResolvedByOwner() {
  const p = pipelineDir();
  const day = ensureActiveDay(p);
  bumpAndFlush(p, day, 'nc_resolved_by_owner', null, 1);
}

function incrementNcReroutedToBlocked() {
  const p = pipelineDir();
  const day = ensureActiveDay(p);
  bumpAndFlush(p, day, 'nc_rerouted_to_blocked', null, 1);
}

module.exports = {
  incrementHubsRetired,
  incrementHubsRestored,
  incrementPieceEscalated,
  incrementNcArrival,
  incrementNcResolvedByBot,
  incrementNcResolvedByReAdmit,
  incrementNcResolvedByOwner,
  incrementNcReroutedToBlocked,
  getRecentDays,
  // Exported for testing / manual rollover:
  pipelineDir,
  today,
  rotateDay,
  mergeIntoArchive,
  get CACHE() { return CACHE; },
};
