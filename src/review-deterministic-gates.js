'use strict';

// The deterministic gates of runReview that run after the fact-check and before any vote (roadmap step 1, piece P6.4b): each is a function that
// returns a final review result ({ succeeded: true, verdict, ... }) or null to fall through, and runDeterministicGates runs them in the original order.
// Moved out of review-task.js unchanged; the helpers they use live in review-gate-helpers.js. runDeterministicGates returns { early } or
// { trimmedImplResponse } (the trimmed draft, which the code after the gates still needs).

const { getDecomposeProposalDetection } = require('./hub-review-detection.js');
const { getRegisteredSource, resolveSourceName } = require('./task-source-registry.js');
const { appendHistoryEvent } = require('./task-history.js');
const { changedFilesOfDiff } = require('./lib/draft-side-effects.js');
const { decideEmptyApprovalOutcome } = require('./empty-approval-decision.js');
const { decidePremiseRecheckOutcome } = require('./premise-recheck-decision.js');
const { isStructuredGroupBChange, looksLikeReadToolCall } = require('./lib/structured-change.js');
const { logFactCheckAudit } = require('./review-grounding.js');
const {
  isEmptyApprovalSource, isAdvisoryProseSource, isEffectivelyEmpty, validateRelocatedDraftSymbols, verifyDeterministicScriptExtractDraft,
  verifyDeterministicOnePassDecomposeDraft, NON_IMPL_PATTERNS, decodeGroupBContent, namesExtractedPieces,
} = require('./review-gate-helpers.js');

