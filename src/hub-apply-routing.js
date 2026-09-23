'use strict';

// Default hub-apply-routing hook (S2 of the hub-tasks extraction, 2026-09-23).
// apply-task.js's recordApplyOutcome() resolves the stamping it does for a
// `{coordinating: true}` apply result through this overridable bundle instead of
// hardcoding hub-record shape (subTasks/progress init, hubSerial/hubLabel/title,
// parentHub) inline -- a future hub-tasks plugin can supply its own via
// setHubApplyRouting() without apply-task.js needing to know the hub record's shape at
// all. Unlike hub-priority.js's DEFAULT_HUB_ORDER (resolved per source registration,
// since ordering only matters for adhoc/derived_task children), a coordinating result
// can come from ANY source (candidate-split hubs, product-spec hubs, adhoc decompose)
// -- there is no single task-source registration to key this off of, so this is one
// process-wide swap point instead of a per-source registry field.

const { hubTitle } = require('./hub-serial.js');

// Exactly today's inline logic from apply-task.js's recordApplyOutcome, unchanged.
function applyCoordinatingOutcome(task, result) {
  task.subTasks = Array.isArray(result.subTasks) ? result.subTasks : [];
  task.progress = { done: 0, total: task.subTasks.length };
  // HUB#### (hub-serial.js): the hub carries its serial and leads its title with it,
  // replacing a leading candidate id ("AC-2 · ...").
  if (result.hubSerial && result.hubLabel) {
    task.hubSerial = result.hubSerial;
    task.hubLabel = result.hubLabel;
    task.title = hubTitle(result.hubLabel, task.title, task.promptContext && task.promptContext.candidateId);
  }
  // parentHub (2026-09-08): this task IS a hub's own child re-decomposing into a new hub
  // -- promptContext.decomposedFrom already points at the owning hub, zero new plumbing.
  // Lets the dashboard's Hub Tasks tab render the real family tree instead of a root.
  if (task.promptContext && task.promptContext.decomposedFrom) {
    task.parentHub = task.promptContext.decomposedFrom;
  }
}

const DEFAULT_HUB_APPLY_ROUTING = { applyCoordinatingOutcome };

let current = DEFAULT_HUB_APPLY_ROUTING;

function getHubApplyRouting() {
  return current;
}

// A single swap point, not a registry -- there is exactly one hub-apply-routing
// implementation live at a time, same as there is exactly one hub kernel. Passing no
// argument (or a falsy value) restores the default; used by tests to reset state between
// runs since this module is a singleton for the life of the process.
function setHubApplyRouting(routing) {
  current = routing || DEFAULT_HUB_APPLY_ROUTING;
}

module.exports = {
  applyCoordinatingOutcome,
  DEFAULT_HUB_APPLY_ROUTING,
  getHubApplyRouting,
  setHubApplyRouting,
};
