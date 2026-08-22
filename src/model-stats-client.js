'use strict';

// Thin wrapper around model-stats-db.js's CLI (record-call / record-outcome), letting
// ornith-draft.js/review-task.js/reject-retry-check.js call it as a normal async function
// instead of each hand-rolling its own temp-file-plus-execFileSync boilerplate.
// model-stats-db.js itself can't be require()'d directly -- it runs its logic
// unconditionally at module-load time (no `require.main === module` guard) and calls
// process.exit() on error, so it has to be invoked as a real subprocess, matching how the
// reference (Invoke-ModelStatsDb in ornith-worker.ps1/review-runner.ps1/queue-watchdog.ps1)
// always shelled out to it too.
//
// Best-effort by design: stats tracking must never break real pipeline work over a
// recording failure (a locked db file, a bad payload) -- every function here swallows its
// own errors, same "log-and-continue" treatment the reference gives this exact call.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT_PATH = path.join(__dirname, 'model-stats-db.js');

function runEvent(event, payload) {
  const tmpPath = path.join(os.tmpdir(), `model-stats-${event}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(payload));
    // --no-warnings: node:sqlite (model-stats-db.js's own DB layer, migrated off
    // better-sqlite3 2026-08-19) emits an ExperimentalWarning on every single invocation
    // otherwise -- harmless, but this call already runs with stdio:'pipe' specifically to
    // stay quiet, and the warning would otherwise land in whatever captures this process's
    // stderr (e.g. ornith-worker.sh's own log redirect) on every implement/review pass.
    execFileSync('node', ['--no-warnings', SCRIPT_PATH, event, tmpPath], { stdio: 'pipe' });
  } catch (e) {
    // Non-fatal -- see header.
  } finally {
    try { fs.unlinkSync(tmpPath); } catch (e) { /* best-effort cleanup */ }
  }
}

// Call this once per implement-pass model call, right after it completes -- returns a
// fresh callId to store on the task (as task.abCallId) so a later outcome (review verdict,
// watchdog requeue) can be joined back to this same row.
//
// candidates (2026-08-19): the raw LOCAL_AB_MODELS list this call was chosen from, or
// null when no A/B mechanism is active for this call -- model-stats-db.js's schema already
// had this column (the PowerShell reference always populated it), it just had no way to
// reach it through this JS wrapper until ab-model-select.js gave ornith-draft.js a real
// selection to record.
function recordCall({ taskId, stage = 'implement', model, candidates = null, startedAt, latencyMs, result }) {
  const callId = require('crypto').randomUUID();
  runEvent('record-call', {
    callId,
    taskId,
    stage,
    model,
    candidates,
    startedAt,
    latencyMs,
    evalDurationNs: result && result.eval_duration != null ? result.eval_duration : null,
    promptEvalCount: result && result.prompt_eval_count != null ? result.prompt_eval_count : null,
    evalCount: result && result.eval_count != null ? result.eval_count : null,
    attempts: result && result.attempts != null ? result.attempts : null,
    degenerate: result && result.degenerate != null ? result.degenerate : null,
  });
  return callId;
}

function recordOutcome({ callId, outcome, outcomeStage, outcomeReason }) {
  if (!callId) return; // matches the reference: no callId (e.g. a pre-drafted task never had an implement-pass call) means nothing to update.
  runEvent('record-outcome', { callId, outcome, outcomeStage, outcomeReason });
}

module.exports = { recordCall, recordOutcome };
