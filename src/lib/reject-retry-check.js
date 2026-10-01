'use strict';

// Decomposed verbatim from src/reject-retry-check.js: the deterministic reject-retry
// classification helpers (block-shape predicates, deterministic-block signature
// fingerprinting, and the one-shot clean-slate re-admission guards). No behavior change --
// see that file's header for the feature's own history.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getConfig } = require('../config.js');
const { extractDeclaredTargets, pathsRefEqual } = require('../adhoc-diff-sanity.js');
const { hasInvalidPremise } = require('../blocked-task-classifiers.js');
const { getRegisteredSource, resolveSourceName } = require('../task-source-registry.js');

// 2026-09-16: a source registered with deterministicReview (brain_dump_sort today) that was
// blocked at review time by that MECHANICAL validator -- not a model judgment call, a pure
// function of task.implementResponse plus live config (tracked project labels, second-brain
// taxonomy). When that validator's own rule is fixed after the fact (real incident:
// belongsToProject "Projects" -- a Second-Brain vault folder name, not a tracked project
// label -- got auto-corrected to null by a 2026-09-11 fix, but 2 tasks blocked on the OLD
// unfixed rule back on 2026-09-07 were non-adhoc, so reject-retry-check's own "non-adhoc
// stays in blocked/ forever" branch stamped them exhausted-once and left them stranded --
// found live 2026-09-16, 5 and 9 days stale, both already re-validated by hand to confirm
// they pass under the CURRENT rule with zero redraft needed) a blind retry is pointless (the
// content that will be redrafted is unchanged, and deterministicReview never involves model
// judgment that could vary between attempts) -- but so is leaving it stranded forever once
// the actual gate bug is fixed. Re-running the SAME pure validator against the EXISTING
// implementResponse is cheap (no model call, no redraft) and, if it now passes, this is
// exactly the outcome review-task.js's own deterministic-review ok:true branch would have
// produced -- replicate it here (reviewedAt/reviewProvider/localVerdict/history) and move
// straight to queue/approved/, skipping the wasted redraft entirely. Bounded implicitly: a
// recovered task leaves blocked/ for good, so this can never loop on the same task twice.
function deterministicReviewRecoveryCheck(task, { secondBrainDir, repoRoot } = {}) {
  if (task.blockedStage !== 'review') return null;
  const entry = getRegisteredSource(resolveSourceName(task));
  const validate = entry && typeof entry.deterministicReviewValidate === 'function'
    ? entry.deterministicReviewValidate : null;
  if (!validate) return null;
  let outcome;
  try {
    outcome = validate(task, { secondBrainDir, repoRoot });
  } catch {
    return null; // validator itself errored -- leave the task exactly as-is, never guess
  }
  return outcome && outcome.ok ? true : null;
}

