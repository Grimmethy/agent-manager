'use strict';

// Reject-retry-requeue: a task genuinely REJECTED by review (blockedStage==='review', not
// a crash/domain-error block) gets moved back to queue/pending/ for a fresh redraft,
// capped at MAX_LOCAL_REJECT_RETRIES attempts, tracked via `localRejectCount` on the
// task JSON. Port of queue-watchdog.ps1's Invoke-RejectRetryCheck -- the only piece of
// that script ported here (its other job, dead-process detection/restart, is a separate,
// not-yet-ported gap; see queue-watcher.sh's own header). Without this, blockedStage:
// 'review' is a permanent dead end on Linux -- confirmed live 2026-08-14: 17 real blocked
// tasks, zero retries, because nothing was ever wired to look at localRejectCount at all.
//
// Not a blind retry: specific rejection reasons (including find-string mismatches, see
// local-draft.js's finalizeCandidateFulfillment) are carried in
// task.priorRejectionFeedback and injected into the next plan/implement prompt as a hard
// constraint via prompts.js's priorRejectionBlock() -- the redraft is told exactly which
// prior mistakes it must not repeat, not left to guess why it failed.
//
// Trimmed to what's actually reachable via task-domains.json on this deployment: the
// exhaustion-stamping side effect is ported for deep_dive (wired, real coverage file)
// but NOT arch_discovery/arch_import (neither domain is reachable here -- see
// local-draft.js's own scope note). model-stats-db recording (Invoke-ModelStatsDb in the
// reference) is analytics, not core correctness, and is left out.
//
// CLI: node reject-retry-check.js
// Writes ONE line of JSON summary to stdout: { checked, requeued, exhausted, errors }

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getConfig, ensureRegistered } = require('./config.js');
const { recordOutcome: defaultRecordModelOutcome } = require('./model-stats-client.js');
const { appendHistoryEvent } = require('./task-history.js');
const { classifyBlockedTask, findClassifier, hasInvalidPremise } = require('./blocked-task-classifiers.js');
const { extractDeclaredTargets, pathsRefEqual } = require('./adhoc-diff-sanity.js');
const { fileGhostDebt } = require('./ghost-debt.js');
const { acquire, release, taskMoveLockKey } = require('./single-flight-lock.js');
const { sharedInstancesDir } = require('./instances-dir.js');

// Task-move lock (2026-09-27): every requeue/escalation below used to be a plain,
// unguarded write-then-unlink -- no atomic rename, no check for whether a file for this
// task id already exists elsewhere in queue/. Confirmed live: this sweep independently
// reprocessing an earlier snapshot of a task id while it was ALSO being moved by hand
// forked into three files across three queue directories, no error anywhere. Wraps the
// write+unlink pair in the same real flock(2) mutex single-flight-lock.js already
// provides for GPU/model-call exclusion, keyed by task id instead of model name.
// skipPriorityBackoff is always true here -- a queue-directory move touches no GPU and
// must never wait on unrelated Discuss/chat activity.
function writeTaskAndUnlinkOld(instancesDir, task, destPath, srcPath) {
  const handle = acquire(instancesDir, taskMoveLockKey(task.id), { skipPriorityBackoff: true });
  try {
    fs.writeFileSync(destPath, JSON.stringify(task, null, 2));
    if (path.resolve(srcPath) !== path.resolve(destPath)) fs.unlinkSync(srcPath);
  } finally {
    release(handle);
  }
}
const { getRegisteredSource, resolveSourceName } = require('./task-source-registry.js');
const { isCandidateFulfillmentSource, isAdvisoryProseSource } = require('./lib/harness-search.js');
const { deterministicReviewRecoveryCheck, forbiddenPathBlockNamesOwnTarget, computeBlockSignature, invalidPremiseBeforeCheckExisted, stalePremiseGateNoLongerFires, alreadyEscalatedSinceLastReadmission, isReviewRejection, isPreCritiqueBlock, isPreImplementBlock, isDraftFailureBlock, isStructurallyOversizedDraftFailure, isPlanDegenerateBlock, isImplementDegenerateBlock } = require('./lib/reject-retry-check.js');
// 2026-09-16: registers this package's built-in sources (side effect of the require) --
// deterministicReviewRecoveryCheck below looks a task's source up in this SAME registry
// (getRegisteredSource), but this file itself never required task-sources.js, so a
// standalone `node reject-retry-check.js` process (this CLI's own real, documented entry
// point -- see scripts/queue-watcher.sh) started with a completely EMPTY registry: every
// lookup silently returned undefined, and the whole recovery feature was inert in
// production despite passing its own unit tests (which register a fake source directly,
// bypassing this exact gap). ensureRegistered() covers a consumer's own plugin-registered
// sources too (get-grounding-source.js's own header explains why both calls are needed
// together) -- deterministicReview is source-agnostic by design, so a future plugin-
// registered source should be covered by this recovery path too, not just today's one
// built-in user (brain_dump_sort).
require('./task-sources.js');
try { ensureRegistered(); } catch { /* no live config (e.g. a unit test) -- fine, nothing to register */ }

const MAX_LOCAL_REJECT_RETRIES = 2;

// Fields wiped when a task is re-admitted with a CLEAN SLATE (not a blind redraft, which
// keeps priorRejectionFeedback + increments localRejectCount). Kept deliberately in sync
// with needs-clarification-triage.js's REQUEUE_STRIP_FIELDS -- same intent: a fresh start
// for a task whose accumulated failure state was an artifact of a bug, not a real signal.
const READMIT_CLEAN_SLATE_FIELDS = [
  // ncTriageAttempts is the pre-2026-09-16 flat counter, kept here so an older task record
  // still carrying it gets cleaned up too; ncTriageBucketAttempts is its per-bucket
  // replacement (see needs-clarification-triage.js's own header on why buckets no longer
  // share one counter).
  'needsClarification', 'localRejectCount', 'ncTriageAttempts', 'ncTriageBucketAttempts', 'ncTriageDecision', 'ncTriageReviewedAt',
  'retryableDraftBlock', 'turnBudgetExhausted', 'turnBudgetExhaustedBefore',
  'infraErrorRetry', 'infraErrorNote', 'adhocResolution', 'subTaskProposals',
  'priorRejectionFeedback', 'rawDiff', 'implementResponse', 'blockedReason', 'blockedStage', 'claimedAt',
  'isAgenticContinuation', 'agenticContinuationCount', 'agenticContinuationNote', 'priorPartialDiff',
  'adhocDiffSubstanceFeedback', 'adhocNoChangesClaimFeedback', 'premiseReadmitCount',
  '_prevBlockSignature',
  // 2026-09-22, root-caused live via pipeline-forensics-fix-ac-133: reviewInconclusive is
  // stamped by local-draft.js/implement-critique.js's OWN stochastic gate flake at the time
  // of ONE specific block (e.g. an "Invalid premise:" postImplementCheck rejection) so
  // isReviewRejection() can tell that flake apart from a genuine reviewer REJECT. It was
  // missing from this list, so a clean-slate readmit (invalid-premise or forbidden-path)
  // left it sitting on the task -- and if the NEXT draft attempt then earned a real,
  // two-vote review-stage REJECT (a completely different block, unrelated to the one that
  // set the flag), isReviewRejection() still read the stale flag and returned false. That
  // silently dropped the task out of every branch in this sweep's entry gate: not a review
  // rejection, not any retryable-draft/pre-critique/pre-implement/invalid-premise shape
  // either -- invisible forever, parked in blocked/ with a genuine rejection reason and no
  // path to a redraft OR an escalation. Confirmed live: pipeline-forensics-fix-ac-133 sat
  // blocked 3 days with two clean REJECT votes on record, silently skipped by every tick.
  'reviewInconclusive',
];

