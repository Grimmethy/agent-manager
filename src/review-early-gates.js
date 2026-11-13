'use strict';

// The deterministic gates runReview runs before any grounding, fact-check or vote (roadmap step 1, piece P6.3a): the truncation guard, a source's own
// mechanical validator, the honest-null outcome and the comment-only no-op. Each returns a final review result or null; runEarlyGates runs them in the
// original order and returns the first result. Moved out of review-task.js with the helper only they use; review-task.js calls runEarlyGates.

const { getRegisteredSource, resolveSourceName } = require('./task-source-registry.js');
const { appendHistoryEvent } = require('./task-history.js');
const { detectTruncatedImplementResponse } = require('./validate-implement-truncation.js');
const { classifyNullOutcome } = require('./advisory-null-outcome.js');
const { isHubChildTask } = require('./review-executed-verification.js');

// A source declaring deterministicReview replaces the whole LLM majority-vote path with a
// mechanical validate function (brain_dump_sort: parse the classification JSON, check the
// secondBrainPath taxonomy, check belongsToProject is a real label). Returns the validator
// or null. See runReview's early branch.
function deterministicReviewValidator(source) {
  const entry = getRegisteredSource(source);
  return entry && typeof entry.deterministicReviewValidate === 'function' ? entry.deterministicReviewValidate : null;
}

function truncationGuard({ task, recordModelOutcome }) {
  // 2026-09-08, brain-dump bd-1788787323412 ("investigate the COMPLETED 20 (line 2714)
  // failure mode"): a draft whose implementResponse is a refusal sentence followed by a
  // code fragment that cuts off mid-string (an unterminated trailing quote -- the
  // incident's own literal "...Topology signature) used to reach the full fact-check +
  // majority-vote machinery below, burning a real review round on content that was never
  // going to apply. Checked here, first, before any real work -- cheap and applies to
  // every source, not just the one this incident happened on. (The task that first
  // described this fix named review-runner.ps1/decode-group-b-content.js as the
  // insertion point -- that pair is the Windows reference implementation's own
  // fixedLiterals compliance gate and is never invoked from the real Linux path;
  // review-runner.sh calls this module, review-task.js, directly, with no
  // decode-group-b-content.js step at all. Wired here instead: the actual live entry
  // point every draft's review goes through.)
  // A genuinely empty/whitespace-only implementResponse is NOT this guard's concern --
  // decideEmptyApprovalOutcome below already handles that case deliberately (approve when
  // harness search found zero real hits, block otherwise), a more informed decision than
  // this guard's blanket "empty = truncated" rule 1 would make. Only run the guard on
  // NON-empty text, where its real job (a refusal sentence followed by a code fragment
  // that cuts off mid-string) applies.
  const rawImplementResponse = task.implementResponse || '';
  const truncationCheck = rawImplementResponse.trim()
    ? detectTruncatedImplementResponse(rawImplementResponse, resolveSourceName(task))
    : { truncated: false, reason: null };
  if (truncationCheck.truncated) {
    const rawText = rawImplementResponse;
    task.reviewProvider = 'deterministic-truncation-guard';
    recordModelOutcome({ callId: task.abCallId, outcome: 'rejected', outcomeStage: 'review', outcomeReason: truncationCheck.reason });
    appendHistoryEvent(task, 'blocked', `${truncationCheck.reason} (raw text length ${rawText.length}, starts "${rawText.slice(0, 80)}", ends "${rawText.slice(-80)}")`);
    return { succeeded: true, verdict: 'blocked', blockedReason: truncationCheck.reason, blockedStage: 'review', factCheckVerdict: 'skipped' };
  }
  return null;
}

function deterministicValidatorGate({ task, recordModelOutcome, secondBrainDir, repoRoot }) {
  // Deterministic review (brain_dump_sort, 2026-09-03): a mechanical validate replaces the
  // LLM majority vote entirely -- no grounding subprocess, no fact-check, no vote. The vote
  // was rejecting valid classifications on folder/filename nitpicks its own guidance forbade
  // (8 permanently-blocked tasks). A failure here still sets blockedStage:'review', so
  // reject-retry-check folds the specific reason into the next draft (an informed retry).
  const detValidate = deterministicReviewValidator(resolveSourceName(task));
  if (detValidate) {
    let outcome;
    try {
      outcome = detValidate(task, { secondBrainDir, repoRoot });
    } catch (e) {
      outcome = { ok: false, reason: `deterministic review validator threw: ${e.message}` };
    }
    if (outcome && outcome.ok) {
      task.reviewedAt = new Date().toISOString();
      task.reviewProvider = 'deterministic-brain-dump-sort';
      task.localVerdict = 'Auto-approved: deterministic classification validation passed (no vote).';
      recordModelOutcome({ callId: task.abCallId, outcome: 'approved', outcomeStage: 'review', outcomeReason: null });
      appendHistoryEvent(task, 'approved', 'deterministic-brain-dump-sort');
      return { succeeded: true, verdict: 'approved', factCheckVerdict: 'skipped' };
    }
    const reason = `Deterministic review: ${outcome ? outcome.reason : 'validation failed'}`;
    task.reviewProvider = 'deterministic-brain-dump-sort';
    recordModelOutcome({ callId: task.abCallId, outcome: 'rejected', outcomeStage: 'review', outcomeReason: reason });
    appendHistoryEvent(task, 'blocked', reason);
    return { succeeded: true, verdict: 'blocked', blockedReason: reason, blockedStage: 'review', factCheckVerdict: 'skipped' };
  }
  return null;
}

