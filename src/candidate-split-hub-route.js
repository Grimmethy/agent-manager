'use strict';

// Swap point for "how does a hub-routed candidate split become a real coordinator hub"
// (S4b of the hub-tasks extraction, producer 4, 2026-09-25). lib/apply-core.js's
// writeArtifact used to call apply-adhoc-diff.js's applyCandidateSplitAsHub directly; that
// function (and its candidateSplitToSubTasks helper) moved to the agent-manager-hub-tasks
// plugin, which installs itself here via setCandidateSplitHubFiler() at register.js load
// time (AGENT_MANAGER_REGISTER_PATH). queueSubTasks itself -- the hub kernel primitive both
// this and adhoc-decompose call -- stays in apply-adhoc-diff.js until S5.
//
// This is a narrower, scoped-down precursor to the fuller hub-intake hook
// Docs/hub-tasks-extraction-plan.md section 3 describes and defers to S5 (which will also
// cover producer 1, adhoc decompose, and generalizes the shape beyond candidate splits).
// Built now, ahead of that plan's original "don't build before S5 needs it" note, because
// S4b turned out to need it to actually move producer 4's code out -- see that doc's S4b
// row for the correction.
//
// No default: if no plugin has registered a filer, writeArtifact throws a clear error
// (see lib/apply-core.js) instead of silently doing nothing or resurrecting the old inline
// code. Same "blocked for a human, naming the real fix" discipline the plan's hub-intake
// degrade-behavior note describes.

let current = null;

function getCandidateSplitHubFiler() {
  return current;
}

// A single swap point, not a registry -- there is exactly one candidate-split-hub filer
// live at a time. Passing no argument (or a falsy value) clears it back to unregistered;
// used by tests to reset state between runs since this module is a singleton for the life
// of the process.
function setCandidateSplitHubFiler(filer) {
  current = filer || null;
}

module.exports = { getCandidateSplitHubFiler, setCandidateSplitHubFiler };