// 2026-10-01: blockedStage:'critique' -- implement-critique.js's runCritiqueAndRevision now BLOCKS a draft whose critique call came back degenerate (empty / truncated) instead of
// letting it flow on to the review vote un-critiqued (a rubber-stamp; roughly 6% of critiqued tasks). Wired into this entry gate in the SAME change that introduces the stage, because
// every earlier stage that shipped without it sat in queue/blocked/ forever (see the plan / implement / pre-critique notes above). The draft itself was fine and the critique model
// had a bad moment, so a bounded blind retry is right: the attempt re-runs from the top (draftTask clears the stale blockedStage first) and is capped like every other retry.
function isCritiqueDegenerateBlock(task) {
  return task.blockedStage === 'critique';
}

// Same reasoning as queue-watchdog.ps1's arch_discovery/arch_import stamping (not ported
// here, see header) -- deep_dive's own coverage tracker: without this, a community whose
// task exhausts its retries stays eligible for nextDeepDiveTask() to re-select FOREVER
// (deep-dive-coverage.json's per-project communities[].lastReviewedAt never gets touched by
// anything on the rejection path otherwise), so the deep_dive rotation starves on one
// permanently-doomed community instead of moving on to the rest.
function stampDeepDiveExhausted(task, deepDiveCoveragePath) {
  if (task.source !== 'deep_dive') return;
  if (!task.promptContext || !task.promptContext.projectSlug || task.promptContext.communityId == null) return;
  if (!deepDiveCoveragePath || !fs.existsSync(deepDiveCoveragePath)) return;
  try {
    const coverage = JSON.parse(fs.readFileSync(deepDiveCoveragePath, 'utf8'));
    const proj = coverage.projects && coverage.projects[task.promptContext.projectSlug];
    if (!proj || !Array.isArray(proj.communities)) return;
    const entry = proj.communities.find((c) => c.id === Number(task.promptContext.communityId));
    if (entry && !entry.lastReviewedAt) {
      entry.lastReviewedAt = new Date().toISOString();
      entry.actionItemCount = -1; // sentinel: exhausted retries, never a real action-item count
      fs.writeFileSync(deepDiveCoveragePath, JSON.stringify(coverage, null, 2));
    }
  } catch (e) {
    // Non-fatal -- same "warn and move on" treatment the reference gives this stamp.
    console.warn('[reject-retry-check] coverage write failed:', e.message);
  }
}

function isAdhocTask(task) {
  return task.domain === 'adhoc' || task.source === 'manual';
}

// 2026-09-06: classification (unreliable-grounding, external-dependency, and every
// keyword category) moved to src/blocked-task-classifiers.js -- the same registry
// pipeline-self-audit.js's cluster-reporting now uses, so a category discovered in
// either mechanism benefits both. See that file's own header for the fault-side
// research (arXiv 2607.28802) behind treating "would a blind retry reproduce this
// exact failure?" as the deciding question, not the failure's mere existence.

// On a brain_dump_sort task exhausting its redrafts, bump the originating brain-dump
// entry's sortAttempt -- so nextBrainDumpSortTask regenerates the sort under a fresh id
// (…-aN) instead of the entry being stuck 'captured' forever behind this blocked record.
// Mirrors stampDeepDiveExhausted's "advance the source's own cursor" role.
function stampBrainDumpSortExhausted(task, brainDumpPath) {
  if (task.source !== 'brain_dump_sort') return;
  const entryId = task.promptContext && task.promptContext.brainDumpEntryId;
  if (!entryId || !brainDumpPath || !fs.existsSync(brainDumpPath)) return;
  try {
    const data = JSON.parse(fs.readFileSync(brainDumpPath, 'utf8'));
    const entry = Array.isArray(data.entries) && data.entries.find((e) => e && e.id === entryId);
    if (entry) {
      entry.sortAttempt = (entry.sortAttempt || 0) + 1;
      fs.writeFileSync(brainDumpPath, JSON.stringify(data, null, 2));
    }
  } catch (e) {
    console.warn('[reject-retry-check] brain-dump sortAttempt bump failed:', e.message);
  }
}

// The pre-filled question a human sees when an adhoc rejection has burned all its blind
// redrafts. The commonest cause (confirmed live: the NSFW-images task) is the handler
// deciding a request to EXTEND an existing feature is already done -- so the question
// steers the human straight at that.
function buildExhaustedAdhocQuestion(task) {
  const reasons = (Array.isArray(task.priorRejectionFeedback) ? task.priorRejectionFeedback : [])
    .concat(task.blockedReason ? [String(task.blockedReason)] : [])
    .filter(Boolean);
  const verdictNote = task.adhocResolution === 'no-changes-needed'
    ? 'The automated handler concluded this needs NO changes (RESOLUTION: no-changes-needed), but review rejected that every time:'
    : `The automated handler could not get this past review after ${MAX_LOCAL_REJECT_RETRIES + 1} attempts:`;
  return [
    verdictNote,
    ...reasons.map((r, i) => `  ${i + 1}. ${r}`),
    '',
    'If this is a request to EXTEND an existing feature (a "should also", a "when X, also Y", '
      + 'or it names a different object than a similarly-named feature already covers), say '
      + 'exactly what should change and which file(s). If it is genuinely already done, use Archive.',
  ].join('\n');
}

// 2026-09-18 (brain-dump bd-1789702787675, "every candidate-fulfillment _fix task has no
// exhaustion-to-human escalation path"): a candidate-fulfillment task's implement
// response is an exact find/replace against real file content fetched at candidate-
// creation time -- when the real file has since moved (someone else already fixed it,
// or just touched nearby code), every retry re-anchors against the same stale citation
// and reproduces the identical rejection forever. Investigated 10 real blocked _fix
// tasks live: 9 of 10 were exactly this, permanently stuck because the ONLY other
// mechanism watching them (context-trim-sweep.js's contextTrimFlag) writes a
// disposition:'needs-human-regrounding' flag that nothing ever consumes -- a label with
// no reader. This question steers the human at that specific failure shape first,
// since it's the dominant one, without assuming it (a genuinely-wrong candidate premise
// or a degenerate empty pass are also possible and named explicitly).
function buildExhaustedFulfillmentQuestion(task) {
  const reasons = (Array.isArray(task.priorRejectionFeedback) ? task.priorRejectionFeedback : [])
    .concat(task.blockedReason ? [String(task.blockedReason)] : [])
    .filter(Boolean);
  return [
    `The automated handler could not get this candidate past review/apply after ${MAX_LOCAL_REJECT_RETRIES + 1} attempts:`,
    ...reasons.map((r, i) => `  ${i + 1}. ${r}`),
    '',
    "Common cause: the candidate's citation (file/line/find-string) no longer matches the "
      + 'real source -- something else may have already changed or fixed it; check the real '
      + 'file before redrafting. If the underlying issue is already fixed, Archive this task. '
      + 'If the citation is just stale, correct it and requeue. Otherwise, say what a fresh '
      + 'draft needs to do differently.',
  ].join('\n');
}

// 2026-09-18 (ghost-in-the-machine retroactive audit of the blocked/ bucket, sibling
// finding to bd-1789702787675 above): the "_fix" candidate-fulfillment sources got a real
// exhaustion-to-human escalation yesterday, but their TRIAGE-stage siblings -- the
// advisoryProse "_review" scanner sources (performance_review, function_length_review,
// observability_review(_digest), change_review, staleness_audit,
// second_brain_opportunities) that render a GENUINE / FALSE POSITIVE / UNCERTAIN verdict,
// not a code diff -- were never in scope for that fix (isCandidateFulfillmentSource is
// false for all of them) and fall into the exact same dead end: stamped 'exhausted' and
// left in blocked/ permanently, no recovery, no human-facing exit. Confirmed live on 6 of
// the 10 tasks remaining in blocked/ after that fix. Their own failure vocabulary is
// different from a fulfillment candidate's (a malformed/missing verdict label, a refusal
// to render a decisive verdict, a claim contradicted by the grounding snippet) rather than
// "citation went stale" -- this question steers the human at THAT shape instead.
// pipeline_forensics/pipeline_debrief are deliberately excluded even though they are also
// advisoryProse: their cursor-based creation means an exhausted window's own tasks are
// usually already moot by the time they exhaust (a later window supersedes it), not
// something a human needs to individually triage -- see this session's own manual
// retirement of 24 exhausted pipeline_debrief tasks for exactly that reasoning.
const REVIEW_VERDICT_ADVISORY_PROSE_EXCLUDED = new Set(['pipeline_forensics', 'pipeline_debrief']);