// ctx: { task, factCheck, factCheckVerdict, repoRootForCheck, factCheckExtraRoots, groundingRef, pipelineDir, recordModelOutcome, trimmedImplResponse, effectivelyEmpty, isProposalNotClaim }
function ungroundedValueGate(ctx) {
  const { task, factCheck, factCheckVerdict, repoRootForCheck, factCheckExtraRoots, groundingRef, pipelineDir, recordModelOutcome, trimmedImplResponse, effectivelyEmpty, isProposalNotClaim } = ctx;
  // 2026-08-24 (pipeline hardening -- resurrects a real gap closed once already on
  // 2026-08-12 for the old Windows/PowerShell review-runner.ps1, never carried forward
  // across this project's Linux port): fact-checker.js's own comments call ungrounded-url
  // and ungrounded-field "almost never a false positive" -- checkGroundedValues() only
  // ever flags a value when there IS real grounding source text to compare against and
  // the value appears NOWHERE in it, placeholders already exempted. That precision was
  // being wasted as advisory context a review vote could (and did) simply ignore, the
  // same "known-bad signal, only advisory" shape every OTHER deterministic gate in this
  // function already treats as disqualifying. Hard-blocks before spending a review call,
  // same as the empty-response/non-implementation/fixed-literals gates below.
  // 2026-08-25, root-caused live via a real blocked adhoc task (second-brain review
  // sweep): RESOLUTION: decompose (adhoc-agentic-draft.js's "task judged too large,
  // propose sub-tasks instead of a diff" outcome, carved out in buildVerdictPrompt below
  // -- see its own comment) got hard-blocked here anyway, before ever reaching that
  // carve-out, because a decompose proposal's sub-task rawText routinely SUGGESTS names
  // for config/paths a FUTURE sub-task should create (e.g. "add
  // AGENT_MANAGER_SECOND_BRAIN_REVIEW_COVERAGE_PATH, following the pattern of
  // stalenessAuditCoveragePath" -- explicitly marked as a proposal, "e.g.", never a claim
  // that it already exists). checkGroundedValues' whole premise is "a value cited as
  // already-real that appears nowhere in the grounding source is fabricated" -- a
  // category error against text that is deliberately proposing something new, the exact
  // same "new declaration, not a claimed-existing value" distinction NEW_DECLARATION_RE
  // already carves out for a real diff's own `+const NAME = ...` line, just for a
  // decompose proposal's prose instead of a diff. Scoped ONLY to the two high-precision
  // flags that hard-block with no review call at all -- factCheck's OTHER checks (missing-
  // file, fabricated-commit-reference, unconfirmed-relationship) still run and still hard-
  // block a decompose response exactly as before: those check "does this cite something
  // that claims to already exist," which stays a real fabrication signal even in a
  // decompose proposal's prose. And the full factCheck (including these two flags) is
  // still handed to the reviewer model via buildVerdictPrompt below regardless -- this
  // only removes the automatic no-review-call block, not the information itself.
  // 2026-08-26: a `{"mode": "split"}` proposal (see candidateSplitInstructions) is the
  // exact same category as a decompose proposal above -- prose describing FUTURE
  // sub-candidates, which routinely names config/field values a future drafting pass
  // should create, not a claim that something already exists. Same carve-out, same
  // "still checked, just not auto-blocked" scoping.
  //
  // 2026-09-02: the same category error for an advisoryProse candidate-generating review
  // source (function_length_review / performance_review / observability_review). Their
  // deliverable is a `### AC-NNN` candidate block whose Solution paragraph PROPOSES names
  // for helpers/constants a FUTURE fix pass should introduce ("extract into a
  // RETRYABLE_WITH_BACKOFF branch", "compute START_MS once outside the loop") -- never a
  // claim that RETRYABLE_WITH_BACKOFF / START_MS already exists. checkGroundedValues'
  // premise ("a value cited as already-real that appears nowhere is fabricated") is a
  // category error against a proposal, exactly like the decompose case above. Confirmed
  // live: function-length-...reject-retry-check-js-90 (RETRYABLE_WITH_BACKOFF),
  // performance-...uptime-log-js-58 (START_MS). Still handed to the vote via
  // buildVerdictPrompt -- just not an automatic no-review block.
  let highPrecisionFlags = isProposalNotClaim
    ? []
    : (factCheck.flags || []).filter((f) => f.type === 'ungrounded-url' || f.type === 'ungrounded-field');
  // HUB0090 · 2/2 · relocation-validation branch: a draft whose edited file is not in the
  // frozen Files: list is NOT auto-rejected when the flagged target symbol has genuinely
  // moved (frozen file lacks it at current HEAD, the draft's file carries it) or was only
  // truncated out of the frozen window (AC-61). Only flags it cannot explain stay for the
  // original gate below, which is untouched and still reachable.
  if (highPrecisionFlags.length > 0) {
    const relocation = validateRelocatedDraftSymbols(task, highPrecisionFlags, repoRootForCheck);
    if (relocation.validated.length > 0) {
      const draftFilesList = changedFilesOfDiff(task.rawDiff || '').join(', ') || '(no diff)';
      for (const v of relocation.validated) {
        appendHistoryEvent(task, 'relocation-validated',
          `HUB0090: ${v.type} symbol "${v.symbol}" -- ${v.note}; frozenFile: ${v.frozenFile}; draftFile: ${v.draftFile || '(draft edits: ' + draftFilesList + ')'}; ac61Refetch: ${v.ac61Refetch}`);
      }
      highPrecisionFlags = relocation.remaining;
    }
  }
  if (highPrecisionFlags.length > 0) {
    const detail = highPrecisionFlags.map((f) => `${f.type}: ${f.detail}`).join('; ');
    const reason = `Deterministic gate: draft cites a value that appears nowhere in its real grounding source -- ${detail}. This fact-check flag is high-precision (almost never a false positive) and treated as disqualifying, not merely advisory context a vote could ignore -- no local-model review call spent on a draft already known to contain a hallucinated value.`;
    task.reviewProvider = 'deterministic-ungrounded-value';
    logFactCheckAudit(pipelineDir, { taskId: task.id, source: resolveSourceName(task), flags: highPrecisionFlags });
    recordModelOutcome({ callId: task.abCallId, outcome: 'rejected', outcomeStage: 'review', outcomeReason: reason });
    appendHistoryEvent(task, 'blocked', reason);
    return { succeeded: true, verdict: 'blocked', blockedReason: reason, blockedStage: 'review', factCheckVerdict };
  }
  return null;
}

