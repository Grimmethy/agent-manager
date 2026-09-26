'use strict';

// Swap point for "how does review-task.js judge a decompose/candidate-split proposal's
// COVERAGE of the original request" (S5c of the hub-tasks extraction, 2026-09-25) -- the
// part S3-a's narrowed scope explicitly deferred (S3-a only extracted the DETECTION
// predicate, hub-review-detection.js's isDecomposeOrSplitProposal; this is the judging
// TEXT injected into the review prompt once a proposal is detected).
//
// Same "default IS the real behavior, always installed" shape as hub-apply-routing.js
// (S2) and apply-branch-prep-route.js (S5b) -- every candidate-split review needs SOME
// coverage judgment, so there is no "unregistered" state.
//
// Moved verbatim from buildVerdictPrompt's inline logic. This is genuinely delicate,
// incident-hardened prompt wording (see the exact incident dates preserved in comments
// below) -- an override must reproduce the same judgments, not just the same shape.
//
// NOTE (found while extracting, not fixed -- a pre-existing behavior, not a regression):
// coverageGuidance/completenessQuestion below key off task.candidateSplitProposals
// specifically, NOT the broader isDecomposeOrSplitProposal predicate hub-review-
// detection.js uses -- so a plain adhoc `RESOLUTION: decompose` (subTaskProposals, no
// candidateSplitProposals) gets the ORIGINAL-REQUEST injection (originalAskInjectionLines
// uses the broader predicate) but neither the specific coverage-judging instruction text
// nor the split-specific completeness question; it falls through to the generic
// real-complete-code question instead. Whether that's intentional or a real gap is a
// separate question from this extraction, which preserves it exactly as found.

// originalAskInjectionLines: lines 372-389's inline logic. isSplitProposal is passed in
// (already resolved via hub-review-detection.js) rather than re-detected here, so this
// module stays a pure "given the detection result, build the text" concern.
function originalAskInjectionLines(task, isSplitProposal) {
  const originalAsk = task.promptContext && (task.promptContext.rawText || task.promptContext.body);
  if (!(isSplitProposal && originalAsk)) return [];
  return [
    '',
    '--- ORIGINAL REQUEST (full text -- the sub-tasks below must TOGETHER cover every concrete deliverable named here) ---',
    String(originalAsk).length > 8000 ? `${String(originalAsk).slice(0, 8000)}\n...[truncated]` : String(originalAsk),
  ];
}

// coverageGuidanceOverride: lines 445-451's inline logic. Returns the override guidance
// text for a hub-routed candidate split, or null when the caller should fall back to the
// source's own registered reviewGuidance (a candidate split's carve-out is more specific
// than any source-level guidance, so it always wins when present).
function coverageGuidanceOverride(task) {
  if (!task.candidateSplitProposals) return null;
  // 2026-08-26, root-caused live via arch-review-ac-4 -- see prompts.js's
  // candidateSplitInstructions and local-draft.js's parseCandidateSplit for the full
  // incident/design. A split proposal deliberately has no diff, and the generic
  // "does it contain real, complete code" completeness question would reject every
  // correct split on sight for exactly that reason.
  return 'This candidate-fulfillment drafter judged the original candidate too large/risky to implement safely in one atomic JSON edit, and produced a JSON array of smaller sub-candidates instead of a diff -- there is deliberately no code or diff here, and that is NOT a reason to reject. Judge ONLY the actual SPLIT in the IMPLEMENT draft below. COVERAGE IS THE MAIN TEST: enumerate every concrete deliverable in the ORIGINAL REQUEST shown above; for each, point at the sub-candidate that delivers it. REJECT if any named deliverable -- especially the core change, not just peripheral pieces -- is left uncovered by every sub-candidate. Then: is each sub-candidate concrete, independently implementable as a single small edit on its own (not still vague, not itself obviously too large)? Does each have a real title/problem/solution, not a placeholder or a bare reference back to the original candidate? Reject if a requirement was dropped, a sub-candidate is too vague/large to actually help, or a sub-candidate is not genuinely well-formed -- never merely because no code was written, and never because splitting wasn\'t strictly necessary (that\'s a judgment call the drafter is allowed to make conservatively).';
}

// completenessQuestionOverride: lines 463-466's inline ternary. Returns the override
// completeness question for a hub-routed candidate split, or null when the caller should
// fall back to the source's own registered reviewCompletenessQuestion (or the generic
// "real, complete code" default).
function completenessQuestionOverride(task) {
  if (!task.candidateSplitProposals) return null;
  // "real, complete code" directly contradicts the split carve-out above, whose whole
  // point is that no code was written yet.
  return 'Does it contain a well-formed JSON array of sub-candidates, each with a real title/problem/solution, that together cover the original candidate with nothing dropped?';
}

const DEFAULT_SPLIT_COVERAGE_JUDGING = {
  originalAskInjectionLines,
  coverageGuidanceOverride,
  completenessQuestionOverride,
};

let current = DEFAULT_SPLIT_COVERAGE_JUDGING;

function getSplitCoverageJudging() {
  return current;
}

// A single swap point, not a registry -- same discipline as every other S1-S5b hook.
// Passing no argument (or a falsy value) restores the default; used by tests to reset
// state between runs since this module is a singleton for the life of the process.
function setSplitCoverageJudging(impl) {
  current = impl || DEFAULT_SPLIT_COVERAGE_JUDGING;
}

module.exports = {
  originalAskInjectionLines,
  coverageGuidanceOverride,
  completenessQuestionOverride,
  DEFAULT_SPLIT_COVERAGE_JUDGING,
  getSplitCoverageJudging,
  setSplitCoverageJudging,
};
