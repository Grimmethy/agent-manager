'use strict';

// ONE definition of "the implement pass returned nothing -- what now?", for the four
// sources where an empty response is a documented-legitimate outcome (arch_discovery,
// project_search, deep_dive, arch_import -- resolved via the registry's `emptyApproval`
// flag, so a plugin source that also sets it is covered).
//
// Called two ways, so the decision can never drift between the runtimes again:
//   - review-task.js       -- require() + decideEmptyApprovalOutcome(task) directly
//   - review-runner.ps1    -- `node empty-approval-decision.js <task.json>` (the CLI
//                             below prints 'approve' | 'block' | 'none')
//
// This replaces the earlier per-runtime empty-approve logic AND the
// AGENT_MANAGER_DEEP_DIVE_EMPTY_APPROVE_FAIL kill switch (a blunt "empty always blocks,
// env to revert" flip that had to exist because the old logic couldn't tell the two
// empty cases apart).
//
// The decision (plus 'block-no-context', below):
//   'approve' -- effectively empty AND the harness search that fed this task found real
//                hits (> 0). The model had material and chose to produce nothing, which
//                for these sources IS the documented "reviewed it, nothing actionable"
//                outcome. Deterministic -- no model review vote spent.
//   'block'   -- effectively empty AND the harness search found ZERO hits. Nothing to
//                review, and the anchor search is deterministic against unchanged inputs
//                so a blind requeue only re-derives the same empty grounding -- close it
//                for a human / rescope rather than spin.
//   null      -- not one of these sources, or the response is not effectively empty:
//                this decision does not apply; fall through to the normal review path.

const { getRegisteredSource } = require('./task-source-registry.js');
const { parseArchDiscoveryCandidates } = require('./candidate-docs.js');

// Mirrors review-task.js's own isEffectivelyEmpty / apply-group-a.js's
// isEffectivelyEmptyResponse -- Ornith sometimes emits the two-char JSON empty-string
// literal instead of a truly empty response.
function isEffectivelyEmpty(implementResponse) {
  const t = (implementResponse || '').trim();
  return t === '' || t === '""' || t === "''";
}

function isEmptyApprovalSource(source) {
  const entry = getRegisteredSource(source);
  return !!(entry && entry.emptyApproval);
}

// 2026-09-17 (needs-clarification bd-1788787323412, "if the rule must remain active,
// change the apply-stage contract so a no-candidates draft is short-circuited to
// dismissal before the review vote is consumed"): isEffectivelyEmpty only ever catches a
// LITERAL empty/near-empty string. A candidate-generating source that writes real,
// non-empty prose explaining WHY it found nothing is not effectively empty, so it burns
// a full real majority vote today -- even though src/candidate-docs.js's own
// parseArchDiscoveryCandidates() can already tell, deterministically, that the response
// contains zero parseable "### AC-NNN" candidate blocks, which is exactly what
// src/apply-task.js's apply stage will independently conclude anyway ("no candidates in
// implement response -- nothing to apply").
//
// Deliberately an EXPLICIT opt-in flag (candidateDocFormat: true on the source's own
// registerTaskSource() call), not an inference from emptyApproval/candidateFulfillment --
// tried that first and it was live-wrong: deep_dive and project_search are BOTH
// emptyApproval:true and non-candidateFulfillment, yet neither one's implement response
// uses the "### AC-NNN" candidate-doc format at all (deep_dive writes a free-form
// write-up; project_search has no `apply` key and falls through to the generic Group-B
// git-diff path) -- an inferred check would have wrongly short-circuited every ordinary
// deep_dive/project_search response that doesn't happen to contain that literal heading.
// Only arch_discovery and arch_import (src/arch.js, agent-manager-hygiene) genuinely call
// applyArchDiscoveryCandidates()/applyArchImportCandidate() and set this flag.
function isEffectivelyNoCandidates(source, implementResponse) {
  const entry = getRegisteredSource(source);
  if (!entry || !entry.candidateDocFormat) return false;
  if (isEffectivelyEmpty(implementResponse)) return false; // already the narrower, existing case
  const text = String(implementResponse || '').trim();
  if (!text) return false;
  return parseArchDiscoveryCandidates(text).length === 0;
}