function isReviewVerdictAdvisoryProseSource(source) {
  return isAdvisoryProseSource(source) && !REVIEW_VERDICT_ADVISORY_PROSE_EXCLUDED.has(source);
}

function buildExhaustedReviewVerdictQuestion(task) {
  const reasons = (Array.isArray(task.priorRejectionFeedback) ? task.priorRejectionFeedback : [])
    .concat(task.blockedReason ? [String(task.blockedReason)] : [])
    .filter(Boolean);
  return [
    `The automated handler could not render a verdict that passed review after ${MAX_LOCAL_REJECT_RETRIES + 1} attempts:`,
    ...reasons.map((r, i) => `  ${i + 1}. ${r}`),
    '',
    'Common causes: the flagged snippet genuinely needs more surrounding context to judge '
      + '(the model kept refusing to commit to GENUINE/FALSE POSITIVE/UNCERTAIN, or omitted '
      + 'the required verdict label), or a claimed finding is contradicted by the real '
      + 'grounding source shown to the model. Read the flagged snippet/finding yourself: if '
      + "it's a real issue, render the verdict directly and Approve; if it's a false positive, "
      + 'Archive it. If more real context would let a fresh draft succeed, say what to fetch.',
  ].join('\n');
}

// The directory-discovery half of rejectRetryCheck, extracted so the "which
// directories do we scan, and what entries do they yield" policy is a named,
// independently unit-testable unit (mock fs.readdirSync, assert the shape of the
// returned array) rather than inlined in the ~200-line orchestrator. No behavioral
// change: same three scans, same missing-dir swallowing, same status filter.
function discoverBlockedEntries({ blockedDir, adhocDir, derivedDir }) {
  const entries = [];
  try {
    for (const n of fs.readdirSync(blockedDir).filter((f) => f.endsWith('.json'))) {
      entries.push({ dir: blockedDir, name: n });
    }
  } catch (e) {
    // blocked/ doesn't exist yet -- fall through, the adhoc/ scan below may still have work.
  }
  // An adhoc tier draft-stage block writes the task file back IN PLACE in queue/adhoc/ --
  // it never moves to blocked/. So a genuinely blocked adhoc task (retry cap hit, a
  // real review rejection, ...) that happens to still be sitting in adhoc/ is invisible
  // to this sweep: no blind retry, no needs-clarification escalation, forever. Confirmed
  // live 2026-09-02: adhoc-...-plugins-install-...-1, blockedStage 'review',
  // localRejectCount 2/2, stranded in queue/adhoc/. Pick those up here too -- everything
  // downstream already keys off isAdhocTask(task) and the per-entry source dir.
  // queue/derived/ (source: derived_task) is adhoc-SHAPED, so a draft-stage block writes
  // back in place there the same way -- sweep it too.
  for (const inPlaceDir of [adhocDir, derivedDir]) {
    if (!inPlaceDir) continue;
    try {
      for (const n of fs.readdirSync(inPlaceDir).filter((f) => f.endsWith('.json'))) {
        try {
          const t = JSON.parse(fs.readFileSync(path.join(inPlaceDir, n), 'utf8'));
          if (t && t.status === 'blocked') entries.push({ dir: inPlaceDir, name: n });
        } catch { /* unparseable -- not this sweep's problem */ }
      }
    } catch { /* dir absent -- fine */ }
  }
  return entries;
}

// The exhaustion half of rejectRetryCheck, extracted so the "what happens when the
// blind-redraft cap is spent" policy (escalate adhoc/fulfillment/review-verdict to a
// human, otherwise stamp-and-stay in blocked/) is a named, independently unit-testable
// unit -- idempotency guards, ghost-debt filing, file move, and history appends all
// atomic within one function -- rather than a ~55-line block buried mid-orchestrator.
// Mutates task (and the on-disk artifacts) in place and returns 'escalated' (a
// needs-clarification escalation ran), 'skipped' (an idempotency guard -- already
// escalated/stamped since the last readmission -- bailed it out), or 'stamped' (the
// stamp-and-stay path ran). Does NOT touch summary: the caller increments
// summary.exhausted exactly once per call regardless of outcome, so the total is
// identical to the block it replaced. No behavioral change: same guard order, same
// side-effect order, same payloads, same file moves.
function handleExhaustion({ task, name, sourceDir, needsClarificationDir, deepDiveCoveragePath, brainDumpPath, ghostRoot, retryCount }) {
  const filePath = path.join(sourceDir, name);
  // writeTaskAndUnlinkOld needs the per-instance lock dir; rejectRetryCheck derives it
  // from pipelineDir (or, for tests that omit that, from blockedDir). Every per-entry
  // source dir (blocked/ or adhoc-/derived/ in-place) sits under <root>/queue/, so the
  // same root is derivable here from ghostRoot (rejectRetryCheck's own pipelineDir) or
  // sourceDir for callers that pass neither.
  const instancesDir = sharedInstancesDir(ghostRoot || path.dirname(path.dirname(sourceDir)));
  const isFulfillment = isCandidateFulfillmentSource(task.source);
  const isReviewVerdict = isReviewVerdictAdvisoryProseSource(task.source);
  if ((isAdhocTask(task) || isFulfillment || isReviewVerdict) && needsClarificationDir) {
    const alreadyEscalated = alreadyEscalatedSinceLastReadmission(task);
    if (alreadyEscalated) return 'skipped';
    // A task that exhausted its retries on a tagged tool/environment failure lands
    // with an honest reason:'infra-error' -- not design-decision -- so forensics and
    // the triage sweep see it for what it is. (nc.reason already carries non-
    // design-decision values elsewhere: external-dependency, unreliable-grounding.)
    //
    // 2026-09-22 (needs-clarification bucket review): every OTHER exhausted
    // candidate-fulfillment/review-verdict/adhoc task got blanket-labeled
    // 'design-decision' regardless of what actually blocked it -- classifyBlockedTask
    // already ran above (line ~650) and, since it's retryable:true here (a
    // non-retryable verdict would have escalated immediately and never reached this
    // branch), its category is a precise, real cause: a stale/fabricated citation
    // (fabricated-ungrounded-claim), a refusal instead of a diff
    // (refusal-no-changes-needed), a degenerate plan/implement, a JSON parse
    // failure, or an inconclusive-review flake that happened three times running.
    // Confirmed live: 9+ of the real 26-task needs-clarification bucket were exactly
    // this -- a stale citation or a refusal, not a product/architecture question --
    // yet every one read 'design-decision', indistinguishable from a genuine one.
    // 'uncategorized' still falls back to 'design-decision' (unchanged behavior for
    // the majority that really are open questions). needs-clarification-triage.js's
    // own reason allowlist is extended in the same PR to keep every one of these
    // categories triage-eligible -- exactly the class of gap its own comments
    // describe fixing for 'infra-error' (see this file's own header there).
    // Re-classified here (identical deterministic classifier, same task object) since
    // the call site's `classification` local is not part of this helper's signature.
    const exhaustedCategory = classifyBlockedTask(task).category !== 'uncategorized' ? classifyBlockedTask(task).category : 'design-decision';
    task.needsClarification = {
      reason: task.infraErrorBefore ? 'infra-error' : exhaustedCategory,
      openQuestions: isFulfillment ? buildExhaustedFulfillmentQuestion(task)
        : isReviewVerdict ? buildExhaustedReviewVerdictQuestion(task)
          : buildExhaustedAdhocQuestion(task),
    };
    appendHistoryEvent(task, 'exhausted', `${retryCount}/${MAX_LOCAL_REJECT_RETRIES} retries used`);
    appendHistoryEvent(task, 'needs-clarification', 'escalated to a human after exhausting redraft retries');
    // Blind redrafts were spent and nothing re-admitted this class -- ghost debt.
    if (ghostRoot) fileGhostDebt({ task, reasonText: task.blockedReason, site: 'reject-retry-check:retry-cap-exhausted', pipelineDir: ghostRoot });
    fs.mkdirSync(needsClarificationDir, { recursive: true });
    writeTaskAndUnlinkOld(instancesDir, task, path.join(needsClarificationDir, name), filePath);
    return 'escalated';
  }
  // Already stamped on a prior tick -- an exhausted task stays in blocked/
  // permanently (nothing here ever moves or deletes it), so without this guard this
  // whole branch re-fires every single tick forever. Confirmed live 2026-08-17: one
  // real exhausted task accumulated 20+ duplicate 'exhausted' history entries (one
  // per ~30s tick) over about 12 minutes before this was caught, unbounded growth
  // for as long as the task sits there -- which, being exhausted, is indefinitely.
  const alreadyStamped = Array.isArray(task.history) && task.history.some((h) => h.stage === 'exhausted');
  if (alreadyStamped) return 'skipped';
  stampDeepDiveExhausted(task, deepDiveCoveragePath);
  stampBrainDumpSortExhausted(task, brainDumpPath);
  // Persist the exhaustion itself onto the task -- previously this branch never
  // wrote the file back at all, so a task permanently stuck in queue/blocked/ after
  // hitting the retry cap carried no record that retries were ever attempted or
  // exhausted; only localRejectCount (no timestamp) hinted at it.
  appendHistoryEvent(task, 'exhausted', `${retryCount}/${MAX_LOCAL_REJECT_RETRIES} retries used`);
  fs.writeFileSync(filePath, JSON.stringify(task, null, 2));
  return 'stamped';
}