// ctx: { task, factCheck, factCheckVerdict, repoRootForCheck, factCheckExtraRoots, groundingRef, pipelineDir, recordModelOutcome, trimmedImplResponse, effectivelyEmpty, isProposalNotClaim }
function revertsPriorFixGate(ctx) {
  const { task, factCheck, factCheckVerdict, repoRootForCheck, factCheckExtraRoots, groundingRef, pipelineDir, recordModelOutcome, trimmedImplResponse, effectivelyEmpty, isProposalNotClaim } = ctx;
  // reverts-a-prior-fix (2026-09-08, root-caused live via change-review-fix-ac-1 -- see
  // fact-checker.js's checkRevertsAPriorFix header for the full incident): a Group B edit
  // that git history shows is reverting toward code an earlier commit of THIS pipeline's
  // own (AC-\d+-marked) removed is very likely undoing an already-confirmed fix without
  // knowing it -- the same "high-precision, disqualifying, no review call spent" tier as
  // ungrounded-url/ungrounded-field above, not merely advisory context a vote (which only
  // ever checks fidelity to the CURRENT finding, never the target line's own history)
  // could ignore or miss entirely.
  const revertFlags = isProposalNotClaim ? [] : (factCheck.flags || []).filter((f) => f.type === 'reverts-a-prior-fix');
  if (revertFlags.length > 0) {
    const detail = revertFlags.map((f) => f.detail).join('; ');
    const reason = `Deterministic gate: this edit reverts code that git history shows was itself the deliberate resolution of an earlier confirmed fix in this pipeline -- ${detail}. Not merely advisory context a vote could ignore -- no local-model review call spent on a draft already known to be undoing a confirmed prior fix; needs a human to judge whether the earlier fix should actually be reversed.`;
    task.reviewProvider = 'deterministic-reverts-a-prior-fix';
    logFactCheckAudit(pipelineDir, { taskId: task.id, source: resolveSourceName(task), flags: revertFlags });
    recordModelOutcome({ callId: task.abCallId, outcome: 'rejected', outcomeStage: 'review', outcomeReason: reason });
    appendHistoryEvent(task, 'blocked', reason);
    return { succeeded: true, verdict: 'blocked', blockedReason: reason, blockedStage: 'review', factCheckVerdict };
  }
  return null;
}

// ctx: { task, factCheck, factCheckVerdict, repoRootForCheck, factCheckExtraRoots, groundingRef, pipelineDir, recordModelOutcome, trimmedImplResponse, effectivelyEmpty, isProposalNotClaim }
function onePassDecomposeGate(ctx) {
  const { task, factCheck, factCheckVerdict, repoRootForCheck, factCheckExtraRoots, groundingRef, pipelineDir, recordModelOutcome, trimmedImplResponse, effectivelyEmpty, isProposalNotClaim } = ctx;
  const onePassVerdict = verifyDeterministicOnePassDecomposeDraft(task, repoRootForCheck);
  if (onePassVerdict) {
    if (onePassVerdict.ok) {
      task.reviewedAt = new Date().toISOString();
      task.reviewProvider = 'deterministic-one-pass-decompose-approve';
      task.localVerdict = `Auto-approved: a whole ${onePassVerdict.moduleCount}-module file-decompose that byte-matches a fresh re-derivation (V8-parser oracle) from current repo state -- no local-model review call spent (the diff is also far larger than the review model\u0027s context window).`;
      recordModelOutcome({ callId: task.abCallId, outcome: 'approved', outcomeStage: 'review', outcomeReason: null });
      appendHistoryEvent(task, 'approved', 'deterministic-one-pass-decompose-approve');
      return { succeeded: true, verdict: 'approved', factCheckVerdict };
    }
    const reason = `Deterministic gate: this one-pass decompose\u0027s diff no longer matches a fresh re-derivation from current repo state -- ${onePassVerdict.reason}. No local-model review call spent. Requeue re-runs the deterministic draft against the then-current file.`;
    task.reviewProvider = 'deterministic-one-pass-decompose-reject';
    recordModelOutcome({ callId: task.abCallId, outcome: 'rejected', outcomeStage: 'review', outcomeReason: reason });
    appendHistoryEvent(task, 'blocked', reason);
    return { succeeded: true, verdict: 'blocked', blockedReason: reason, blockedStage: 'review', factCheckVerdict };
  }
  return null;
}