// promptContext.harnessHits (a count, or an array to .length), falling back to
// promptContext.searchResults (array), 0 when neither is present -- identical resolution
// to review-runner.ps1's former $guardHitCount.
function harnessHitCount(task) {
  const ctx = (task && task.promptContext) || {};
  if (typeof ctx.harnessHits === 'number') return ctx.harnessHits;
  if (Array.isArray(ctx.harnessHits)) return ctx.harnessHits.length;
  if (Array.isArray(ctx.searchResults)) return ctx.searchResults.length;
  return 0;
}

// A candidate-doc-format generator (arch_discovery) has no harness SEARCH: its "material" is the
// source files pre-fetched into promptContext.files. Returns that file count for such a source,
// or null when the notion doesn't apply (not a candidateDocFormat source, or no `files` array --
// arch_import carries `itemFiles`, a string), so deep_dive / project_search keep using search hits.
//
// Why: the hit count was always 0 for arch_discovery, so a model that read real files and
// correctly reported "0 friction points" was BLOCKED as if nothing had been searched (2026-09-19,
// PropertyForager community 0), while one handed no files at all looked the same.
function contextFileCount(task) {
  const entry = getRegisteredSource(task && task.source);
  if (!entry || !entry.candidateDocFormat) return null;
  const files = task.promptContext && task.promptContext.files;
  return Array.isArray(files) ? files.length : null;
}

// 'approve' | 'block' | 'block-no-context' | null. 'block-no-context': a candidate-doc source that
// was given ZERO files. ANY draft it produced -- empty or not -- is ungrounded by construction
// (the model saw no code), so it is blocked whatever it says; without this an empty one was a
// silent no-op success and a non-empty one was a hallucinated candidate sent to review
// (AM history: 6 of 20 arch_discovery tasks had zero files; some still produced candidate text).
function decideEmptyApprovalOutcome(task) {
  if (!task || !isEmptyApprovalSource(task.source)) return null;
  const ctxFiles = contextFileCount(task);
  if (ctxFiles === 0) return 'block-no-context';
  const hasMaterial = harnessHitCount(task) > 0 || (ctxFiles !== null && ctxFiles > 0);
  if (isEffectivelyEmpty(task.implementResponse)) {
    return hasMaterial ? 'approve' : 'block';
  }
  // Non-empty text that still parses to zero real candidates -- same approve/block
  // reasoning as the literal-empty case above, just triggered on the broader
  // "nothing the apply stage could act on" condition instead of raw string emptiness.
  if (isEffectivelyNoCandidates(task.source, task.implementResponse)) {
    return hasMaterial ? 'approve' : 'block';
  }
  return null;
}

module.exports = { decideEmptyApprovalOutcome, isEffectivelyEmpty, isEffectivelyNoCandidates, isEmptyApprovalSource, harnessHitCount, contextFileCount };

// CLI: node src/empty-approval-decision.js <task.json>  ->  'approve' | 'block' | 'none'
if (require.main === module) {
  // Populate the source registry (built-ins + AGENT_MANAGER_REGISTER_PATH plugins) so the
  // emptyApproval-source check resolves the same set review-task.js sees.
  require('./task-sources.js');
  try { require('./config.js').ensureRegistered(); } catch { /* best-effort */ }
  let task = {};
  try {
    task = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));
  } catch { /* unreadable -> {} -> 'none' */ }
  // review-runner.ps1 only knows approve|block|none: the no-context block is a block to it.
  const outcome = decideEmptyApprovalOutcome(task);
  process.stdout.write(outcome === 'block-no-context' ? 'block' : (outcome || 'none'));
}