// selectFeedbackBranch / buildFeedbackString: the "what does the next pass see" policy for a requeued blocked task, extracted from rejectRetryCheck's
// inline 12-branch `if / else if` feedback chain. The chain was EXCLUSIVE -- only the first matching branch ran, and only that branch's field deletion --
// so the choice is made ONCE, here, in precedence order, and both the feedback text (buildFeedbackString) and the field cleanup in rejectRetryCheck follow
// that single decision. (The first extraction re-wrapped each branch's deletion in its own independent `if`, so a task matching several conditions had
// several cleanups run, e.g. a continuation that also carried a rescoped scope overwrote promptContext.rawText, and a pointed feedback field was
// deleted without ever being shown.) Both functions are pure: no mutation, no I/O.
//   continuation > rescoped-from-decompose > turn-budget-exhausted > adhoc-diff-substance > adhoc-no-changes-claim > infra-error-note >
//   malformed-decompose JSON > pre-critique block > pre-implement block > draft-call failure > plan-degenerate > default
function selectFeedbackBranch({ task, isContinuation, retryableDraftBlock, preCritiqueBlock, preImplementBlock, draftFailureBlock, planDegenerateBlock }) {
  if (isContinuation) return 'continuation';
  if (retryableDraftBlock && task.rescopedFromDecompose === true && typeof task.rescopedRawText === 'string' && task.rescopedRawText.trim()) return 'rescoped';
  if (retryableDraftBlock && task.turnBudgetExhausted === true) return 'turn-budget';
  if (retryableDraftBlock && typeof task.adhocDiffSubstanceFeedback === 'string' && task.adhocDiffSubstanceFeedback.trim()) return 'diff-substance';
  if (retryableDraftBlock && typeof task.adhocNoChangesClaimFeedback === 'string' && task.adhocNoChangesClaimFeedback.trim()) return 'no-changes-claim';
  if (retryableDraftBlock && typeof task.infraErrorNote === 'string' && task.infraErrorNote.trim()) return 'infra-error';
  if (retryableDraftBlock) return 'malformed-decompose';
  if (preCritiqueBlock) return 'pre-critique';
  if (preImplementBlock) return 'pre-implement';
  if (draftFailureBlock) return 'draft-failure';
  if (planDegenerateBlock) return 'plan-degenerate';
  return 'default';
}

function buildFeedbackString(ctx) {
  const { task } = ctx;
  const branch = ctx.branch || selectFeedbackBranch(ctx);
  switch (branch) {
    case 'continuation':
    return [
      'This is a CONTINUATION, not a fresh start. A prior pass got partway through and ran out of turns. It reported this remaining work:',
      '',
      String(task.agenticContinuationNote || '').slice(0, 4000),
      task.priorPartialDiff
        ? '\nThe edits it already made are ALREADY APPLIED to your worktree as uncommitted changes (agentic-draft-common.js applies the carried diff before you start). Run git diff / read the files to confirm what is there; do NOT redo those edits -- build on them.'
        : '',
      '',
      'Start editing with edit_file/write_file within your first 1-2 turns from where it left off. Finish the remaining work and end with RESOLUTION: implemented.',
    ].filter(Boolean).join('\n');
    case 'rescoped':
    return `A prior pass decided this task's real scope is exactly: ${task.rescopedRawText}\nThat is the task now. Implement THAT with edit_file/write_file in this pass. Do not decompose again.`;
    case 'turn-budget':
    return 'A prior attempt spent its whole turn budget exploring and made ZERO edits. Do not re-explore from scratch: the PLAN and PRIOR INVESTIGATION are already in your prompt -- use them, get to a concrete edit_file within the first few turns, and answer RESOLUTION: decompose if the task is genuinely too large to finish in one pass.';
    case 'diff-substance':
    return task.adhocDiffSubstanceFeedback;
    case 'no-changes-claim':
    return task.adhocNoChangesClaimFeedback;
    case 'infra-error':
    return [
      'A prior attempt hit a tool/environment failure (not a design question):',
      '',
      String(task.infraErrorNote).slice(0, 3000),
      '',
      'Retry the operation from a clean pass. If a command genuinely fails identically again, end with RESOLUTION: needs-human-decision and BLOCKER-TYPE: infra-error, quoting the exact command and its full error output.',
    ].join('\n');
    case 'malformed-decompose':
    return 'A prior attempt chose RESOLUTION: decompose but the sub-task JSON was malformed. If this task is doable in one pass, just implement it. If it genuinely needs splitting, end with EXACTLY "RESOLUTION: decompose" then, on the next lines, a single valid JSON array of 2+ objects each shaped {"title": "...", "rawText": "..."} and nothing else.';
    case 'pre-critique':
    return [
      'A prior implementation was blocked before review because it cited a file that does not actually exist in the repo:',
      '',
      String(task.blockedReason || ''),
      '',
      'Only reference files that are actually present in the repo (verify with a tool call before citing one). If this task genuinely requires a brand-new file, create it with write_file/edit_file in create mode -- do not just describe or reference it as if it already exists.',
    ].join('\n');
    case 'pre-implement':
    return [
      'A prior plan was blocked before implementation because it named an edit target that does not actually exist in the repo:',
      '',
      String(task.blockedReason || ''),
      '',
      'Only declare edit targets that are actually present in the repo (verify with a tool call before naming one). If this task genuinely requires a brand-new file, say so explicitly (e.g. "create `path`") so it is recognized as a create target, not a citation of an existing file.',
    ].join('\n');
    case 'draft-failure':
    return [
      'A prior draft attempt failed outright (not a content rejection or a design question) after repeated tries:',
      '',
      String(task.blockedReason || ''),
      '',
      'Try again from a clean pass.',
    ].join('\n');
    case 'plan-degenerate':
    return [
      'A prior plan pass produced a degenerate (truncated or empty) plan even after an internal higher-temperature reroll:',
      '',
      String(task.blockedReason || ''),
      '',
      'Try a fresh plan pass. Keep the plan concrete and complete -- do not truncate mid-thought.',
    ].join('\n');
    default:
    return String(task.blockedReason || '');
  }
}