// ctx: { task, factCheck, factCheckVerdict, repoRootForCheck, factCheckExtraRoots, groundingRef, pipelineDir, recordModelOutcome, trimmedImplResponse, effectivelyEmpty, isProposalNotClaim }
function scriptExtractGate(ctx) {
  const { task, factCheck, factCheckVerdict, repoRootForCheck, factCheckExtraRoots, groundingRef, pipelineDir, recordModelOutcome, trimmedImplResponse, effectivelyEmpty, isProposalNotClaim } = ctx;
  const scriptExtractVerdict = verifyDeterministicScriptExtractDraft(task, repoRootForCheck, groundingRef);
  if (scriptExtractVerdict) {
    if (scriptExtractVerdict.ok) {
      task.reviewedAt = new Date().toISOString();
      task.reviewProvider = 'deterministic-script-extract-approve';
      task.localVerdict = 'Auto-approved: this diff is a re-derivable, byte-exact extraction (script-extract.js\'s V8-parser oracle) -- no local-model review call spent (the diff is also far too large to fit in the review model\'s own context window, which is why this gate exists rather than an LLM skim).';
      recordModelOutcome({ callId: task.abCallId, outcome: 'approved', outcomeStage: 'review', outcomeReason: null });
      appendHistoryEvent(task, 'approved', 'deterministic-script-extract-approve');
      return { succeeded: true, verdict: 'approved', factCheckVerdict };
    }
    const reason = `Deterministic gate: this script-extract move\u0027s diff no longer matches a fresh re-derivation from current repo state -- ${scriptExtractVerdict.reason}. No local-model review call spent (this diff is also far too large for the review model\u0027s context window regardless).`;
    task.reviewProvider = 'deterministic-script-extract-reject';
    recordModelOutcome({ callId: task.abCallId, outcome: 'rejected', outcomeStage: 'review', outcomeReason: reason });
    appendHistoryEvent(task, 'blocked', reason);
    return { succeeded: true, verdict: 'blocked', blockedReason: reason, blockedStage: 'review', factCheckVerdict };
  }
  return null;
}

// ctx: { task, factCheck, factCheckVerdict, repoRootForCheck, factCheckExtraRoots, groundingRef, pipelineDir, recordModelOutcome, trimmedImplResponse, effectivelyEmpty, isProposalNotClaim }
function emptyOutcomeGate(ctx) {
  const { task, factCheck, factCheckVerdict, repoRootForCheck, factCheckExtraRoots, groundingRef, pipelineDir, recordModelOutcome, trimmedImplResponse, effectivelyEmpty, isProposalNotClaim } = ctx;
  // Empty-implement outcome for the 4 "empty is a documented valid outcome" sources.
  // ONE shared definition (src/empty-approval-decision.js) -- review-runner.ps1 calls the
  // same module via its CLI, so this can never drift between the two runtimes again.
  // Replaces the earlier per-runtime flip + the AGENT_MANAGER_DEEP_DIVE_EMPTY_APPROVE_FAIL
  // kill switch (2026-09-10). 'approve' = empty AND the harness search that fed this task
  // found real hits (model had material, chose to produce nothing -- the documented
  // "reviewed it, nothing actionable" no-op). 'block' = empty AND zero harness hits
  // (nothing to review; the anchor search is deterministic against unchanged inputs so a
  // blind requeue only re-derives the same empty grounding). null -> fall through.
  const emptyOutcome = decideEmptyApprovalOutcome(task);
  if (emptyOutcome === 'block-no-context') {
    const reason = `Deterministic gate: ${task.source} was given no source files for this task (promptContext.files is empty -- the graph likely names files that are missing or unreadable, or a stale task carries context captured before a fix). Any draft would be ungrounded, so none is reviewed or approved; a blind requeue re-sends the same empty context. Rebuild the graph or regenerate the task.`;
    task.reviewProvider = 'deterministic-no-context-fail';
    recordModelOutcome({ callId: task.abCallId, outcome: 'rejected', outcomeStage: 'review', outcomeReason: reason });
    appendHistoryEvent(task, 'blocked', reason);
    return { succeeded: true, verdict: 'blocked', blockedReason: reason, blockedStage: 'review', factCheckVerdict };
  }
  if (emptyOutcome === 'block') {
    const reason = 'Deterministic gate: implementResponse is empty AND the harness search that fed this task found zero hits -- nothing to review, and a blind requeue only re-derives the same empty grounding (no local-model review call spent)';
    task.reviewProvider = 'deterministic-empty-fail';
    recordModelOutcome({ callId: task.abCallId, outcome: 'rejected', outcomeStage: 'review', outcomeReason: reason });
    appendHistoryEvent(task, 'blocked', reason);
    return { succeeded: true, verdict: 'blocked', blockedReason: reason, blockedStage: 'review', factCheckVerdict };
  }
  if (emptyOutcome === 'approve') {
    task.reviewedAt = new Date().toISOString();
    task.reviewProvider = 'deterministic-empty-approve';
    task.localVerdict = `Auto-approved: implementResponse is genuinely empty and the harness search that fed this task found real hits -- a documented valid "nothing actionable" outcome for ${task.source} (no local-model review call spent -- this is deterministic, not a judgment call)`;
    recordModelOutcome({ callId: task.abCallId, outcome: 'approved', outcomeStage: 'review', outcomeReason: null });
    appendHistoryEvent(task, 'approved', 'deterministic-empty-approve');
    return { succeeded: true, verdict: 'approved', factCheckVerdict };
  }
  return null;
}

