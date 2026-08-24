'use strict';

// Harness-search-first tier for adhoc-domain tasks (2026-08-22, Grimmethy: "expand the
// tooling capabilities so that the local reasoning model can handle the work... I'd like
// to see the automated work being handled entirely locally" -- see queue/blocked/
// adhoc-route-adhoc-tasks-through-the-proven-harness-search-local-pattern-first... for the
// full spec this implements).
//
// local-draft.js's draftTask() currently hardcodes EVERY domain:'adhoc' task through a
// real Claude Code CLI call (adhoc-agentic-draft.js), unconditionally -- because Ornith/
// local Ollama has no tool-calling access via the old /api/generate-only path. But this
// pipeline already has a real, PROVEN local-only alternative for exactly this class of
// problem: pipeline_self_audit (see its own header) runs the SAME "propose search terms,
// harness greps the real repo, ground a blind implement pass" pattern this module reuses.
//
// This is tier 1 of 3 for an adhoc task (see local-draft.js's dispatch): cheap, single-
// shot, no iteration. Tier 2 (local-agentic-draft.js, opt-in) can iterate across multiple
// files; tier 3 (adhoc-agentic-draft.js, real Claude) is the existing, always-available
// fallback. A task that this tier can't confidently ground returns { applied: false } --
// NOT a failure, NOT a block -- so the caller falls through to the next tier exactly as
// before this module existed.
//
// Quality bar for "did this actually produce something real" deliberately reuses this
// pipeline's OWN existing deterministic checks (review-task.js's NON_IMPL_PATTERNS,
// apply-group-a.js's isEffectivelyEmptyResponse) rather than inventing a third, possibly
// inconsistent one.

const { getConfig } = require('./config.js');
const { fetchForQueries: archImportFetch } = require('./arch-import-fetch.js');
const { adhocHarnessSearchPlanPrompt, adhocHarnessSearchImplementPrompt } = require('./prompts.js');
const { captureGroupBDiffInWorktree } = require('./group-b-worktree-diff.js');
const { isEffectivelyEmptyResponse } = require('./apply-group-a.js');
const { NON_IMPL_PATTERNS } = require('./review-task.js');

// Deliberately NOT model-provider.js's labelFor(task) -- adhoc is registered high-tier
// (reasoningTier: 'high', task-sources.js), so labelFor(task) always returns "claude:..."
// for an adhoc task regardless of which backend actually drafted THIS particular attempt.
// This tier only ever runs the local model, so it stamps that real tag directly, same
// explicit-label convention adhoc-agentic-draft.js's own DRAFT_MODEL_LABEL constant
// already uses for its (also tier-independent) Claude stamp.
function localDraftModelLabel() {
  return process.env.LOCAL_MODEL;
}

function extractQueries(planText) {
  return [...(planText || '').matchAll(/^QUERY:\s*(.+)$/gm)].map((m) => m[1].trim()).filter(Boolean);
}

/**
 * Attempts to draft an adhoc task's implementation via the harness-search-first tier.
 * Mutates `task` in place (implementResponse, rawDiff, adhocResolution, draftModel) ONLY
 * on a confident outcome (applied:true, or a confident no-changes-needed) -- an
 * insufficient/degenerate result leaves `task` untouched so the caller's next tier starts
 * from a clean slate, same as if this tier had never run.
 *
 * @param {object} task
 * @param {object} [deps]
 * @param {function} [deps.ornithCall] - Defaults to model-provider.js's providerFor(task).call.
 * @returns {Promise<{applied: boolean, succeeded: boolean, reason?: string}>}
 *   applied:false, succeeded:true -- couldn't confidently ground a change; try the next tier.
 *   applied:true, succeeded:true -- task mutated with a real result (implemented or
 *     confidently no-changes-needed); caller should treat this as done.
 *   succeeded:false -- a hard error (e.g. the worktree/git plumbing itself failed), not a
 *     quality judgment; caller should still fall through to the next tier rather than
 *     block the task outright.
 */