function rejectRetryCheck({ blockedDir, pendingDir, adhocDir, derivedDir, needsClarificationDir, deepDiveCoveragePath, brainDumpPath, pipelineDir, approvedDir, repoRoot: repoRootOverride, recordModelOutcome = defaultRecordModelOutcome }) {
  const summary = { checked: 0, requeued: 0, exhausted: 0, recovered: 0, errors: 0 };
  // blockedDir is always <pipelineDir>/queue/blocked in every real caller -- this fallback
  // only matters for tests that don't bother passing pipelineDir explicitly (it was never
  // load-bearing before the move-lock existed); a real caller always passes it directly.
  const instancesDir = sharedInstancesDir(pipelineDir || path.dirname(path.dirname(blockedDir)));
  // Ghost-debt needs the pipeline root for its state file + the side-finding inbox.
  // Derive it from needsClarificationDir (<pipelineDir>/queue/needs-clarification) when a
  // caller (older tests) didn't pass it explicitly.
  const ghostRoot = pipelineDir
    || (needsClarificationDir ? path.dirname(path.dirname(needsClarificationDir)) : null);
  // Lazy, best-effort (deterministicReviewRecoveryCheck below tolerates undefined) -- same
  // "read env inside the sweep, never at module load, never let a missing config block a
  // sweep tick" discipline every other watchdog sweep in this codebase already follows.
  // Callers that pass approvedDir explicitly (tests) skip this derivation entirely.
  const approvedDirResolved = approvedDir
    || (ghostRoot ? path.join(ghostRoot, 'queue', 'approved') : null);
  let recoveryConfig = {};
  try { recoveryConfig = getConfig(); } catch { /* no live config (e.g. a unit test) -- recovery check just no-ops */ }
  // repoRoot: an explicit caller/test override wins over the live config (the stale-premise re-admission below checks files against it).
  const sweepRepoRoot = repoRootOverride || recoveryConfig.repoRoot;
  const entries = discoverBlockedEntries({ blockedDir, adhocDir, derivedDir });

  if (entries.length === 0) return summary;

  for (const { dir: sourceDir, name } of entries) {
    const filePath = path.join(sourceDir, name);
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      if (!raw) continue;
      const task = JSON.parse(raw);
      summary.checked++;

      // A source can opt out of blind-redraft-and-retry entirely
      // (registerTaskSource(name, { noAutoRetry: true })) -- e.g. wikiforge's
      // wiki_transcript_extract/wiki_page_promote, where a full redraft costs a genuine
      // 15-40min plan+implement+critique cycle and, running a large batch overnight, the
      // operator would rather move on to the next item than spend that time re-attempting
      // one that already failed once ("one attempt and done"). Checked before any of the
      // eligibility classifiers below so it applies uniformly regardless of WHY the task
      // blocked; the task is simply left as-is in blocked/ for a human to look at later,
      // same as any task this sweep was never eligible to touch at all.
      const noAutoRetryEntry = getRegisteredSource(resolveSourceName(task));
      if (noAutoRetryEntry && noAutoRetryEntry.noAutoRetry === true) continue;

      // Only a genuine review-stage rejection is eligible -- never an apply-stage failure
      // that happens to still carry localVotes from an earlier, unrelated successful
      // review (redrafting can't fix that; see agent-manager-common.sh's
      // test_review_rejection, the bash equivalent of this exact check).
      //
      // 2026-09-01: also eligible -- an adhoc tier-3 draft-stage block that a redraft could
      // plausibly fix (resolveAgenticDraft sets task.retryableDraftBlock):
      //   - the model exhausted its turn budget without making a single edit
      //     (task.turnBudgetExhausted) -- the redraft is NOT blind: plan + tier-2
      //     investigation are folded into the prompt and the feedback below says "edit early".
      //   - the model chose RESOLUTION: decompose but botched the sub-task JSON -- a redraft
      //     can emit valid JSON or just implement the change; the feedback reminds it of the
      //     format.
      // Bounded by the same MAX_LOCAL_REJECT_RETRIES cap; on exhaustion it takes the same
      // adhoc -> needs-clarification escalation as a stuck review rejection.
      const retryableDraftBlock = isAdhocTask(task) && task.retryableDraftBlock === true;
      const preCritiqueBlock = isPreCritiqueBlock(task);
      const preImplementBlock = isPreImplementBlock(task);
      const draftFailureBlock = isDraftFailureBlock(task);
      const planDegenerateBlock = isPlanDegenerateBlock(task);
      const implementDegenerateBlock = isImplementDegenerateBlock(task);
      const critiqueDegenerateBlock = isCritiqueDegenerateBlock(task);
      // An "Invalid premise:" verdict is recognized whatever its blockedStage (or lack of
      // one) -- see invalidPremiseBeforeCheckExisted / hasInvalidPremise: it is either
      // re-admitted once or escalated by the classifier below, never left invisible.
      const invalidPremiseBlock = hasInvalidPremise(task);
      // A "sub-task premise may be stale" block whose gate no longer fires (it used to call a monorepo
      // sub-root file missing) is recognized whatever its stage -- re-admitted once below.
      const stalePremiseFalsePositive = stalePremiseGateNoLongerFires(task, { repoRoot: sweepRepoRoot });
      if (!isReviewRejection(task) && !retryableDraftBlock && !preCritiqueBlock && !preImplementBlock && !draftFailureBlock && !planDegenerateBlock && !implementDegenerateBlock && !critiqueDegenerateBlock && !invalidPremiseBlock && !stalePremiseFalsePositive) continue;

      // A continuation (agentic-draft-common.js: the model ran out of turns mid-
      // implementation, no real design question) is forward progress, not a failed
      // redraft -- it has its OWN cap (MAX_AGENTIC_CONTINUATIONS, enforced there) and must
      // not be gated by, or count against, the blind-redraft cap.
      const isContinuation = retryableDraftBlock && task.isAgenticContinuation === true;

      // A task already carrying ANY needsClarification (e.g. external-dependency,
      // stamped at DRAFT time by AC-13a; or a design-decision left by some other
      // mechanism) has already been triaged -- never overwrite or re-decide it, and
      // never let a stale blockedStage:'review' from an earlier, unrelated rejection
      // cycle re-enable a blind-retry loop for a task a human is already meant to be
      // looking at. Generalizes AC-13b's original external-dependency-specific check
      // (2026-09-06): once ANY prior mechanism flags a needed human decision, nothing
      // here should ever re-decide it, regardless of which reason string it used.
      if (task.needsClarification) continue;

      // A source with deterministicReview (mechanical validate, no model judgment) that was
      // blocked by that SAME validator -- re-run it against the existing implementResponse;
      // if the underlying rule has since been fixed and it now passes, this is exactly the
      // outcome a normal review pass would produce, so skip the wasted redraft and land it
      // straight in queue/approved/ instead. See deterministicReviewRecoveryCheck's own
      // header for the real incident this recovers. Checked before the forbidden-path
      // readmit below since it's a distinct, unrelated signal, not a fallback to it.
      if (deterministicReviewRecoveryCheck(task, { secondBrainDir: recoveryConfig.secondBrainDir, repoRoot: recoveryConfig.repoRoot })) {
        task.reviewedAt = new Date().toISOString();
        task.reviewProvider = 'deterministic-review-recovery';
        task.localVerdict = 'Auto-approved on re-check: the deterministic rule that originally blocked this has since been fixed, and the existing (unchanged) classification now passes it -- no redraft needed.';
        delete task.blockedReason;
        delete task.blockedStage;
        appendHistoryEvent(task, 'approved', 'reject-retry-check: deterministic-review-recovery -- re-validated against the existing implementResponse, now passes');
        recordModelOutcome({ callId: task.abCallId, outcome: 'approved', outcomeStage: 'watchdog', outcomeReason: 'deterministic-review-recovery' });
        summary.recovered += 1;
        if (approvedDirResolved) {
          try {
            fs.mkdirSync(approvedDirResolved, { recursive: true });
            writeTaskAndUnlinkOld(instancesDir, task, path.join(approvedDirResolved, name), filePath);
          } catch (e) {
            console.warn(`[reject-retry-check] deterministic-review-recovery move to approved/ failed for ${task.id || name}:`, e.message);
            summary.errors += 1;
          }
        }
        continue;
      }

      // Re-admit a task the (now-fixed) forbidden-path gate bug wrongly ran to exhaustion:
      // its block named one of its OWN declared edit targets, so no blind retry could ever
      // have differed. The pipeline itself brings it back -- clean slate, retry budget
      // reset -- exactly once (the forbiddenPathReadmitted stamp bounds it, so a task that
      // somehow still fails this way after the fix is not re-admitted forever). This is the
      // deterministic counterpart to an operator manually requeueing it.
      if (!task.forbiddenPathReadmitted && forbiddenPathBlockNamesOwnTarget(task)) {
        for (const f of READMIT_CLEAN_SLATE_FIELDS) delete task[f];
        task.forbiddenPathReadmitted = true;
        if (task.status === 'blocked') task.status = 'pending';
        appendHistoryEvent(task, 'requeued',
          "reject-retry-check: prior forbidden-path block named one of the task's own declared edit targets (adhoc-diff-sanity gate bug, since fixed) -- re-admitted with a clean slate, retry budget reset");
        recordModelOutcome({ callId: task.abCallId, outcome: 'requeued', outcomeStage: 'watchdog', outcomeReason: 'forbidden-path-false-positive-readmit' });
        const destDir = (task.source === 'derived_task' && derivedDir) ? derivedDir : (isAdhocTask(task) && adhocDir) ? adhocDir : pendingDir;
        fs.mkdirSync(destDir, { recursive: true });
        const newPath = path.join(destDir, name);
        writeTaskAndUnlinkOld(instancesDir, task, newPath, filePath);
        summary.requeued++;
        continue;
      }

      // Re-admit a task the (now-fixed) stale-premise gate wrongly blocked: it cited a file that
      // exists under a monorepo sub-root and the gate called it missing. The re-check above already
      // proved the gate no longer fires, so no blind retry is involved -- clean slate, exactly once
      // (the stalePremiseReadmitted stamp is deliberately NOT in READMIT_CLEAN_SLATE_FIELDS, so a
      // later clean-slate pass keeps the bound).
      if (stalePremiseFalsePositive) {
        for (const f of READMIT_CLEAN_SLATE_FIELDS) delete task[f];
        task.stalePremiseReadmitted = true;
        if (task.status === 'blocked') task.status = 'pending';
        appendHistoryEvent(task, 'requeued',
          "reject-retry-check: prior block was a stale-premise verdict from decompose-premise-check that called a cited file missing (it exists under a monorepo sub-root; resolved by path suffix since) -- re-admitted with a clean slate, exactly once");
        recordModelOutcome({ callId: task.abCallId, outcome: 'requeued', outcomeStage: 'watchdog', outcomeReason: 'stale-premise-false-positive-readmit' });
        const destDir = (task.source === 'derived_task' && derivedDir) ? derivedDir : (isAdhocTask(task) && adhocDir) ? adhocDir : pendingDir;
        fs.mkdirSync(destDir, { recursive: true });
        const newPath = path.join(destDir, name);
        writeTaskAndUnlinkOld(instancesDir, task, newPath, filePath);
        summary.requeued++;
        continue;
      }

      // 2026-09-06: candidate-premise-check.js's premise gate can reject a task whose
      // premise the check itself later invalidated -- the block text carries the gate's
      // verdict ("Invalid premise:"), not a real review signal, so a blind retry would
      // only reproduce the same gate. Mirrors the forbidden-path re-admission above:
      // clean slate exactly once (the predicate fires only while premiseReadmitCount is
      // falsy; READMIT_CLEAN_SLATE_FIELDS strips it, so a task that somehow still fails
      // this way after the fix is not re-admitted forever). Runs BEFORE classifyBlockedTask
      // so the non-retryable verdict (-> needs-clarification + ghost debt) cannot intercept it.
      if (invalidPremiseBeforeCheckExisted(task)) {
        for (const f of READMIT_CLEAN_SLATE_FIELDS) delete task[f];
        task.premiseReadmitCount = 1;
        if (task.status === 'blocked') task.status = 'pending';
        appendHistoryEvent(task, 'requeued',
          "reject-retry-check: prior block was an 'Invalid premise:' verdict from candidate-premise-check (the check itself later invalidated the premise) -- re-admitted with a clean slate, retry budget reset");
        recordModelOutcome({ callId: task.abCallId, outcome: 'requeued', outcomeStage: 'watchdog', outcomeReason: 'invalid-premise-readmit' });
        const destDir = (task.source === 'derived_task' && derivedDir) ? derivedDir : (isAdhocTask(task) && adhocDir) ? adhocDir : pendingDir;
        fs.mkdirSync(destDir, { recursive: true });
        const newPath = path.join(destDir, name);
        writeTaskAndUnlinkOld(instancesDir, task, newPath, filePath);
        summary.requeued++;
        continue;
      }

      // A structurally-oversized draft-call failure: the mechanism that stamped it
      // (local-worker.sh) already knows a blind retry would just reproduce the identical
      // turn-exhaustion timeout, so this always needs a human decompose/scope decision.
      // Checked before classifyBlockedTask so its generic non-retryable escalation
      // (built for a different set of categories, and keyed on blockedReason text this
      // shape wouldn't reliably match anyway) cannot pre-empt this specific, better-
      // targeted one -- same discipline as the invalidPremiseBeforeCheckExisted check above.
      if (isStructurallyOversizedDraftFailure(task) && needsClarificationDir) {
        const alreadyEscalated = alreadyEscalatedSinceLastReadmission(task);
        if (!alreadyEscalated) {
          task.needsClarification = {
            reason: 'design-decision',
            openQuestions: `A draft attempt ran out of turns twice in a row on the very first pass -- the task is likely too large for one pass:\n\n${String(task.blockedReason || '')}\n\nDecide whether to split this into smaller sub-tasks (and how), or narrow the scope.`,
          };
          appendHistoryEvent(task, 'needs-clarification', 'escalated immediately -- structurally-oversized draft-call failure, a blind retry cannot differ');
          if (ghostRoot) fileGhostDebt({ task, reasonText: task.blockedReason, site: 'reject-retry-check:structurally-oversized-draft-failure', pipelineDir: ghostRoot });
          fs.mkdirSync(needsClarificationDir, { recursive: true });
          writeTaskAndUnlinkOld(instancesDir, task, path.join(needsClarificationDir, name), filePath);
          summary.exhausted++;
          continue;
        }
      }

      // Unified fault-side escalation (src/blocked-task-classifiers.js), replacing what
      // were two separate bespoke checks (AC-13b's external-dependency skip, AC-8's
      // unreliable-grounding gate). Runs BEFORE the retry-cap check below and regardless
      // of retryCount -- a non-retryable classification means retrying would reproduce
      // the exact same failure, structurally, not stochastically, so there is no reason
      // to wait for the cap.
      const classification = classifyBlockedTask(task);
      if (!classification.retryable) {
        if (needsClarificationDir) {
          const alreadyEscalated = alreadyEscalatedSinceLastReadmission(task);
          if (!alreadyEscalated) {
            const classifier = findClassifier(classification.classifierName);
            const openQuestions = classifier && typeof classifier.buildQuestion === 'function'
              ? classifier.buildQuestion(task)
              : `Classified as ${classification.category} (${classification.faultSide}-side), which a blind retry cannot fix -- needs a human decision.`;
            task.needsClarification = { reason: classification.category, openQuestions };
            appendHistoryEvent(task, 'needs-clarification', `escalated immediately -- ${classification.category} (${classification.faultSide}-side), a blind retry cannot differ`);
            // No automated recovery exists for this class -- a blind retry is structurally
            // futile and no re-admission signature matched. Record the debt.
            if (ghostRoot) fileGhostDebt({ task, reasonText: task.blockedReason || openQuestions, site: 'reject-retry-check:non-retryable-classification', pipelineDir: ghostRoot });
            fs.mkdirSync(needsClarificationDir, { recursive: true });
            writeTaskAndUnlinkOld(instancesDir, task, path.join(needsClarificationDir, name), filePath);
            summary.exhausted++;
            continue;
          }
        }
      }

      const retryCount = Number(task.localRejectCount) || 0;
      // Deterministic-block short-circuit: this block fingerprints the EXACT same
      // deterministic input as the previous sweep (same file bytes, same rule, marker
      // still in the text) -- a redraft cannot change the outcome, so don't requeue
      // again: stamp exhausted + escalated and leave the task where it is.
      const blockSig = computeBlockSignature(task);
      if (blockSig !== null && blockSig === task._prevBlockSignature) {
        task.localRejectCount = MAX_LOCAL_REJECT_RETRIES;
        task.escalated = true;
        appendHistoryEvent(task, 'exhausted', 'deterministic block signature unchanged since previous sweep (_prevBlockSignature match) -- short-circuit: no requeue, escalated for human');
        try { fs.writeFileSync(filePath, JSON.stringify(task, null, 2)); } catch { /* non-fatal: state stays in memory for this tick's summary */ }
        summary.exhausted++;
        continue;
      }
      if (blockSig !== null) task._prevBlockSignature = blockSig;
      if (retryCount >= MAX_LOCAL_REJECT_RETRIES && !isContinuation) {
        // Exhaustion policy (which sources escalate to a human vs stamp-and-stay, the
        // idempotency guards, ghost-debt filing, file move) extracted to the standalone
        // helper defined above -- its header carries the source-by-source rationale.
        // summary.exhausted++
        // stays here, exactly once per call for every outcome, matching the old block's
        // count; 'skipped' means an idempotency guard bailed the helper out with no
        // side effects.
        handleExhaustion({ task, name, sourceDir, needsClarificationDir, deepDiveCoveragePath, brainDumpPath, ghostRoot, retryCount });
        summary.exhausted++;
        continue;
      }

      const priorFeedback = Array.isArray(task.priorRejectionFeedback) ? task.priorRejectionFeedback : [];
      // The 12-branch feedback-construction chain (isContinuation, rescoped, turn-budget,
      // diff-substance, no-changes-claim, infra-error, malformed-JSON, pre-critique,
      // pre-implement, draft-failure, plan-degenerate, default) and its interleaved
      // field deletions were extracted to the standalone PURE helper buildFeedbackString
      // (defined above) -- same 12-branch policy, now unit-testable without asserting
      // side effects. The string it returns is pushed below; every mutation that used to
      // be interleaved inside the chain lives in the single cleanup block right after it.
      const feedbackBranch = selectFeedbackBranch({ task, isContinuation, retryableDraftBlock, preCritiqueBlock, preImplementBlock, draftFailureBlock, planDegenerateBlock });
      priorFeedback.push(buildFeedbackString({ task, branch: feedbackBranch }));
      // Cleanup (was interleaved inside the per-branch feedback construction). It follows the SAME single branch decision as the text above, so -- as in the
      // original `if / else if` chain -- only the branch that actually supplied the feedback clears its own fields; nothing else is touched.
      switch (feedbackBranch) {
        case 'continuation':
          delete task.agenticContinuationNote;
          // task.priorPartialDiff is KEPT: the next pass applies it to its fresh worktree (agentic-draft-common.js applyPartialDiff) and clears it
          // once that pass's captured diff (which then includes it) is accepted.
          // keep task.isAgenticContinuation + task.agenticContinuationCount for the cap in
          // agentic-draft-common.js's resolveAgenticDraft on the next pass.
          break;
        case 'rescoped':
          // resolveAgenticDraft decided this task's real scope is exactly one sub-task the model proposed. Make that the task now, and tell the next
          // pass to implement it (not decompose again).
          task.promptContext = task.promptContext || {};
          task.promptContext.rawText = task.rescopedRawText;
          delete task.rescopedRawText; // keep rescopedFromDecompose set for the escalation cap in resolveAgenticDraft
          break;
        case 'diff-substance':
          // resolveAgenticDraft (agentic-draft-common.js) found the produced diff was a token gesture -- an ADR/doc instead of the code, an unrequested
          // delete, or a file the task explicitly forbids. The feedback names the real target(s).
          delete task.adhocDiffSubstanceFeedback;
          break;
        case 'no-changes-claim':
          // Sibling of the above, for a `no-changes-needed` resolution: no "Already covered:" citation block, or a named object cited nowhere and
          // grep-findable nowhere. The feedback names the exact gap. See adhoc-diff-sanity.js.
          delete task.adhocNoChangesClaimFeedback;
          // GUARD (coordination-field survival): do NOT add a blanket `delete task.<coordinationField>` in this requeue branch. Coordination flags
          // (stacked / dependsOn / atomic / noDecompose / decomposeDirective ...) must survive so buildWriteAgenticPrompt
          // (src/local-agentic-write-draft.js) stays intact. Only the fields explicitly listed in READMIT_CLEAN_SLATE_FIELDS (line 42 above) are
          // safe to clear in this branch; decomposeDirective is deliberately not among them.
          break;
        case 'infra-error':
          // resolveAgenticDraft (agentic-draft-common.js): the model tagged BLOCKER-TYPE: infra-error -- a tool/command/file-op that should have
          // worked failed, unrelated to any design decision. A transient fault usually clears on a fresh pass.
          delete task.infraErrorNote;
          break;
        default:
          break;
      }
      delete task.turnBudgetExhausted;
      delete task.infraErrorRetry;
      delete task.retryableDraftBlock;
      // Clear the terminal block state -- otherwise a task requeued into queue/adhoc/ still
      // reads status:'blocked' and this sweep's adhoc/ scan re-requeues it every tick until
      // the cap. blockedStage/blockedReason are left for priorRejectionFeedback's history.
      if (task.status === 'blocked') task.status = 'pending';
      task.priorRejectionFeedback = priorFeedback;
      // A continuation is forward progress, not a spent redraft -- don't burn a slot of the
      // blind-redraft budget on it (its own MAX_AGENTIC_CONTINUATIONS cap bounds it).
      if (!isContinuation) {
        // Second short-circuit site (mirrors the retryCount-branch guard above, for any
        // path that reaches the increment without tripping the cap check first): a
        // repeat of the identical deterministic block is not a spent redraft slot.
        const incSig = computeBlockSignature(task);
        if (incSig !== null && incSig === task._prevBlockSignature) {
          task.localRejectCount = MAX_LOCAL_REJECT_RETRIES;
          task.escalated = true;
          appendHistoryEvent(task, 'exhausted', 'deterministic block signature unchanged since previous sweep (_prevBlockSignature match) -- short-circuit: no increment, escalated for human');
          try { fs.writeFileSync(filePath, JSON.stringify(task, null, 2)); } catch { /* non-fatal */ }
          summary.exhausted++;
          continue;
        }
        if (incSig !== null) task._prevBlockSignature = incSig;
        task.localRejectCount = retryCount + 1;
      }

      // AC-131 (2026-09-15): a genuine review-stage rejection requeues with its prior
      // planResponse/implementResponse still intact -- the NEXT draftTask() run can then
      // treat the task as already-planned and skip or no-op the plan pass, producing the
      // "Plan pass degenerate: empty" failure seen in AC-128. Unlike the
      // retryableDraftBlock branches above (continuation, decompose-rescope, etc., which
      // deliberately need the prior state to build on), a real review rejection means the
      // draft itself was judged wrong -- the next pass should plan and implement fresh,
      // informed by priorRejectionFeedback (kept), not carry the rejected draft forward.
      if (isReviewRejection(task)) {
        delete task.planResponse;
        delete task.implementResponse;
        // A REJECTED decompose that carried landed edits (carriedPartialDiff): the split was not wanted, but the work is real. Keep it as the
        // next pass's starting point (applied to its worktree) instead of losing it -- without this the redraft began from scratch while
        // lastGoodPlan still described those edits as "already on disk" (PropertyForager wiring piece, 2026-09-20).
        if (typeof task.carriedPartialDiff === 'string' && task.carriedPartialDiff.trim()) {
          task.priorPartialDiff = task.carriedPartialDiff;
          delete task.carriedPartialDiff;
          priorFeedback.push('The edits an earlier pass already made are kept: they are ALREADY APPLIED to your worktree as uncommitted changes (run git diff to see them). Do not redo them, and implement the rest instead of splitting it up.');
        }
        // 2026-09-18, ghost-in-the-machine retroactive audit (pipeline_forensics blocked/
        // bucket): blockedStage/blockedReason used to survive this requeue untouched --
        // deliberately, per this branch's own prior comment ("left for priorRejectionFeedback's
        // history"). But local-draft.js's draftTask() reads task.blockedStage as a LIVE gate
        // right after critique (`if (task.blockedStage) return blocked:true, blockedReason:
        // task.blockedReason`), meant to catch a grounding-gate rejection critique JUST found
        // THIS attempt. Left stale, that gate fires on the very NEXT automatic attempt
        // regardless of what the fresh redraft actually produced, reusing the FIRST
        // rejection's wording verbatim. Confirmed live: pipeline-forensics-3-needs-
        // clarification-tasks-same-signature-manual-retryable-draft-block-1789395453456's
        // attempts 3 and 4 produced genuinely different, well-structured 4600/5702-char
        // reports, but both were blocked with the byte-identical reason describing attempt
        // 1's 339-char draft -- confirmed by comparing task.draftAttempts[2].implement.text
        // (the real, distinct content) against task.draftAttempts[2].blockedReason (attempt
        // 1's stale text) directly. Every domain:'default' source sharing this drafting path
        // (pipeline_forensics, pipeline_debrief, change_review, ...) only ever got its FIRST
        // automatic attempt really evaluated; every attempt after that up to the retry cap
        // was a phantom re-block. adhoc-source tasks were never affected by the OLD bug --
        // not because anything cleared this state for them, but because local-draft.js's
        // draftTask() returns via the completely separate draftAdhocBranch()/local-agentic-
        // write path for `resolveSourceName(task) === 'adhoc'`, BEFORE ever reaching
        // runCritiqueAndRevision or this check at all (confirmed: local-draft.js:1342's early
        // return). needs-clarification-triage.js already clears blockedStage/blockedReason
        // the identical way when it re-admits a task, for the identical reason. blockedReason
        // was already captured into priorRejectionFeedback above before this point, so
        // nothing is lost by clearing it here.
        delete task.blockedStage;
        delete task.blockedReason;
        appendHistoryEvent(task, 'requeued', 'review rejection -- cleared stale plan/implement state for fresh redraft');
      } else if (preCritiqueBlock) {
        // The bad citation lives IN implementResponse -- carrying it forward would just
        // hand the next pass its own broken output as "prior work" to build on. planResponse
        // is kept: the plan itself wasn't what named the nonexistent file.
        delete task.implementResponse;
        appendHistoryEvent(task, 'requeued', 'pre-critique missing-file block -- cleared stale implementResponse for fresh redraft');
      } else if (preImplementBlock) {
        // The bad citation lives IN the plan itself -- implementResponse never ran yet at
        // this stage (that's the whole point of catching it earlier), but clear it too in
        // case a prior cycle's stale value is still sitting on the record.
        delete task.planResponse;
        delete task.implementResponse;
        appendHistoryEvent(task, 'requeued', 'pre-implementation missing-file block -- cleared stale plan/implement state for a fresh plan pass');
      } else if (draftFailureBlock && !retryableDraftBlock) {
        // retryableDraftBlock excluded: an adhoc draft-stage block ALSO happens to use the
        // literal blockedStage value 'draft' in places (unrelated to this bash-side stamp,
        // just a coincidentally-shared label) -- that shape's own priorFeedback branch above
        // already ran and deliberately keeps plan/implement state (e.g. a continuation's
        // priorPartialDiff to build on), so it must not be clobbered here too.
        //
        // The draft CALL itself failed -- unlike a review/pre-critique rejection (a real
        // response the model produced, just a bad one), there is no reliable partial state
        // worth keeping here.
        delete task.planResponse;
        delete task.implementResponse;
        appendHistoryEvent(task, 'requeued', 'draft-call failure -- cleared stale plan/implement state for fresh redraft');
      } else if (planDegenerateBlock) {
        // The plan itself is what was degenerate -- nothing usable to carry forward.
        // implementResponse never even ran yet at this stage, but clear it too in case a
        // PRIOR cycle's stale value is still sitting on the record.
        delete task.planResponse;
        delete task.implementResponse;
        appendHistoryEvent(task, 'requeued', 'plan-pass degenerate -- cleared stale plan state for a fresh plan pass');
      } else if (implementDegenerateBlock) {
        // The plan completed and is kept; only the unusable (empty / truncated) implement output is dropped.
        delete task.implementResponse;
        appendHistoryEvent(task, 'requeued', 'implement-pass degenerate -- cleared stale implement state for a fresh implement pass');
      } else if (critiqueDegenerateBlock) {
        // Nothing to clear: the draft was fine, only its critique call failed, and the next attempt regenerates plan / implement / critique from the top anyway.
        appendHistoryEvent(task, 'requeued', 'critique-pass degenerate -- the draft was never critiqued; redrafting from the top');
      }

      recordModelOutcome({ callId: task.abCallId, outcome: 'requeued', outcomeStage: 'watchdog', outcomeReason: task.blockedReason || null });
      appendHistoryEvent(task, 'requeued', task.blockedReason || undefined);

      // nextAdhocTask() only scans queue/adhoc/ -- an adhoc task requeued to pending/ is
      // only picked up by a general worker, never re-drafted through draftAdhocBranch's
      // tiers. Match python/dashboard/app.py's own adhoc-requeue destination.
      const destDir = (task.source === 'derived_task' && derivedDir) ? derivedDir : (isAdhocTask(task) && adhocDir) ? adhocDir : pendingDir;
      const newPath = path.join(destDir, name);
      fs.mkdirSync(destDir, { recursive: true });
      // A task picked up from queue/adhoc/ requeues back to queue/adhoc/ -- same path.
      // writeTaskAndUnlinkOld only unlinks when the source and destination genuinely
      // differ, or we'd delete the file we just wrote.
      writeTaskAndUnlinkOld(instancesDir, task, newPath, filePath);
      summary.requeued++;
    } catch (e) {
      console.warn('[reject-retry-check] requeue failed for', filePath, e.message, e.code);
      summary.errors++;
    }
  }

  return summary;
}