// ctx: { task, factCheck, factCheckVerdict, repoRootForCheck, factCheckExtraRoots, groundingRef, pipelineDir, recordModelOutcome, trimmedImplResponse, effectivelyEmpty, isProposalNotClaim }
function premiseRecheckGate(ctx) {
  const { task, factCheck, factCheckVerdict, repoRootForCheck, factCheckExtraRoots, groundingRef, pipelineDir, recordModelOutcome, trimmedImplResponse, effectivelyEmpty, isProposalNotClaim } = ctx;
  // 2026-09-18 (brain-dump bd-1789602379616, following up on PR #322's exhaustion-
  // escalation fix): a candidate-fulfillment "_fix" task's implementResponse can be the
  // documented "FALSE POSITIVE -- <reason>" refusal line (prompts.js's own instructed
  // format for "this finding no longer applies") -- but that response is short and has
  // no code fence, so without this check it falls straight into the isNonImplementation
  // gate just below and gets rejected exactly like a genuinely bad draft, even when the
  // refusal is CORRECT. decidePremiseRecheckOutcome re-runs the ORIGINAL *_review
  // source's own deterministic scanner rule against the cited file's CURRENT content --
  // see that module's own header for why "the rule finds nothing anywhere in the file"
  // is a safe, conservative confirmation (not a guess) that this exact candidate's
  // complaint is gone. Ordered before isNonImplementation so a confirmed-correct refusal
  // never reaches that gate at all -- no wasted retry, no wasted human escalation.
  const premiseRecheckOutcome = decidePremiseRecheckOutcome(task, { repoRoot: repoRootForCheck, extraRoots: factCheckExtraRoots });
  if (premiseRecheckOutcome === 'approve') {
    task.reviewedAt = new Date().toISOString();
    task.reviewProvider = 'deterministic-premise-recheck-approve';
    task.localVerdict = 'Auto-approved: implementResponse is a FALSE POSITIVE refusal, and a deterministic re-scan of the '
      + `original ${getRegisteredSource(task.source) && getRegisteredSource(task.source).premiseRecheckSource}'s own rule set `
      + 'against the cited file\'s current content confirms nothing is flagged there anymore -- verified, not a judgment call '
      + '(no local-model review call spent).';
    recordModelOutcome({ callId: task.abCallId, outcome: 'approved', outcomeStage: 'review', outcomeReason: null });
    appendHistoryEvent(task, 'approved', 'deterministic-premise-recheck-approve');
    return { succeeded: true, verdict: 'approved', factCheckVerdict };
  }
  return null;
}

