'use strict';

// Unified pipeline history log (2026-09-08, Second Brain [[dspy]] research applied --
// dspy.settings.GLOBAL_HISTORY / BaseLM.update_history()): DSPy maintains ONE global,
// bounded history list that every LM call across the ENTIRE program appends to via a
// single update_history() call -- which ALSO fans the SAME entry out to narrower scopes
// (the specific LM's own history, every active calling module's history), so a caller
// gets global AND scoped visibility from one write, not from N independently-maintained
// logs. Before this file existed, agent-manager had reinvented that same 8-line
// try/mkdir/appendFileSync boilerplate 4 separate times (local-client.js's
// logDegenerateAudit + logHardFailureAudit, local-tool-client.js's logContextAudit,
// review-task.js's logFactCheckAudit), each writing to its OWN separate file -- a cross-
// failure-class investigation (exactly what this session's P40/RAM/timeout hunt needed)
// meant manually interleaving up to 4 files by timestamp instead of reading one ordered
// stream. This is the single canonical writer/reader; each of those 4 functions is now a
// thin, backward-compatible wrapper around it (same call signatures, same call sites,
// zero changes needed anywhere else in the codebase) that just supplies its own `type`.
//
// One file, one NDJSON line per event, `type` is the scoping discriminator (mirrors
// DSPy's per-LM/per-module history views being FILTERS over the same underlying stream,
// not separate storage). Best-effort: a write failure here must never break the real
// call this is auditing -- same contract every other audit trail in this codebase holds
// itself to.

const fs = require('fs');
const path = require('path');

const LOG_FILENAME = 'pipeline-history.log';

function logPipelineEvent(pipelineDir, type, entry) {
  try {
    if (!pipelineDir) return;
    const dir = path.join(pipelineDir, 'instances');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, LOG_FILENAME),
      `${JSON.stringify({ at: new Date().toISOString(), type, ...entry })}\n`,
    );
  } catch {
    // best-effort audit trail -- must never break the real call
  }
}

// Reads the unified log back, optionally filtered. `type` accepts a single string or an
// array (a caller investigating "everything that touched this task" across failure
// classes doesn't have to run this once per type and merge results by hand). `taskId`
// and `since` (an ISO string or anything `new Date()` accepts) narrow further. A
// malformed line is skipped, not fatal -- matches every other NDJSON reader in this
// codebase (task-log-reconcile.js's candidateRecords, fact-check-gate-audit.js).
function readPipelineHistory(pipelineDir, { type, taskId, since } = {}) {
  if (!pipelineDir) return [];
  const p = path.join(pipelineDir, 'instances', LOG_FILENAME);
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch {
    return [];
  }
  const types = type == null ? null : (Array.isArray(type) ? type : [type]);
  const sinceMs = since ? new Date(since).getTime() : null;

  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (types && !types.includes(entry.type)) continue;
    if (taskId && entry.taskId !== taskId) continue;
    if (sinceMs != null && new Date(entry.at).getTime() < sinceMs) continue;
    out.push(entry);
  }
  return out;
}

module.exports = { logPipelineEvent, readPipelineHistory, LOG_FILENAME };
