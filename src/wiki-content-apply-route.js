'use strict';

// Swap point for "where does a wiki_content task's real output actually get written."
// wiki_content's target is a separate WikiForge content-space repo (propertyforager-wiki,
// or any other space), never the pipeline's own repoRoot/secondBrainDir -- same non-git
// shape as research/project_search/deep_dive in apply-task.js, but those three are
// core-owned domains with core-owned write helpers. wiki_content is plugin-owned (which
// repo, which page format is entirely the wikiforge content-pipeline plugin's business),
// so core only calls this seam; the wikiforge plugin installs the real implementation via
// setWikiContentApply() at register.js load time (AGENT_MANAGER_REGISTER_PATH).
//
// No default: if no plugin has registered an apply function, apply-task.js's caller
// throws a clear error (see src/apply-task.js) instead of silently doing nothing -- same
// "blocked for a human, naming the real fix" discipline candidate-split-hub-route.js uses.

let current = null;

function getWikiContentApply() {
  return current;
}

// A single swap point, not a registry -- there is exactly one wiki_content apply function
// live at a time. Passing no argument (or a falsy value) clears it back to unregistered;
// used by tests to reset state between runs since this module is a singleton for the life
// of the process.
function setWikiContentApply(fn) {
  current = fn || null;
}

module.exports = { getWikiContentApply, setWikiContentApply };