function nullOutcomeGate({ task, recordModelOutcome }) {
  const rawImplementResponse = task.implementResponse || '';
  // Honest null outcome (2026-09-27, advisory-null-outcome.js): a pipeline_forensics `NO CLEAR ROOT CAUSE -- <signal>`, a
  // pipeline_debrief `NO CONFIDENT INEFFICIENCY -- <signal>` line or a pipeline_health_audit `FALSE POSITIVE -- <why>` is the
  // form the prompts instruct for "the evidence supports no finding". The LLM vote kept rejecting it (3/3 forensics nulls 2/2
  // REJECT despite reviewGuidance saying a null is valid; 4/4 health-audit FALSE POSITIVE lines as "refusals"), so the only way
  // through was fabrication. A well-formed null is approved mechanically -- no fact-check, no vote -- and falls through to the
  // normal path for anything else. Same shape as the deterministic-review branch above.
  const nullOutcome = classifyNullOutcome(resolveSourceName(task), rawImplementResponse);
  if (nullOutcome) {
    task.reviewedAt = new Date().toISOString();
    task.reviewProvider = 'deterministic-null-outcome';
    task.localVerdict = `Auto-approved: honest null outcome (${nullOutcome.kind}) -- deterministic, no vote.`;
    recordModelOutcome({ callId: task.abCallId, outcome: 'approved', outcomeStage: 'review', outcomeReason: null });
    appendHistoryEvent(task, 'approved', `deterministic-null-outcome: ${nullOutcome.kind}`);
    return { succeeded: true, verdict: 'approved', factCheckVerdict: 'skipped' };
  }
  return null;
}

function commentOnlyGate({ task, recordModelOutcome }) {
  // Comment-only change (2026-10-31, discard analysis; src/review-comment-only.js): 10 brain-dump branches since 2026-10-24 were discarded because their whole
  // change was comments or docstrings -- nothing behaves differently, and the voters approved them anyway. A brain-dump-derived adhoc fix (not a hub slice)
  // whose diff is provably comment-only is closed here as a no-op: no vote, no executed verification, and NO branch -- the diff is kept on the record
  // (commentOnlyDiff) and the task becomes 'no-changes-needed', which apply records as a skipped 'no code change needed' (terminalDisposition noop).
  // Conservative: anything the analyzer cannot prove falls through to the normal vote. Kill switch AGENT_MANAGER_REVIEW_COMMENT_ONLY_CHECK=false.
  if (String(process.env.AGENT_MANAGER_REVIEW_COMMENT_ONLY_CHECK || '').trim().toLowerCase() !== 'false'
      && resolveSourceName(task) === 'adhoc'
      && task.adhocResolution === 'implemented'
      && task.promptContext && typeof task.promptContext === 'object' && task.promptContext.brainDumpEntryId
      && !isHubChildTask(task)
      && typeof task.rawDiff === 'string' && task.rawDiff.trim()) {
    let commentOnly = null;
    try { commentOnly = require('./review-comment-only.js').analyzeCommentOnly(task.rawDiff); } catch (e) {
      console.error(`[review] comment-only check errored for ${task.id} (non-fatal, continuing to the vote): ${e && e.message}`);
    }
    if (commentOnly && commentOnly.commentOnly) {
      const paths = commentOnly.files.map((f) => f.path);
      task.commentOnlyDiff = task.rawDiff;
      task.commentOnly = { at: new Date().toISOString(), files: commentOnly.files };
      task.rawDiff = '';
      task.adhocResolution = 'no-changes-needed';
      task.implementResponse = `Comment-only change, no behavior: ${paths.slice(0, 6).join(', ')}${paths.length > 6 ? `, +${paths.length - 6} more` : ''} change only comments or docstrings, so no code change is needed. The original diff is kept on the task as commentOnlyDiff.`;
      task.reviewedAt = new Date().toISOString();
      task.reviewProvider = 'deterministic-comment-only';
      task.localVerdict = 'Auto-approved as a no-op: the diff changes only comments or docstrings (deterministic, no vote).';
      recordModelOutcome({ callId: task.abCallId, outcome: 'approved', outcomeStage: 'review', outcomeReason: null });
      appendHistoryEvent(task, 'approved', `deterministic-comment-only: ${commentOnly.reason}; closed as a no-op, no branch will be applied`);
      return { succeeded: true, verdict: 'approved', factCheckVerdict: 'skipped' };
    }
  }
  return null;
}

// ctx: { task, recordModelOutcome, secondBrainDir, repoRoot }.
function runEarlyGates(ctx) {
  for (const gate of [truncationGuard, deterministicValidatorGate, nullOutcomeGate, commentOnlyGate]) {
    const result = gate(ctx);
    if (result) return result;
  }
  return null;
}

module.exports = { deterministicReviewValidator, truncationGuard, deterministicValidatorGate, nullOutcomeGate, commentOnlyGate, runEarlyGates };