async function draftAdhocViaHarnessSearch(task, { ornithCall } = {}) {
  const { repoRoot, pipelineDir } = getConfig();
  // Deliberately NOT model-provider.js's providerFor(task).call -- adhoc is registered
  // high-tier, so providerFor(task) resolves to Claude by default (unless
  // AGENT_MANAGER_FORCE_PROVIDER=local happens to be set), the exact opposite of what a
  // "try the local model first" tier needs. This tier is the local model, unconditionally
  // -- local-client.js's own call(), same backend runPlanWithTools() (local-tool-client.js)
  // always uses for local-agentic-draft.js's own tier, regardless of any tier/override
  // routing that exists for other purposes entirely.
  const resolvedOrnithCall = ornithCall || require('./local-client.js').call;

  let planResult;
  try {
    planResult = await resolvedOrnithCall({ prompt: adhocHarnessSearchPlanPrompt(task), think: true, temperature: 0.4, numPredict: 800, source: task.source });
  } catch (e) {
    return { applied: false, succeeded: true, reason: `plan call failed: ${e.message}` };
  }
  if (!planResult || planResult.degenerate) {
    return { applied: false, succeeded: true, reason: 'plan pass degenerate or empty' };
  }

  const queries = extractQueries(planResult.response);
  let hits = [];
  let files = [];
  if (queries.length > 0) {
    try {
      const result = archImportFetch(queries);
      hits = result.hits || [];
      files = result.files || [];
    } catch (e) {
      // Non-fatal -- same try/catch treatment pipeline_self_audit's own harness-search
      // branch gives (local-draft.js): implement proceeds with no hits, its own prompt
      // already handles that as "insufficient grounding."
    }
  }

  // No real matches at all -- this tier genuinely cannot confidently ground anything.
  // Deliberately does NOT call the implement model at all in this case (unlike
  // pipeline_self_audit/arch_import, which still ask their implement pass to look at an
  // empty-hits result and decide) -- an adhoc task's wording is far less constrained than
  // a pre-vetted cluster/candidate, so zero hits is a strong enough signal on its own to
  // skip straight to the next tier rather than spend a real implement call likely to
  // either hallucinate or (best case) just say the same "nothing found" thing itself.
  if (hits.length === 0) {
    return { applied: false, succeeded: true, reason: 'harness-search found no real matches in this repo' };
  }

  task.promptContext = task.promptContext || {};
  task.promptContext.harnessHits = hits;
  task.promptContext.harnessFiles = files;

  let implResult;
  try {
    implResult = await resolvedOrnithCall({
      prompt: adhocHarnessSearchImplementPrompt(task, planResult.response),
      think: false,
      temperature: 0.3,
      numPredict: 2800,
      allowEmpty: true,
      source: task.source,
    });
  } catch (e) {
    return { applied: false, succeeded: true, reason: `implement call failed: ${e.message}` };
  }
  if (!implResult || implResult.degenerate) {
    return { applied: false, succeeded: true, reason: 'implement pass degenerate' };
  }

  const responseText = (implResult.response || '').trim();

  // 2026-08-24, Grimmethy: caught live via a real adhoc task ("show a count of
  // observability/architecture tasks in the UI") that exhausted both automatic reject-
  // retries on this exact path, twice, review correctly rejecting it both times for
  // "does not specify any changes... contradicts the task's request" -- because this
  // branch was stamping an empty response as a CONFIDENT, TERMINAL no-changes-needed
  // verdict, directly contradicting what adhocHarnessSearchImplementPrompt's own text
  // promises the model (prompts.js: "output the empty string... a deeper investigation
  // pass will take over next" -- NOT "this ends here"). An empty response here means "I
  // could not confidently ground a change from these hits," the exact same signal as the
  // zero-hits case just above -- not a reasoned decision that nothing needs to change.
  // adhoc-agentic-draft.js's real no-changes-needed mechanism (a full explained response
  // plus an explicit `RESOLUTION: no-changes-needed` marker) is what a genuine, grounded
  // "nothing to do here" verdict actually looks like in this codebase; a bare empty
  // string was never that, and treating it as if it were skipped the Claude tier this
  // exact case exists for, wasting the task's limited automatic-retry budget on a tier
  // that had already told the model it wasn't confident enough to answer.
  if (isEffectivelyEmptyResponse(responseText)) {
    return { applied: false, succeeded: true, reason: 'implement pass found insufficient grounding to confidently draft a change (empty response, per its own prompt\'s contract)' };
  }

  // A "let me read/check/..." hedge (NON_IMPL_PATTERNS) means the model itself is
  // signaling it needs more than a few grep queries can ground -- exactly the
  // "genuinely needs multi-file investigation" case the next tier exists for.
  if (NON_IMPL_PATTERNS.some((pat) => pat.test(responseText))) {
    return { applied: false, succeeded: true, reason: 'implement pass signaled it needs deeper investigation than harness-search can ground' };
  }

  let rawDiff;
  try {
    rawDiff = captureGroupBDiffInWorktree({
      repoRoot, pipelineDir, implementResponse: responseText, worktreeSuffix: `harness-${task.id}`,
    });
  } catch (e) {
    // Invalid/inapplicable Group-B JSON -- not confident enough to use; fall through.
    return { applied: false, succeeded: true, reason: `harness-search draft did not apply cleanly: ${e.message}` };
  }

  if (!rawDiff) {
    return { applied: false, succeeded: true, reason: 'harness-search draft produced no net change' };
  }

  task.adhocResolution = 'implemented';
  task.rawDiff = rawDiff;
  task.implementResponse = `Harness-search tier (local model, grounded in ${hits.length} real match(es)).\n\n=== DIFF ===\n${rawDiff}`;
  task.draftModel = localDraftModelLabel();
  return { applied: true, succeeded: true };
}

module.exports = { draftAdhocViaHarnessSearch, extractQueries };
