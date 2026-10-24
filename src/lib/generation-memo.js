'use strict';

// generation-memo.js -- the "nothing to offer" memo store (HUB0194 2/5).
//
// Generation (getNextTask) asks every source for work on every tick; a source that has
// looked at its input and genuinely has nothing to offer (no new work, empty queue, no
// new commits...) is pointless to re-poll for ~10 minutes. This module remembers, per
// sourceId, the source's `fingerprint()` (subtask 2 -- a deterministic string the source
// computes from what it actually reads, or null if it cannot) at the moment it had
// nothing to offer. While that fingerprint keeps matching and the entry is unexpired,
// callers (subtask 4, the getNextTask instrumentation) skip the source entirely.
//
// Storage: ONE small JSON file, generation-memo.json, in the SAME directory as
// pipeline-history.log (i.e. <pipelineDir>/instances/ -- see pipeline-history.js's
// logPipelineEvent, which joins pipelineDir + 'instances'). Format contract (defined
// here, consumed by subtask 3's tests):
//
//   { "version": 1,
//     "entries": { "<sourceId>": { "fingerprint": "<string|null>", "recordedAt": "<ISO-8601>" } } }
//
// Writes are atomic (temp file + rename) via atomic-write.js's writeJsonAtomicSync --
// the same primitive the rest of the codebase uses so a mid-write crash can never leave
// a truncated, unparseable state file. The only path construction in this module is
// getMemoPath(): no caller can redirect the memo file anywhere outside the pipeline dir.
//
// Kill switch / TTL come straight off process.env (subtask 0 defines the same names):
//   AGENT_MANAGER_GENERATION_MEMO        'false' disables ALL memo logic (default on)
//   AGENT_MANAGER_GENERATION_MEMO_TTL_MS default 600000 (10 min), overridable
//
// Best-effort contract: readMemo never throws (missing/corrupt file = empty store);
// recordMemo/clearMemo swallow write failures and return false. A memo is a cache --
// failing to record or clear one must never break the generation tick itself, same
// discipline as every audit trail in this codebase (pipeline-history.js, local-client.js).

const fs = require('fs');
const path = require('path');
const { writeJsonAtomicSync } = require('../atomic-write.js');

const MEMO_FILENAME = 'generation-memo.json';
const MEMO_VERSION = 1;
const DEFAULT_TTL_MS = 600000; // 10 minutes

// Tolerant pipelineDir derivation, exactly the local-client.js:resolvePipelineDir
// pattern (NOT config.js's getConfig(), which hard-throws when AGENT_MANAGER_REPO_ROOT
// is unset -- requiring this module in a test without a full pipeline env must not crash).
// If neither var is set there is no pipeline dir, and there is nowhere this module is
// ALLOWED to write, so it degrades to a no-op store rather than picking a fallback.
function resolvePipelineDir(pipelineDir) {
  if (pipelineDir) return pipelineDir;
  const repoRoot = process.env.AGENT_MANAGER_REPO_ROOT;
  if (!repoRoot) return null;
  return process.env.AGENT_MANAGER_PIPELINE_DIR || repoRoot;
}

// Kill switch: 'false' (any case, trimmed) disables memo logic; everything else --
// including unset -- leaves it on. Read at call time so tests can flip it.
function isMemoEnabled() {
  return String(process.env.AGENT_MANAGER_GENERATION_MEMO || '').trim().toLowerCase() !== 'false';
}

// TTL in ms: positive integer, default 600000. Garbage values fall back to the default
// rather than throwing (a memo store must never take generation down over a typo'd env).
function getTtlMs() {
  const raw = String(process.env.AGENT_MANAGER_GENERATION_MEMO_TTL_MS || '').trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_TTL_MS;
}

// The ONLY place a memo file path is constructed in this module: always the pipeline
// dir's instances/ subdir (same dir as pipeline-history.log), never any caller-supplied
// location, so memo state can never be written outside the pipeline dir.
function getMemoPath(pipelineDir) {
  const dir = resolvePipelineDir(pipelineDir);
  if (!dir) return null;
  return path.join(dir, 'instances', MEMO_FILENAME);
}

// Read + parse the memo file. Missing, unreadable, or corrupt (wrong shape, not
// JSON) all yield the empty default store -- never throws.
function readMemo(pipelineDir) {
  const empty = { version: MEMO_VERSION, entries: {} };
  const file = getMemoPath(pipelineDir);
  if (!file) return empty;
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return empty;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (!data || typeof data !== 'object' || typeof data.version !== 'number' ||
      !data.entries || typeof data.entries !== 'object' || Array.isArray(data.entries)) {
    return empty;
  }
  return { version: data.version, entries: data.entries };
}

// Write the whole store back atomically (temp file + rename via writeJsonAtomicSync).
// Validates the shape first so a malformed store can never land on disk. Throws on
// write failure -- callers (recordMemo/clearMemo) decide how best-effort to be.
function writeMemo(data, pipelineDir) {
  if (!data || typeof data !== 'object' || typeof data.version !== 'number' ||
      !data.entries || typeof data.entries !== 'object' || Array.isArray(data.entries)) {
    throw new Error('writeMemo: data must be { version: <number>, entries: <object> }');
  }
  const file = getMemoPath(pipelineDir);
  if (!file) throw new Error('writeMemo: no pipeline dir resolved (set AGENT_MANAGER_PIPELINE_DIR or AGENT_MANAGER_REPO_ROOT)');
  writeJsonAtomicSync(file, { version: data.version, entries: data.entries });
}

// Record "sourceId had nothing to offer, and here is what it read (its fingerprint)".
// No-op returning false when the kill switch is off or the write fails (best-effort).
function recordMemo(sourceId, fingerprint, pipelineDir) {
  if (!isMemoEnabled()) return false;
  if (sourceId == null || sourceId === '') return false;
  try {
    const store = readMemo(pipelineDir);
    store.entries[String(sourceId)] = {
      fingerprint,
      recordedAt: new Date().toISOString(),
    };
    writeMemo(store, pipelineDir);
    return true;
  } catch {
    return false;
  }
}

// True only when sourceId was recently memoed WITH this exact fingerprint and the entry
// has not expired. Different fingerprint (source's input changed -> re-poll it!), missing
// entry, or expired entry all return false. False (not throw) when disabled.
function isMemoed(sourceId, fingerprint, pipelineDir) {
  if (!isMemoEnabled()) return false;
  const entry = readMemo(pipelineDir).entries[String(sourceId)];
  if (!entry) return false;
  if (entry.fingerprint !== fingerprint) return false;
  const at = Date.parse(entry.recordedAt);
  if (!Number.isFinite(at)) return false;
  return Date.now() - at < getTtlMs();
}

// Forget sourceId (e.g. after it finally produced work). No-op returning false when
// disabled, the entry is absent, or the write fails.
function clearMemo(sourceId, pipelineDir) {
  if (!isMemoEnabled()) return false;
  const store = readMemo(pipelineDir);
  const key = String(sourceId);
  if (!(key in store.entries)) return false;
  delete store.entries[key];
  try {
    writeMemo(store, pipelineDir);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  MEMO_FILENAME,
  MEMO_VERSION,
  DEFAULT_TTL_MS,
  isMemoEnabled,
  getTtlMs,
  getMemoPath,
  readMemo,
  writeMemo,
  recordMemo,
  isMemoed,
  clearMemo,
};