// ctx: { task, factCheck, factCheckVerdict, repoRootForCheck, factCheckExtraRoots, groundingRef, pipelineDir, recordModelOutcome, trimmedImplResponse, effectivelyEmpty, isProposalNotClaim }
function nonImplementationGate(ctx) {
  const { task, factCheck, factCheckVerdict, repoRootForCheck, factCheckExtraRoots, groundingRef, pipelineDir, recordModelOutcome, trimmedImplResponse, effectivelyEmpty, isProposalNotClaim } = ctx;
  let isNonImplementation = false;
  if (!effectivelyEmpty) {
    isNonImplementation = looksLikeReadToolCall(trimmedImplResponse) || NON_IMPL_PATTERNS.some((pat) => pat.test(trimmedImplResponse));
    // A short fence-free response is presumed to be meta-commentary -- unless it IS a structurally valid change set
    // (lib/structured-change.js): `{"mode": "delete", "file": "<path>"}` is 71-79 characters for this repo's short paths and
    // was blocked on length alone (deadcode_fix, 9 stranded tasks). NON_IMPL_PATTERNS above still win, so a short
    // mode:"read" request is rejected exactly as before, and the delete-specific safeguards downstream are untouched.
    if (!isNonImplementation && trimmedImplResponse.length < 80 && !trimmedImplResponse.includes('```')
      && !isStructuredGroupBChange(trimmedImplResponse)) {
      isNonImplementation = true;
    }
  }
  if (isNonImplementation && !isEmptyApprovalSource(task.source) && !isAdvisoryProseSource(task.source)) {
    const reason = 'Deterministic gate: implementResponse is a bare tool-call request or meta-commentary, not a real implementation attempt -- no local-model review call spent (mechanically detectable, not a judgment call).';
    task.reviewProvider = 'deterministic-non-implementation';
    recordModelOutcome({ callId: task.abCallId, outcome: 'rejected', outcomeStage: 'review', outcomeReason: reason });
    appendHistoryEvent(task, 'blocked', reason);
    return { succeeded: true, verdict: 'blocked', blockedReason: reason, blockedStage: 'review', factCheckVerdict };
  }
  return null;
}

// ctx: { task, factCheck, factCheckVerdict, repoRootForCheck, factCheckExtraRoots, groundingRef, pipelineDir, recordModelOutcome, trimmedImplResponse, effectivelyEmpty, isProposalNotClaim }
function fixedLiteralsGate(ctx) {
  const { task, factCheck, factCheckVerdict, repoRootForCheck, factCheckExtraRoots, groundingRef, pipelineDir, recordModelOutcome, trimmedImplResponse, effectivelyEmpty, isProposalNotClaim } = ctx;
  const fixedLiterals = (task.promptContext && task.promptContext.fixedLiterals) || [];
  if (fixedLiterals.length > 0) {
    const decoded = decodeGroupBContent(task.implementResponse || '');
    const compareText = decoded || trimmedImplResponse;
    // .trimEnd() on the literal only, not compareText -- narrowly tolerates a missing
    // trailing newline (never semantically meaningful for "was this copied correctly")
    // without loosening the check anywhere else. Confirmed live 2026-08-14: a whole-file
    // fixedLiterals block ending in "\n" (the normal convention for a source file) was
    // faithfully reproduced character-for-character by the model EXCEPT for that final
    // newline once embedded as a JSON string value -- a false-positive rejection on an
    // otherwise-perfect copy, burning a real retry attempt on a class of mismatch that
    // carries no actual signal about whether the content was copied correctly.
    const missing = fixedLiterals.filter((lit) => !compareText.includes(lit.content.trimEnd()));
    if (missing.length > 0) {
      const missingNames = missing.map((m) => m.name).join(', ');
      const reason = `Deterministic gate: draft does not contain the required fixed block(s) character-for-character: ${missingNames}. These were given verbatim in the task and must be copied exactly, not rewritten from memory -- no local-model review call spent on a draft that already fails a mechanical check.`;
      task.reviewProvider = 'deterministic-fixed-literals';
      recordModelOutcome({ callId: task.abCallId, outcome: 'rejected', outcomeStage: 'review', outcomeReason: reason });
      appendHistoryEvent(task, 'blocked', reason);
      return { succeeded: true, verdict: 'blocked', blockedReason: reason, blockedStage: 'review', factCheckVerdict };
    }
  }
  return null;
}

