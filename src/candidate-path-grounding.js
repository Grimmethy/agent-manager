'use strict';

// Deterministic "Check 0" for the candidate-generator grounding checks -- arch_import,
// arch_discovery, deep_dive (concept-candidate-grounding-gate-3e9bec). Their implement
// pass emits a structured write-up with a `Files: a, b, c` line naming destination paths.
// When the model names a path that resolves NOWHERE in the target repo -- not even by
// fact-checker.js's basename walk -- that is not a judgment call and not stochastically
// unlucky: a blind redraft re-invents it (the plan pass proposes fresh search terms each
// attempt, but the model still fabricates the Files: line). Measured cost of discovering
// it the current way: 1 plan + 1 implement + 1 qwen2.5:3b grounding call + a 3-vote
// review round + up to MAX_LOCAL_REJECT_RETRIES blind redraft cycles, each re-fabricating,
// then a human.
//
// This parses ONLY the Files: line (never the Problem/Solution prose, which may mention a
// hypothetical path) and runs the real fs-backed checkFilePaths. The caller turns a
// non-empty `fabricated` list into an `ungrounded` verdict whose reason starts
// "fabricated file path(s): ..."; blocked-task-classifiers.js's `fabricated-file-path`
// classifier then makes that NON-retryable -- straight to needs-clarification, no retry
// budget burned.
//
// Narrow on purpose: only `exists === false` counts. A real file cited with a wrong or
// missing directory prefix (resolvedVia !== 'exact') is a citation nit the existing
// Check 1 / review already handle. A real-but-unsearched file (the "wrong adaptation
// site" case) is out of scope for v1 and stays a retryable `ungrounded` as today.

const { checkFilePaths } = require('./fact-checker.js');

// The `Files:` line of an AC-NNN / deep-dive write-up. Case-insensitive, tolerant of
// leading markdown (`- `, `> `, `**Files:**`). Returns the value string, or '' if absent.
function extractFilesLine(text) {
  const m = String(text || '').match(/^[\s>*_-]*files\s*:[\s*]*(.+?)[\s*]*$/im);
  return m ? m[1].trim() : '';
}

// (filesLine, repoRoot, extraRoots) -> { fabricated: [{claimedPath, exists, ...}], checked: [...] }
// extraRoots is fact-checker.js's own param shape: repoRoot-relative code dirs
// (getConfig().grepAllowedDirs) so `Files: local-client.js` still resolves to
// `src/local-client.js` and is NOT flagged.
function checkCitedPaths(filesLine, repoRoot, extraRoots = []) {
  if (!filesLine || !repoRoot) return { fabricated: [], checked: [] };
  const checked = checkFilePaths(filesLine, repoRoot, extraRoots);
  const fabricated = checked.filter((r) => r.exists === false);
  return { fabricated, checked };
}

function formatFabricatedReason(fabricated) {
  const paths = fabricated.map((f) => f.claimedPath);
  return `fabricated file path(s): ${paths.join(', ')} -- not present anywhere in the target repo. `
    + 'A redraft cannot make an invented path real; re-file with an accurate citation, or archive if nothing applies.';
}

module.exports = { extractFilesLine, checkCitedPaths, formatFabricatedReason };