function main() {
  const { pipelineDir, deepDiveCoveragePath, brainDumpPath } = getConfig();
  const queueDir = path.join(pipelineDir, 'queue');
  const blockedDir = path.join(queueDir, 'blocked');
  const pendingDir = path.join(queueDir, 'pending');
  const adhocDir = path.join(queueDir, 'adhoc');
  const derivedDir = path.join(queueDir, 'derived');
  const needsClarificationDir = path.join(queueDir, 'needs-clarification');

  const summary = rejectRetryCheck({ blockedDir, pendingDir, adhocDir, derivedDir, needsClarificationDir, deepDiveCoveragePath, brainDumpPath, pipelineDir });
  process.stdout.write(JSON.stringify(summary));
}

module.exports = { selectFeedbackBranch, buildFeedbackString, isCritiqueDegenerateBlock, rejectRetryCheck, invalidPremiseBeforeCheckExisted, isReviewRejection, isPreCritiqueBlock, isPreImplementBlock, isDraftFailureBlock, isStructurallyOversizedDraftFailure, isPlanDegenerateBlock, isImplementDegenerateBlock, alreadyEscalatedSinceLastReadmission, computeBlockSignature, isReviewVerdictAdvisoryProseSource, buildExhaustedReviewVerdictQuestion };

if (require.main === module) {
  main();
}
