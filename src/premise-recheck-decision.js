'use strict';

// Deterministic re-validation for a candidate-fulfillment "_fix" task's own "FALSE
// POSITIVE" refusal (2026-09-18, following up on today's exhaustion-escalation fix,
// PR #322 -- brain-dump bd-1789602379616: "observability_fix candidates target code
// that has ALREADY BEEN FIXED by unrelated work... the model's own 'FALSE POSITIVE'
// refusal was CORRECT in every case checked, but the task still gets blocked").
//
// prompts.js's groupBJsonInstructions asks every candidate-fulfillment source to output
// the literal line `FALSE POSITIVE -- <justification>` when the finding no longer
// applies -- a documented, first-class "nothing to do" outcome, not a malformed draft.
// But nothing downstream ever checked whether that claim is TRUE before deciding what to
// do with it: review-task.js's isNonImplementation gate treats a short, code-fence-free
// response as "not a real implementation attempt" and blocks it outright (neither source
// is emptyApproval/advisoryProse, the two flags that exempt a source from that gate) --
// so a CORRECT false-positive claim gets rejected exactly like a genuinely bad draft,
// burns a retry, and (since PR #322) eventually escalates to a human who has to
// rediscover independently what the model already correctly determined.
//
// observability_fix/performance_fix candidates are, by construction, always sourced from
// their sibling *_review source's own deterministic scanner rules (agent-manager-hygiene's
// deterministic-recheck.js registers those exact rules into deterministic-recheck-
// registry.js for staleness_audit's own use) -- so re-running that SAME rule set against
// the candidate's cited file's CURRENT content answers "is this still a real finding" with
// no model call and no guessing. Deliberately whole-file, not location-specific: since
// every candidate's complaint IS one of the registered rule's finding types, if the rule
// set finds NOTHING anywhere in the file, it necessarily didn't find the original
// complaint either -- a conservative signal that can never wrongly approve a candidate
// whose own problem is still present (it would have been re-found), only ever leaves a
// genuinely-resolved one in play for a fresh redraft in the rare case this can't verify.
//
// A source opts in with an explicit `premiseRecheckSource` flag on its own
// registerTaskSource() entry (e.g. 'observability_review' for observability_fix) --
// deliberately not derived from the source's own name (candidateFulfillment "_fix"
// sources don't follow one consistent "_fix" -> "_review" naming pattern across this
// codebase: pipeline_forensics_fix's sibling is pipeline_forensics, not
// pipeline_forensics_review; change_review_fix's is change_review, not
// change_review_review).

const fs = require('fs');
const { getRegisteredSource } = require('./task-source-registry.js');
const { getDeterministicRecheck } = require('./deterministic-recheck-registry.js');
const { resolveAgainstRepoDetailed } = require('./fact-checker.js');

const FALSE_POSITIVE_RE = /^FALSE POSITIVE\b/i;

function isFalsePositiveResponse(implementResponse) {
  return FALSE_POSITIVE_RE.test(String(implementResponse || '').trim());
}

// task, { repoRoot, extraRoots } -> 'approve' | null
// null means "no opinion" (not opted in, no cited files, can't read a file, or the
// rule set still finds something) -- the caller falls through to its normal review path.
function decidePremiseRecheckOutcome(task, { repoRoot, extraRoots = [] } = {}) {
  if (!task || !isFalsePositiveResponse(task.implementResponse)) return null;

  const entry = getRegisteredSource(task.source);
  const recheckSourceName = entry && entry.premiseRecheckSource;
  if (!recheckSourceName) return null;

  const recheck = getDeterministicRecheck(recheckSourceName);
  const perFileRules = recheck && recheck.perFileRules;
  if (!perFileRules || Object.keys(perFileRules).length === 0) return null;

  const files = (task.promptContext && Array.isArray(task.promptContext.files)) ? task.promptContext.files : [];
  if (!files.length || !repoRoot) return null;

  for (const claimedPath of files) {
    const { resolvedPath } = resolveAgainstRepoDetailed(repoRoot, claimedPath, extraRoots);
    if (!resolvedPath) return null; // can't verify a path that doesn't resolve -- don't guess
    let text;
    try {
      text = fs.readFileSync(resolvedPath, 'utf8');
    } catch {
      return null; // unreadable -- advisory, don't guess
    }
    for (const ruleName of Object.keys(perFileRules)) {
      let findings;
      try {
        findings = perFileRules[ruleName](text, claimedPath) || [];
      } catch {
        return null; // a rule erroring on this file's current content isn't a "resolved" signal
      }
      if (findings.length > 0) return null; // still a real finding somewhere in the file -- not resolved
    }
  }

  return 'approve';
}

module.exports = { decidePremiseRecheckOutcome, isFalsePositiveResponse };