// A prior forbidden-path block whose named path is actually one of the task's OWN declared
// edit targets -- adhoc-diff-sanity.js's forbidden-path gate false-positived on the task's
// own scope-discipline language ("No other lines in `index.html` were modified"), since
// fixed there via extractDeclaredTargets. A blind retry could never clear it: the gate
// reproduced the identical false positive on every pass until the retry budget burned out,
// so `localRejectCount` here is noise, not a real rejection signal. Returns true => the
// system re-admits the task with a clean slate (once), instead of an operator hand-fixing it.
function forbiddenPathBlockNamesOwnTarget(task) {
  const text = [
    String(task.blockedReason || ''),
    ...(Array.isArray(task.priorRejectionFeedback) ? task.priorRejectionFeedback.map(String) : []),
  ].join('\n');
  if (!/matches forbidden "|EXPLICITLY forbids \(/i.test(text)) return false;
  const named = new Set();
  for (const m of text.matchAll(/matches forbidden "([^"]+)"/gi)) named.add(m[1]);
  for (const m of text.matchAll(/EXPLICITLY forbids \(([^)]+)\)/gi)) {
    for (const p of m[1].split(',')) {
      const s = p.replace(/^[\s"'`]+|[\s"'`]+$/g, '');
      if (s) named.add(s);
    }
  }
  if (!named.size) return false;
  let targets = [];
  try { targets = extractDeclaredTargets(task, task.planResponse || task.lastGoodPlan || ''); } catch { return false; }
  return [...named].some((n) => targets.some((t) => pathsRefEqual(n, t)));
}

// Deterministic-block short-circuit (ADR-0022): when the block text carries a
// deterministic-recheck marker (staleness-fastpath.js's own "deterministic recheck" /
// "deterministic-rescan" tag) AND task.promptContext.originalFile names a readable
// in-repo file, the outcome of retrying is a PURE function of that file's bytes plus
// the rule it was checked against -- no model judgment involved, so a requeue
// reproduces the identical block and merely burns retry budget. Fingerprint that
// function (sha256 of the file + the rule name) so the caller can compare it against
// task._prevBlockSignature: the same signature twice in a row means the block is
// deterministic AND unchanged -- escalate instead of requeueing. Returns null (i.e.
// "not a deterministic block I can fingerprint") on any miss: no marker, no readable
// file, or the file path resolving outside repoRoot (the same path-safety guard
// staleness-fastpath.js uses).
function computeBlockSignature(task) {
  const text = [
    String(task.blockedReason || ''),
    ...(Array.isArray(task.priorRejectionFeedback) ? task.priorRejectionFeedback.map(String) : []),
  ].join('\n');
  if (!/deterministic recheck|deterministic-rescan/i.test(text)) return null;
  const originalFile = task.promptContext && task.promptContext.originalFile;
  if (!originalFile || typeof originalFile !== 'string') return null;
  let repoRoot;
  try { repoRoot = getConfig().repoRoot; } catch { return null; }
  if (!repoRoot) return null;
  let absPath;
  try { absPath = path.resolve(repoRoot, originalFile); } catch { return null; }
  const root = path.resolve(repoRoot);
  if (!absPath.startsWith(root + path.sep)) return null;
  let fileBytes;
  try { fileBytes = fs.readFileSync(absPath); } catch { return null; }
  return crypto.createHash('sha256').update(fileBytes).digest('hex')
    + '|' + ((task.promptContext && task.promptContext.originalRule) || '');
}

// 2026-09-06: candidate-premise-check.js's premise gate (the "Invalid premise:" block
// producer at local-draft.js's premiseCheck hook; root cause documented in
// blocked-task-classifiers.js) can reject a task whose premise the check itself later
// invalidated -- the block text carries the gate's verdict, not a real review signal.
// Mirrors forbiddenPathBlockNamesOwnTarget's one-shot re-admission pattern: this
// predicate fires ONLY while task.premiseReadmitCount is falsy; the re-admission branch
// sets the count and READMIT_CLEAN_SLATE_FIELDS (which lists 'premiseReadmitCount')
// strips the guard on any subsequent clean-slate pass, so the bound is one-shot per
// task lifecycle and a task that somehow still fails this way is not re-admitted forever.
//
// 2026-09-18 (AC-13 / AC-133): not limited to blockedStage:'review'. local-draft.js's
// premiseCheck hook stamps its "Invalid premise:" block with NO blockedStage, and a model-
// fallback verdict can arrive with reviewInconclusive:true -- the entry gate's allow-list
// of stages never saw either, so both sat in blocked/ forever, and the verdict itself was
// wrong (the check compared against a truncated snapshot; see candidate-premise-check.js).
// A review-stage task keeps the original test (verdict anywhere in the block text or prior
// feedback); any OTHER stage only counts when its OWN blockedReason is the verdict, so an
// old rejection note that merely mentions one can't trigger a readmit on an unrelated block.
function invalidPremiseBeforeCheckExisted(task) {
  if (task.premiseReadmitCount) return false;
  if (task.blockedStage === 'review') {
    const reason = (task.blockedReason || '') + ' ' + (task.priorRejectionFeedback || '');
    return /Invalid premise:/i.test(reason);
  }
  return hasInvalidPremise(task);
}

// 2026-09-17: every escalation site in this file used to check "has this task EVER, in
// its whole lifetime, carried a needs-clarification history stage" -- correct the FIRST
// time a task exhausts, but permanently wrong afterward: a task legitimately re-admitted
// from needs-clarification (needs-clarification-triage.js's own requeue path, or a human
// answering it via the dashboard) starts a genuinely fresh retry cycle, can burn through
// MORE attempts, and exhaust AGAIN -- at which point this whole-lifetime check reads its
// OWN FIRST escalation as still current and refuses to escalate a second time, silently
// stranding the task in queue/blocked/ forever with no further human visibility.
// Root-caused live: sampled the real blocked/ backlog and found dozens of tasks in
// exactly this shape (escalated once, requeued, exhausted again, now permanently stuck).
//
// Fix: only treat a task as "already escalated" if its MOST RECENT needs-clarification
// history entry has nothing AFTER it proving a fresh cycle began since (a 'draft-started'
// event -- the one stage every requeue-back-into-drafting path, human or automated,
// always produces). If a fresh cycle started since the last escalation, this is a NEW
// exhaustion, not a repeat of the old one -- eligible to escalate again.
function alreadyEscalatedSinceLastReadmission(task) {
  const history = Array.isArray(task.history) ? task.history : [];
  let lastNcIndex = -1;
  for (let i = 0; i < history.length; i += 1) {
    if (history[i] && history[i].stage === 'needs-clarification') lastNcIndex = i;
  }
  if (lastNcIndex === -1) return false; // never escalated at all
  return !history.slice(lastNcIndex + 1).some((h) => h && h.stage === 'draft-started');
}

function isReviewRejection(task) {
  // reviewInconclusive (local-draft.js / implement-critique.js's two stochastic harness
  // gates) marks a re-roll-worthy gate flake, not a genuine reviewer rejection -- both set
  // blockedStage:'review' too (the field this function used to key on alone), which
  // silently inherited the blind-redraft behavior meant for a real REJECT verdict.
  return task.blockedStage === 'review' && !task.reviewInconclusive;
}

// 2026-09-17: blockedStage:'pre-critique' (local-draft.js's hard pre-critique guard,
// added 2026-09-16 -- draft-file-guard.js's missingFileCheck) blocks a candidateFulfillment
// task whose implementResponse cites a file that doesn't exist in the repo, BEFORE
// critique/review ever runs. It shipped with no corresponding retry-check branch: the
// entry gate below only ever recognized isReviewRejection/retryableDraftBlock, so every
// task landing here was invisible to this whole sweep -- permanently stuck in blocked/,
// exactly the "huge backlog instead of pushed-to-completion" shape (never even reached
// review, let alone got a chance to redraft without the bad citation). Deterministic like
// the review-rejection case (a real content problem in the prior implementResponse, not a
// stochastic flake), so it gets the same bounded blind-retry treatment.
function isPreCritiqueBlock(task) {
  return task.blockedStage === 'pre-critique';
}

// 2026-09-17: blockedStage:'pre-implement' (local-draft.js's hard PRE-implementation
// guard, plan-target-guard.js's planTargetGuard) blocks an adhoc task whose PLAN cites an
// edit target that does not exist in the repo, BEFORE the implement pass is even called --
// one stage earlier than the pre-critique guard above. Wired into this entry gate in the
// SAME change that introduces the blockedStage, unlike pre-critique/draft/plan above,
// each of which shipped invisible to this sweep and sat as a permanently-stuck blocked/
// backlog until a LATER pass noticed and retrofitted it -- see this file's own reject-
// retry-check.test.js and needs-clarification-triage.test.js coverage for that repeated
// incident shape. Deterministic like pre-critique (a real content problem in the plan,
// not a stochastic flake), same bounded blind-retry treatment.
function isPreImplementBlock(task) {
  return task.blockedStage === 'pre-implement';
}

// 2026-09-17: blockedStage:'draft' -- stamped by scripts/local-worker.sh (bash), NOT any
// src/*.js file, which is why the pre-critique audit above (grep -r on src/*.js) missed
// it entirely: same "invisible to this whole sweep" shape, from a different half of the
// codebase. Two distinct failure shapes share this one stage:
//   - "STRUCTURALLY OVERSIZED" (short-circuited to blocked/ on the FIRST draft attempt
//     when adhoc-agentic-draft.js's own internal turn-budget retry already ran out of
//     turns twice in a row) -- the mechanism's OWN comment says a bigger budget alone
//     won't fix this, so a blind retry would just reproduce the identical timeout. This
//     needs a human decompose/scope decision, never a redraft attempt.
//   - the generic "draft call failed N times in a row ... giving up rather than
//     retrying every tick forever" (DRAFT_FAILURE_RETRY_LIMIT exhausted, non-infra) --
//     an ordinary content/model-variance failure that plausibly DOES differ on a fresh
//     pass, so this gets the same bounded blind retry as every other retryable block.
const DRAFT_STRUCTURALLY_OVERSIZED_RE = /STRUCTURALLY OVERSIZED/i;
function isDraftFailureBlock(task) {
  return task.blockedStage === 'draft';
}
function isStructurallyOversizedDraftFailure(task) {
  return isDraftFailureBlock(task) && DRAFT_STRUCTURALLY_OVERSIZED_RE.test(String(task.blockedReason || ''));
}

// 2026-09-17: local-draft.js's plan-pass degenerate check (planResult.degenerate --
// "truncated" or "empty", after its own internal reroll-at-higher-temperature already
// failed to produce a usable plan) used to set NO blockedStage at all -- invisible to
// every check in this file (isReviewRejection/retryableDraftBlock/isPreCritiqueBlock/
// isDraftFailureBlock all miss it), and the task's own `status` field is often left at
// 'pending' too (never flipped to 'blocked'), even though the FILE sits in queue/blocked/.
// Confirmed live: 2 of 4 currently-stuck coordinator-hub children in Hub Tasks were
// gated on exactly this shape, and the fix's own code comments elsewhere in this
// codebase cite "21 of ~99 blocked tasks" hitting it historically -- likely the single
// highest-volume unrecognized block shape found this session. A blind retry is exactly
// as appropriate here as for a review rejection or a generic draft-call failure: this is
// model variance (the SAME plan-pass reroll-and-still-degenerate shape reject-retry-
// check.js already treats as retryable everywhere else), not a structural dead end.
function isPlanDegenerateBlock(task) {
  return task.blockedStage === 'plan';
}

// 2026-09-21: blockedStage:'implement' -- local-draft.js's IMPLEMENT-pass degenerate check ("Implement pass degenerate: empty" / "truncated", after callImplementModel's own
// internal retries) set NO blockedStage at all, the exact shape isPlanDegenerateBlock's header describes for the plan pass: invisible to every check here, the file sitting in
// queue/blocked/ (status often still 'pending') forever. function-length-fix-ac-34 was stuck a day on it. Same reasoning: model variance, a bounded blind retry is right; the
// plan is fine (it completed) so it is kept, only the unusable implement output is cleared.
function isImplementDegenerateBlock(task) {
  return task.blockedStage === 'implement';
}

module.exports = { deterministicReviewRecoveryCheck, forbiddenPathBlockNamesOwnTarget, computeBlockSignature, invalidPremiseBeforeCheckExisted, alreadyEscalatedSinceLastReadmission, isReviewRejection, isPreCritiqueBlock, isPreImplementBlock, isDraftFailureBlock, isStructurallyOversizedDraftFailure, isPlanDegenerateBlock, isImplementDegenerateBlock };