// ctx: { task, factCheck, factCheckVerdict, repoRootForCheck, factCheckExtraRoots, groundingRef, pipelineDir, recordModelOutcome, trimmedImplResponse, effectivelyEmpty, isProposalNotClaim }
function unaddressedCritiqueGate(ctx) {
  const { task, factCheck, factCheckVerdict, repoRootForCheck, factCheckExtraRoots, groundingRef, pipelineDir, recordModelOutcome, trimmedImplResponse, effectivelyEmpty, isProposalNotClaim } = ctx;
  // 2026-08-24 (pipeline hardening -- same resurrected gap as the ungrounded-value block
  // above, closed once already on 2026-08-12 for review-runner.ps1, never carried
  // forward across this project's Linux port): local-draft.js's own critique+revision
  // pass had already found real issues in this exact draft (task.critiqueOutcome ===
  // 'issues-flagged'), but review-task.js never once read that field -- a draft its own
  // critique had flagged as broken could still win a clean vote, because the review pass
  // simply never knew the critique ran at all. task.revisionApplied is only ever false
  // here when local-draft.js's own follow-up revision call came back degenerate (see its
  // own comment) -- meaning the ORIGINAL, critique-flagged draft is what's about to reach
  // review, with a known, real, already-identified problem review has no visibility into.
  if (task.critiqueOutcome === 'issues-flagged' && !task.revisionApplied) {
    // The optional critique text is built first: the size ratchet's tokenizer cannot follow a template literal nested inside another one.
    const critiqueSuffix = task.critiqueText ? ` Critique: ${task.critiqueText.slice(0, 500)}` : '';
    const reason = `Deterministic gate: this draft\u0027s own critique pass flagged real issues, and the follow-up revision attempt failed (degenerate) or was never applied -- the draft reaching review is the SAME one the critique already found problems with. No local-model review call spent voting on a draft already known to have unaddressed issues.${critiqueSuffix}`;
    task.reviewProvider = 'deterministic-unaddressed-critique';
    recordModelOutcome({ callId: task.abCallId, outcome: 'rejected', outcomeStage: 'review', outcomeReason: reason });
    appendHistoryEvent(task, 'blocked', reason);
    return { succeeded: true, verdict: 'blocked', blockedReason: reason, blockedStage: 'review', factCheckVerdict };
  }
  return null;
}

// ctx: { task, factCheck, factCheckVerdict, repoRootForCheck, factCheckExtraRoots, groundingRef, pipelineDir, recordModelOutcome, trimmedImplResponse, effectivelyEmpty, isProposalNotClaim }
function missingAcceptanceGate(ctx) {
  const { task, factCheck, factCheckVerdict, repoRootForCheck, factCheckExtraRoots, groundingRef, pipelineDir, recordModelOutcome, trimmedImplResponse, effectivelyEmpty, isProposalNotClaim } = ctx;
  // Component 2 (2026-09-04): an adhoc task with acceptance criteria whose implement draft
  // produced NO "Acceptance:" block reporting a check for each -- block before spending a
  // vote, same discipline as the fixedLiterals / unaddressed-critique gates above. Kill
  // switch AGENT_MANAGER_ADHOC_ACCEPTANCE_GATE=false (keeps the review-question folding, drops
  // this hard gate -- the advisory-first rollout step).
  if (process.env.AGENT_MANAGER_ADHOC_ACCEPTANCE_GATE !== 'false'
      && resolveSourceName(task) === 'adhoc'
      && task.adhocResolution === 'implemented'
      && Array.isArray(task.acceptanceCriteria) && task.acceptanceCriteria.length
      && !(Array.isArray(task.acceptanceResults) && task.acceptanceResults.length)) {
    const reason = `Deterministic gate: this task has ${task.acceptanceCriteria.length} acceptance criteria but the implement draft produced no "Acceptance:" block reporting a check for each -- no local-model review call spent on a draft that skipped its own definition of done.`;
    task.reviewProvider = 'deterministic-missing-acceptance';
    recordModelOutcome({ callId: task.abCallId, outcome: 'rejected', outcomeStage: 'review', outcomeReason: reason });
    appendHistoryEvent(task, 'blocked', reason);
    return { succeeded: true, verdict: 'blocked', blockedReason: reason, blockedStage: 'review', factCheckVerdict };
  }
  return null;
}

