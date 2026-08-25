'use strict';

// Manual "pause Claude" kill switch (2026-08-25, Grimmethy: "I need a way to pause the
// claude use... preserve the tokens since I know I'm very likely to hit my weekly
// limit" -- a checkbox in the Workers tab's worker-reasoning controls, distinct from
// budget-monitor.js's own REAL rate-limit detection). That module answers "is Claude
// actually rate-limited right now" from Claude Code's own transcripts; this answers "has
// a human explicitly told the pipeline not to spend Claude tokens right now regardless
// of whether it technically still could" -- a deliberate, proactive stop, not a reactive
// one. Both feed into check_budget_healthy()'s single chokepoint (agent-manager-
// common.sh) so every existing Claude-lane gate (the plan-call budget-aware override,
// worker-reasoning's own whole-tick gate, review-runner.sh's per-item gate) respects a
// pause with zero new wiring at those call sites -- but adhoc/research's own IMPLEMENT
// calls bypass ALL of those gates by design (see local-draft.js's own comment on why),
// so local-draft.js checks this module directly before ever reaching draftAdhocImplement/
// draftResearchImplement, the two real Claude-token-heaviest call sites in the whole
// pipeline.
//
// Stored in dashboard-settings.json (same file/convention workerModelOverrides already
// uses, see agent-manager-common.sh's get_model_override and python/dashboard/app.py's
// read_dashboard_settings/write_dashboard_settings) as a plain top-level `claudePaused`
// boolean -- global, not per-instance, matching the user's own framing ("pause the
// claude use," not "pause worker-reasoning specifically") and the fact that adhoc's real
// Claude spend happens on whichever lane's task escalates there, not exclusively
// worker-reasoning.

const fs = require('fs');
const path = require('path');

function settingsPathFor(pipelineDir) {
  return path.join(pipelineDir, 'dashboard-settings.json');
}

// Fails open (false = not paused) on any read/parse error -- same "a check failing here
// must never silently block real work" rule this codebase applies to every other
// best-effort environment read (getConfig()'s own try/catches, check_budget_healthy's
// node error handler). A missing/corrupt settings file must never look like "paused."
function isClaudePaused(pipelineDir) {
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPathFor(pipelineDir), 'utf8'));
    return settings.claudePaused === true;
  } catch (e) {
    return false;
  }
}

module.exports = { isClaudePaused, settingsPathFor };
