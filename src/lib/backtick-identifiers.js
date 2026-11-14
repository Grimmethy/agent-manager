'use strict';

// Leaf module (no imports): shared by task-anchor-files.js (re-exports it) and fact-checker.js. It lives here so those two files do not require each other
// (roadmap step 1, piece P1; the cycle ratchet is scripts/import-cycles.js).

// Just the backtick-quoted names -- the task author's own EXPLICIT symbol list (as
// opposed to taskIdentifiers' broader heuristic sweep below), highest-confidence because
// it required no guessing to extract. adhocHarnessSearchPlanPrompt (prompts.js) uses this
// to steer the harness-search tier's query choice toward these over a bare file path --
// 2026-09-06, root-caused live: a file-decompose "move these symbols" sub-task (rawText
// names its symbols in backticks) had the harness-search plan pass choose the SOURCE
// FILE'S OWN PATH as its query instead of any of the named symbols -- a generically
// common path (mentioned in dozens of unrelated tests/docs/scripts) returned almost pure
// noise, one irrelevant unrelated file got embedded as "the" fetched content, and the
// resulting bloated, low-signal context contributed to the plan pass truncating on every
// retry (see local-client.js's call() truncation-escalation fix for the other half of
// that incident).
function backtickIdentifiers(rawText) {
  const out = new Set();
  for (const m of rawText.matchAll(/`([A-Za-z_][\w.]*(?:\(\))?)`/g)) out.add(m[1].replace(/\(\)$/, ''));
  return [...out];
}

module.exports = { backtickIdentifiers };
