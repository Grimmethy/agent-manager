'use strict';

// Hard PRE-implementation guard (2026-09-17, needs-clarification bd-1788967312693,
// "pre-implementation timing ambiguity" -- user-selected resolution: run before
// runImplementPass, using the plan's own declared targets).
//
// draft-file-guard.js's missingFileCheck already blocks a fabricated file citation --
// but only AFTER runImplementPass runs, scoped to candidateFulfillment sources whose
// implement response is a structured Group-B diff. That guard saves the critique/
// revision turn, but still spends the full implement pass on a plan that names a file
// that was never real to begin with.
//
// adhoc's plan pass already declares its own edit targets in plain prose
// (adhoc-diff-sanity.js's extractDeclaredTargets -- the same primitive reject-retry-
// check.js's forbidden-path-false-positive rescue already trusts). Checking those
// BEFORE the implement pass is called catches the identical fabrication one stage
// earlier, saving the implement turn too, not just critique.
//
// Scoped to adhoc only, mirroring missingFileCheck's own scoping reasoning: a
// generator-stage source's plan legitimately proposes a not-yet-real target
// (deep_dive/arch_discovery/product_spec_outline) or an external repo's own path, so
// checking declared targets against THIS repoRoot would false-positive there. adhoc
// tasks always target THIS repo's own files.
//
// Pure wrapper -- no draft-pipeline imports -- unit-testable in isolation, same shape
// as draft-file-guard.js.

const { extractDeclaredTargets } = require('./adhoc-diff-sanity.js');
const { checkFilePaths } = require('./fact-checker.js');

// Plain-prose create-mode signal: extractDeclaredTargets has no structured mode:"create"
// marker to read (unlike a Group-B JSON diff), so a declared target that doesn't exist
// yet is only exempt when a creation verb appears in the ~80 chars immediately before
// its mention in the plan text -- narrow/local on purpose, same reasoning as candidate-
// path-grounding.js's own CREATE_MODE_VERBS: a creation verb elsewhere in an unrelated
// sentence must not blanket-exempt every declared target in the plan.
const CREATE_FILE_VERBS_RE = /\b(?:create|creates|creating|add(?:s|ing)?\s+a\s+new\s+file|new\s+file\s+(?:at|named)?)\b[^\n]{0,80}$/i;

// Existence-acknowledgment signal (2026-09-18, pipeline hardening -- confirmed live: a
// task literally titled "Create src/review-parity.test.js" burned 16 real drafting
// attempts because its own plan said, verbatim, "`src/review-parity.test.js` does
// **not** exist yet (confirmed by the orientation report)" -- a model that has just
// verified a target doesn't exist and says so has, in effect, declared it a create
// target, even without using one of CREATE_FILE_VERBS_RE's specific verbs anywhere
// nearby. Unlike the creation-verb check above, this phrasing lands AFTER the path
// mention far more often than before it ("`X` does not exist yet, so this plan will
// create it"), so both directions are checked, not just backward.
// `[\s*_]+` (not plain `\s+`) between words: a model routinely bolds "not" for emphasis
// ("does **not** exist yet") -- confirmed live, this is the EXACT real phrasing that
// caused the incident above, and a literal whitespace-only gap would miss it.
const EXISTENCE_ACK_RE = /\b(?:does|do)[\s*_]+not[\s*_]+(?:yet[\s*_]+)?exist\b|\bdoesn'?t[\s*_]+(?:yet[\s*_]+)?exist\b|\bnot[\s*_]+yet[\s*_]+(?:present|created)\b/i;

function isDeclaredCreateTarget(planText, targetPath) {
  const text = String(planText || '');
  const idx = text.indexOf(targetPath);
  if (idx === -1) return false;
  const before = text.slice(Math.max(0, idx - 80), idx);
  if (CREATE_FILE_VERBS_RE.test(before)) return true;
  const after = text.slice(idx + targetPath.length, idx + targetPath.length + 80);
  return EXISTENCE_ACK_RE.test(before) || EXISTENCE_ACK_RE.test(after);
}

// (task, planText, repoRoot, extraRoots, existsAtRef) -> { blocked, reason?, missing? }
// existsAtRef (optional, injected so this stays a pure wrapper): (claimedPath) => boolean, "does it exist on the branch this task really builds
// on". A STACKED task's files live on its shared branch tip, which the working tree at repoRoot does not show, so a target only that branch has
// is real, not fabricated. It can only RESCUE a path the working-tree check called missing; a throw or a false leaves the verdict unchanged.
function planTargetGuard(task, planText, repoRoot, extraRoots = [], existsAtRef = null) {
  let targets = [];
  try { targets = extractDeclaredTargets(task, planText); } catch { targets = []; }
  if (!targets.length || !repoRoot) return { blocked: false };

  const checked = checkFilePaths(targets.join(', '), repoRoot, extraRoots);
  const missing = checked.filter(
    (entry) => entry.exists === false && !existsOnBranch(existsAtRef, entry.claimedPath) && !isDeclaredCreateTarget(planText, entry.claimedPath),
  );

  if (missing.length === 0) return { blocked: false };

  const paths = missing.map((entry) => entry.claimedPath);
  return {
    blocked: true,
    reason: 'plan cites missing-file target(s): ' + paths.join(', '),
    missing: paths,
  };
}

function existsOnBranch(existsAtRef, claimedPath) {
  if (typeof existsAtRef !== 'function') return false;
  try { return existsAtRef(claimedPath) === true; } catch { return false; }
}

module.exports = { planTargetGuard, isDeclaredCreateTarget };
