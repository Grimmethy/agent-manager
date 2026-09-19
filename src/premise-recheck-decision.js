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

const { extractCandidateSnippet, distinctiveLine } = require('./lib/harness-search.js');

const SITE_MARGIN_LINES = 2;

function normLine(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

// Where does the candidate's own Snippet sit in the file's CURRENT content?
// -> { start, end } (1-based, inclusive) or null when it cannot be located unambiguously.
// The snippet's most distinctive line (the same anchor task-anchor-files windowing uses) is
// matched whitespace-insensitively; exactly ONE hit is required -- zero means the anchor is
// gone, several means we cannot tell which is the candidate's. The span is the snippet's own
// geometry laid over that hit, so an edit INSIDE the snippet (the very fix that resolved it)
// does not stop the site from being found, as long as the anchor line itself survived.
function locateSnippetSite(snippet, fileText) {
  const anchor = distinctiveLine(snippet);
  if (!anchor) return null;
  const want = normLine(anchor);
  const snippetLines = snippet.split('\n');
  const anchorIdx = snippetLines.findIndex((l) => normLine(l) === want);
  if (anchorIdx < 0) return null;
  const hits = [];
  fileText.split('\n').forEach((l, i) => { if (normLine(l) === want) hits.push(i); });
  if (hits.length !== 1) return null;
  return {
    start: hits[0] - anchorIdx + 1,
    end: hits[0] + (snippetLines.length - 1 - anchorIdx) + 1,
  };
}

// A finding with no usable line span is treated as overlapping -- never guess it away.
function findingOverlapsSite(finding, site) {
  const start = Number(finding.blockStartLine != null ? finding.blockStartLine : finding.line);
  const end = Number(finding.blockEndLine != null ? finding.blockEndLine : (finding.line != null ? finding.line : start));
  if (!Number.isFinite(start) || !Number.isFinite(end)) return true;
  return start <= site.end + SITE_MARGIN_LINES && end >= site.start - SITE_MARGIN_LINES;
}

// task, { repoRoot, extraRoots } -> boolean
// True only when the source's own deterministic scanner rules confirm the candidate's
// complaint is gone from the cited file(s) -- with no model call:
//   1. the rule set finds NOTHING anywhere in the file (the original, whole-file check), or
//   2. it still finds things elsewhere, but the candidate's own Snippet is located in the
//      current file and NO finding overlaps that site (added 2026-09-18, AC-169: a large
//      file with unrelated findings could never satisfy 1, so a fixed candidate in it sat
//      permanently unresolvable).
// Any doubt -- opt-out source, unresolved/unreadable file, a rule that errors, an anchor
// that is missing or ambiguous -- is false ("no verdict"), never a guess toward resolved.
function decideFindingResolved(task, { repoRoot, extraRoots = [] } = {}) {
  if (!task) return false;
  const entry = getRegisteredSource(task.source);
  const recheckSourceName = entry && entry.premiseRecheckSource;
  if (!recheckSourceName) return false;

  const recheck = getDeterministicRecheck(recheckSourceName);
  const perFileRules = recheck && recheck.perFileRules;
  if (!perFileRules || Object.keys(perFileRules).length === 0) return false;

  const pc = task.promptContext || {};
  const files = Array.isArray(pc.files) ? pc.files : [];
  if (!files.length || !repoRoot) return false;
  const snippet = extractCandidateSnippet(pc.body);

  for (const claimedPath of files) {
    const { resolvedPath } = resolveAgainstRepoDetailed(repoRoot, claimedPath, extraRoots);
    if (!resolvedPath) return false; // can't verify a path that doesn't resolve -- don't guess
    let text;
    try {
      text = fs.readFileSync(resolvedPath, 'utf8');
    } catch {
      return false; // unreadable -- advisory, don't guess
    }
    const findings = [];
    for (const ruleName of Object.keys(perFileRules)) {
      try {
        findings.push(...(perFileRules[ruleName](text, claimedPath) || []));
      } catch {
        return false; // a rule erroring on this file's current content isn't a "resolved" signal
      }
    }
    if (findings.length === 0) continue; // whole file clean
    const site = snippet ? locateSnippetSite(snippet, text) : null;
    if (!site) return false; // findings remain and we cannot show they are not this candidate's
    if (findings.some((f) => findingOverlapsSite(f, site))) return false;
  }
  return true;
}

// task, { repoRoot, extraRoots } -> 'approve' | null
// null means "no opinion" (not a FALSE POSITIVE claim, or decideFindingResolved has no
// verdict) -- the caller falls through to its normal review path.
function decidePremiseRecheckOutcome(task, opts = {}) {
  if (!task || !isFalsePositiveResponse(task.implementResponse)) return null;
  return decideFindingResolved(task, opts) ? 'approve' : null;
}

module.exports = { decidePremiseRecheckOutcome, decideFindingResolved, isFalsePositiveResponse };