// ctx: { task, factCheck, factCheckVerdict, repoRootForCheck, factCheckExtraRoots, groundingRef, pipelineDir, recordModelOutcome, trimmedImplResponse, effectivelyEmpty, isProposalNotClaim }
function missingCodeShapeGate(ctx) {
  const { task, factCheck, factCheckVerdict, repoRootForCheck, factCheckExtraRoots, groundingRef, pipelineDir, recordModelOutcome, trimmedImplResponse, effectivelyEmpty, isProposalNotClaim } = ctx;
  // Enforce code-diff presence for a source that registers requireCodeShapeInCandidate (function_length_review; 2026-09-08 brain-dump
  // request): its deliverable is an `### AC-NNN` candidate whose Solution shows the
  // proposed change, not just prose describing what should change -- a prose-only draft
  // routinely got voted through, then rejected downstream (fulfillment) for having
  // nothing concrete to implement. Block before spending a review call, same discipline
  // as the neighboring deterministic gates above. Kept permissive enough to still pass a
  // legitimate candidate whose Solution includes an inline fenced snippet or diff hunk --
  // this only rejects PURE prose with no code shape at all.
  //
  // Scoped to CANDIDATE drafts (2026-09-19, PF-Client-Portal HotlistView.tsx:47): the review prompt
  // (function-length-review.js) says a FALSE POSITIVE / UNCERTAIN verdict is "ONE short paragraph...
  // plain prose only -- no code fence", so a prose verdict is the CORRECT output there. This gate used
  // to reject it, so every false-positive verdict burned 3 drafts and escalated to a human. Only a draft
  // that is a candidate (an `### AC-NNN` block, the parser's contract) owes a code shape.
  // Registration flag `requireCodeShapeInCandidate: true` (function_length_review, in the hygiene plugin).
  const codeShapeEntry = getRegisteredSource(resolveSourceName(task));
  if (codeShapeEntry && codeShapeEntry.requireCodeShapeInCandidate === true && trimmedImplResponse
      && /^#{2,4}\s*AC-\S+/m.test(trimmedImplResponse)
      && !/```/.test(trimmedImplResponse)
      && !/^(?:---|\+\+\+|@@)/m.test(trimmedImplResponse)
      && !/^(?:\+|-)(?!\s*$)\S/m.test(trimmedImplResponse)
      && !namesExtractedPieces(trimmedImplResponse)) {
    const reason = 'Deterministic gate: missing-code-diff -- candidate drafts from this source must show the concrete change as a fenced code block or diff hunk, not prose-only commentary describing what should change. No local-model review call spent on a draft with no code shape at all.';
    task.reviewProvider = 'deterministic-missing-code-diff';
    recordModelOutcome({ callId: task.abCallId, outcome: 'rejected', outcomeStage: 'review', outcomeReason: reason });
    appendHistoryEvent(task, 'blocked', reason);
    return { succeeded: true, verdict: 'blocked', blockedReason: reason, blockedStage: 'review', factCheckVerdict };
  }
  return null;
}

// ctx: { task, factCheck, factCheckVerdict, repoRootForCheck, factCheckExtraRoots, groundingRef, pipelineDir, recordModelOutcome }
// -> { early } (the first gate's final result) or { trimmedImplResponse } when every gate falls through.
function runDeterministicGates(base) {
  const { task, factCheck } = base;
  const isDecomposeProposal = getDecomposeProposalDetection().isDecomposeOrSplitProposal(task);
  const isProposalNotClaim = isDecomposeProposal || isAdvisoryProseSource(resolveSourceName(task));
  const first = (gates, ctx) => {
    for (const gate of gates) {
      const r = gate(ctx);
      if (r) return r;
    }
    return null;
  };
  const ctx = { ...base, isProposalNotClaim };
  const early1 = first([ungroundedValueGate, revertsPriorFixGate, onePassDecomposeGate, scriptExtractGate], ctx);
  if (early1) return { early: early1 };
  const trimmedImplResponse = (task.implementResponse || '').trim();
  const effectivelyEmpty = isEffectivelyEmpty(trimmedImplResponse);
  const ctx2 = { ...ctx, trimmedImplResponse, effectivelyEmpty };
  const early2 = first([emptyOutcomeGate, premiseRecheckGate, nonImplementationGate, fixedLiteralsGate, unaddressedCritiqueGate, missingAcceptanceGate, missingCodeShapeGate], ctx2);
  if (early2) return { early: early2 };
  return { trimmedImplResponse };
}

module.exports = { ungroundedValueGate, revertsPriorFixGate, onePassDecomposeGate, scriptExtractGate, emptyOutcomeGate, premiseRecheckGate, nonImplementationGate, fixedLiteralsGate, unaddressedCritiqueGate, missingAcceptanceGate, missingCodeShapeGate, runDeterministicGates };
