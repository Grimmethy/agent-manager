'use strict';

// Thin wrapper around model-stats-db.js's CLI (record-call / record-outcome), letting
// local-draft.js/review-task.js/reject-retry-check.js call it as a normal async function
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
const { estimateApiCostUsd } = require('./anthropic-pricing.js');

const SCRIPT_PATH = path.join(__dirname, 'model-stats-db.js');

function runEvent(event, payload) {
  const tmpPath = path.join(os.tmpdir(), `model-stats-${event}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(payload));
    // --no-warnings: node:sqlite (model-stats-db.js's own DB layer, migrated off
    // better-sqlite3 2026-08-19) emits an ExperimentalWarning on every single invocation
    // otherwise -- harmless, but this call already runs with stdio:'pipe' specifically to
    // stay quiet, and the warning would otherwise land in whatever captures this process's
    // stderr (e.g. local-worker.sh's own log redirect) on every implement/review pass.
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
// reach it through this JS wrapper until ab-model-select.js gave local-draft.js a real
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
    // instanceId (2026-08-23, "Where else would it make sense to track it?" -> Workers
    // tab, per-instance cumulative cost): AGENT_MANAGER_INSTANCE_ID is already a real env
    // var in every worker's process tree (local-worker.sh exports it -- see
    // model-inflight-lock.js's own use of it for the exact same kind of attribution), read
    // directly here rather than threading a new param through all 3 call sites.
    instanceId: process.env.AGENT_MANAGER_INSTANCE_ID || null,
    // costUsd (2026-08-23, Grimmethy: "Do we have any way of knowing how much these
    // tasks would cost using anthropic API?"): claude-client.js's call() has always
    // computed this (Claude Code CLI's own total_cost_usd, a client-side estimate
    // against real Anthropic API pricing, independent of subscription billing) -- it
    // just never reached this far. Undefined/null for every Ornith result (that
    // module's result shape has no costUsd field at all), which is exactly what should
    // happen: a null cost_usd row means "free local call," not "unknown cost."
    costUsd: result && result.costUsd != null ? result.costUsd : null,
    // hypotheticalCostUsd (2026-08-23, Grimmethy: "Clarification on the anthropic costs.
    // I'd like estimates for if we had used the API. Even if we used the local models.")
    // -- costUsd above is real spend for an ACTUAL Claude call and null for a local one;
    // this is "what would THIS call have cost on the API regardless of what actually ran
    // it" -- the real costUsd when this genuinely was a Claude call (no token-count
    // fields exist on that result shape to estimate from, and the real number is already
    // exact), or a token-based estimate (anthropic-pricing.js, against real
    // prompt_eval_count/eval_count Ollama already reports) for a local call. Always
    // populated (never null) so SUM(hypothetical_cost_usd) alone answers "what if
    // everything this period had gone through the API," while SUM(cost_usd) still
    // answers "what did we actually spend" -- two different, both real, questions.
    hypotheticalCostUsd: result && result.costUsd != null
      ? result.costUsd
      : estimateApiCostUsd({
        promptTokens: result && result.prompt_eval_count != null ? result.prompt_eval_count : 0,
        completionTokens: result && result.eval_count != null ? result.eval_count : 0,
      }),
    attempts: result && result.attempts != null ? result.attempts : null,
    degenerate: result && result.degenerate != null ? result.degenerate : null,
  });
  return callId;
}

function recordOutcome({ callId, outcome, outcomeStage, outcomeReason }) {
  if (!callId) return; // matches the reference: no callId (e.g. a pre-drafted task never had an implement-pass call) means nothing to update.
  runEvent('record-outcome', { callId, outcome, outcomeStage, outcomeReason });
}

// Reads back the running Anthropic-API-equivalent cost total (2026-08-23, see
// recordCall's own costUsd comment). Unlike runEvent() above (fire-and-forget,
// stdio:'pipe', built for record-call/record-outcome's write-only shape), this
// captures and parses real stdout -- model-stats-db.js's own `cost-summary` event
// prints JSON: { totalCostUsd, callsWithCost, freeCalls, byModel: [...], byDay: [...] }.
// Same best-effort philosophy as the rest of this file: returns null on any failure
// (missing db, no calls recorded yet) rather than throwing -- a cost dashboard widget
// failing to render is not worth breaking whatever page/report is asking for it.
function getCostSummary() {
  try {
    const stdout = execFileSync('node', ['--no-warnings', SCRIPT_PATH, 'cost-summary'], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    return JSON.parse(stdout);
  } catch (e) {
    return null;
  }
}

module.exports = { recordCall, recordOutcome, getCostSummary };
