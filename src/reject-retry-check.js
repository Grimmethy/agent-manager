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
const { classifyBlockedTask, findClassifier } = require('./blocked-task-classifiers.js');
const { extractDeclaredTargets, pathsRefEqual } = require('./adhoc-diff-sanity.js');
const { fileGhostDebt } = require('./ghost-debt.js');
const { getRegisteredSource, resolveSourceName } = require('./task-source-registry.js');
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
];

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
function invalidPremiseBeforeCheckExisted(task) {
  const reason = (task.blockedReason || '') + ' ' + (task.priorRejectionFeedback || '');
  return (
    /Invalid premise:/i.test(reason) &&
    task.blockedStage === 'review' &&
    !task.premiseReadmitCount
  );
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

function rejectRetryCheck({ blockedDir, pendingDir, adhocDir, derivedDir, needsClarificationDir, deepDiveCoveragePath, brainDumpPath, pipelineDir, approvedDir, recordModelOutcome = defaultRecordModelOutcome }) {
  const summary = { checked: 0, requeued: 0, exhausted: 0, recovered: 0, errors: 0 };
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

  if (entries.length === 0) return summary;

  for (const { dir: sourceDir, name } of entries) {
    const filePath = path.join(sourceDir, name);
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      if (!raw) continue;
      const task = JSON.parse(raw);
      summary.checked++;

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
      if (!isReviewRejection(task) && !retryableDraftBlock && !preCritiqueBlock && !preImplementBlock && !draftFailureBlock && !planDegenerateBlock) continue;

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
            fs.writeFileSync(path.join(approvedDirResolved, name), JSON.stringify(task, null, 2));
            fs.unlinkSync(filePath);
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
        fs.writeFileSync(newPath, JSON.stringify(task, null, 2));
        if (path.resolve(filePath) !== path.resolve(newPath)) fs.unlinkSync(filePath);
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
        fs.writeFileSync(newPath, JSON.stringify(task, null, 2));
        if (path.resolve(filePath) !== path.resolve(newPath)) fs.unlinkSync(filePath);
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
          fs.writeFileSync(path.join(needsClarificationDir, name), JSON.stringify(task, null, 2));
          fs.unlinkSync(filePath);
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
            fs.writeFileSync(path.join(needsClarificationDir, name), JSON.stringify(task, null, 2));
            fs.unlinkSync(filePath);
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
        // An exhausted ADHOC rejection is very often a real disagreement about scope
        // ("is this already done, or a request to extend it?") that no amount of blind
        // redraft will resolve -- send it to a human instead of leaving it to rot in
        // blocked/ forever. (Non-adhoc keeps the original "stamp once, stay in blocked"
        // behaviour.)
        if (isAdhocTask(task) && needsClarificationDir) {
          const alreadyEscalated = alreadyEscalatedSinceLastReadmission(task);
          if (alreadyEscalated) { summary.exhausted++; continue; }
          // A task that exhausted its retries on a tagged tool/environment failure lands
          // with an honest reason:'infra-error' -- not design-decision -- so forensics and
          // the triage sweep see it for what it is. (nc.reason already carries non-
          // design-decision values elsewhere: external-dependency, unreliable-grounding.)
          task.needsClarification = {
            reason: task.infraErrorBefore ? 'infra-error' : 'design-decision',
            openQuestions: buildExhaustedAdhocQuestion(task),
          };
          appendHistoryEvent(task, 'exhausted', `${retryCount}/${MAX_LOCAL_REJECT_RETRIES} retries used`);
          appendHistoryEvent(task, 'needs-clarification', 'escalated to a human after exhausting redraft retries');
          // Blind redrafts were spent and nothing re-admitted this class -- ghost debt.
          if (ghostRoot) fileGhostDebt({ task, reasonText: task.blockedReason, site: 'reject-retry-check:retry-cap-exhausted', pipelineDir: ghostRoot });
          fs.mkdirSync(needsClarificationDir, { recursive: true });
          fs.writeFileSync(path.join(needsClarificationDir, name), JSON.stringify(task, null, 2));
          fs.unlinkSync(filePath);
          summary.exhausted++;
          continue;
        }
        // Already stamped on a prior tick -- an exhausted task stays in blocked/
        // permanently (nothing here ever moves or deletes it), so without this guard this
        // whole branch re-fires every single tick forever. Confirmed live 2026-08-17: one
        // real exhausted task accumulated 20+ duplicate 'exhausted' history entries (one
        // per ~30s tick) over about 12 minutes before this was caught, unbounded growth
        // for as long as the task sits there -- which, being exhausted, is indefinitely.
        const alreadyStamped = Array.isArray(task.history) && task.history.some((h) => h.stage === 'exhausted');
        if (alreadyStamped) { summary.exhausted++; continue; }
        stampDeepDiveExhausted(task, deepDiveCoveragePath);
        stampBrainDumpSortExhausted(task, brainDumpPath);
        // Persist the exhaustion itself onto the task -- previously this branch never
        // wrote the file back at all, so a task permanently stuck in queue/blocked/ after
        // hitting the retry cap carried no record that retries were ever attempted or
        // exhausted; only localRejectCount (no timestamp) hinted at it.
        appendHistoryEvent(task, 'exhausted', `${retryCount}/${MAX_LOCAL_REJECT_RETRIES} retries used`);
        fs.writeFileSync(filePath, JSON.stringify(task, null, 2));
        summary.exhausted++;
        continue;
      }

      const priorFeedback = Array.isArray(task.priorRejectionFeedback) ? task.priorRejectionFeedback : [];
      if (isContinuation) {
        priorFeedback.push([
          'This is a CONTINUATION, not a fresh start. A prior pass got partway through and ran out of turns. It reported this remaining work:',
          '',
          String(task.agenticContinuationNote || '').slice(0, 4000),
          task.priorPartialDiff
            ? `\nThe partial diff it already produced (build ON this, do not redo it):\n\n${String(task.priorPartialDiff).slice(0, 6000)}`
            : '',
          '',
          'Start editing with edit_file/write_file within your first 1-2 turns from where it left off. Finish the remaining work and end with RESOLUTION: implemented.',
        ].filter(Boolean).join('\n'));
        delete task.agenticContinuationNote;
        delete task.priorPartialDiff;
        // keep task.isAgenticContinuation + task.agenticContinuationCount for the cap in
        // agentic-draft-common.js's resolveAgenticDraft on the next pass.
      } else if (retryableDraftBlock && task.rescopedFromDecompose === true && typeof task.rescopedRawText === 'string' && task.rescopedRawText.trim()) {
        // resolveAgenticDraft decided this task's real scope is exactly one sub-task the
        // model proposed. Make that the task now, and tell the next pass to implement it
        // (not decompose again).
        task.promptContext = task.promptContext || {};
        task.promptContext.rawText = task.rescopedRawText;
        priorFeedback.push(`A prior pass decided this task's real scope is exactly: ${task.rescopedRawText}\nThat is the task now. Implement THAT with edit_file/write_file in this pass. Do not decompose again.`);
        delete task.rescopedRawText; // keep rescopedFromDecompose set for the escalation cap in resolveAgenticDraft
      } else if (retryableDraftBlock && task.turnBudgetExhausted === true) {
        priorFeedback.push('A prior attempt spent its whole turn budget exploring and made ZERO edits. Do not re-explore from scratch: the PLAN and PRIOR INVESTIGATION are already in your prompt -- use them, get to a concrete edit_file within the first few turns, and answer RESOLUTION: decompose if the task is genuinely too large to finish in one pass.');
      } else if (retryableDraftBlock && typeof task.adhocDiffSubstanceFeedback === 'string' && task.adhocDiffSubstanceFeedback.trim()) {
        // resolveAgenticDraft (agentic-draft-common.js) found the produced diff was a token
        // gesture -- an ADR/doc instead of the code, an unrequested delete, or a file the
        // task explicitly forbids. The feedback names the real target(s).
        priorFeedback.push(task.adhocDiffSubstanceFeedback);
        delete task.adhocDiffSubstanceFeedback;
      } else if (retryableDraftBlock && typeof task.adhocNoChangesClaimFeedback === 'string' && task.adhocNoChangesClaimFeedback.trim()) {
        // Sibling of the above, for a `no-changes-needed` resolution: no "Already covered:"
        // citation block, or a named object cited nowhere and grep-findable nowhere. The
        // feedback names the exact gap. See adhoc-diff-sanity.js.
        priorFeedback.push(task.adhocNoChangesClaimFeedback);
        delete task.adhocNoChangesClaimFeedback;
        // GUARD (coordination-field survival): do NOT add a blanket
        // `delete task.<coordinationField>` in this requeue branch. Coordination flags
        // -- e.g. task.decomposeDirective, set by the decompose/rescope path in
        // agentic-draft-common.js (resolveAgenticDraft) -- must survive here and reach
        // buildWriteAgenticPrompt (src/local-agentic-write-draft.js) intact. Only the
        // fields explicitly listed in READMIT_CLEAN_SLATE_FIELDS (line 42 above) are
        // safe to clear in this branch; decomposeDirective is deliberately not among them.
      } else if (retryableDraftBlock && typeof task.infraErrorNote === 'string' && task.infraErrorNote.trim()) {
        // resolveAgenticDraft (agentic-draft-common.js): the model tagged BLOCKER-TYPE:
        // infra-error -- a tool/command/file-op that should have worked failed, unrelated
        // to any design decision. A transient fault usually clears on a fresh pass; tell
        // it what broke and how to escalate if it genuinely reproduces.
        priorFeedback.push([
          'A prior attempt hit a tool/environment failure (not a design question):',
          '',
          String(task.infraErrorNote).slice(0, 3000),
          '',
          'Retry the operation from a clean pass. If a command genuinely fails identically again, end with RESOLUTION: needs-human-decision and BLOCKER-TYPE: infra-error, quoting the exact command and its full error output.',
        ].join('\n'));
        delete task.infraErrorNote;
      } else if (retryableDraftBlock) {
        priorFeedback.push('A prior attempt chose RESOLUTION: decompose but the sub-task JSON was malformed. If this task is doable in one pass, just implement it. If it genuinely needs splitting, end with EXACTLY "RESOLUTION: decompose" then, on the next lines, a single valid JSON array of 2+ objects each shaped {"title": "...", "rawText": "..."} and nothing else.');
      } else if (preCritiqueBlock) {
        priorFeedback.push([
          'A prior implementation was blocked before review because it cited a file that does not actually exist in the repo:',
          '',
          String(task.blockedReason || ''),
          '',
          'Only reference files that are actually present in the repo (verify with a tool call before citing one). If this task genuinely requires a brand-new file, create it with write_file/edit_file in create mode -- do not just describe or reference it as if it already exists.',
        ].join('\n'));
      } else if (preImplementBlock) {
        priorFeedback.push([
          'A prior plan was blocked before implementation because it named an edit target that does not actually exist in the repo:',
          '',
          String(task.blockedReason || ''),
          '',
          'Only declare edit targets that are actually present in the repo (verify with a tool call before naming one). If this task genuinely requires a brand-new file, say so explicitly (e.g. "create `path`") so it is recognized as a create target, not a citation of an existing file.',
        ].join('\n'));
      } else if (draftFailureBlock) {
        // Reaching here means NOT structurally-oversized (that shape escalated straight to
        // needs-clarification above, before this point) -- an ordinary content/model-
        // variance draft-CALL failure, which plausibly differs on a fresh attempt.
        priorFeedback.push([
          'A prior draft attempt failed outright (not a content rejection or a design question) after repeated tries:',
          '',
          String(task.blockedReason || ''),
          '',
          'Try again from a clean pass.',
        ].join('\n'));
      } else if (planDegenerateBlock) {
        priorFeedback.push([
          'A prior plan pass produced a degenerate (truncated or empty) plan even after an internal higher-temperature reroll:',
          '',
          String(task.blockedReason || ''),
          '',
          'Try a fresh plan pass. Keep the plan concrete and complete -- do not truncate mid-thought.',
        ].join('\n'));
      } else {
        priorFeedback.push(String(task.blockedReason || ''));
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
      }

      recordModelOutcome({ callId: task.abCallId, outcome: 'requeued', outcomeStage: 'watchdog', outcomeReason: task.blockedReason || null });
      appendHistoryEvent(task, 'requeued', task.blockedReason || undefined);

      // nextAdhocTask() only scans queue/adhoc/ -- an adhoc task requeued to pending/ is
      // only picked up by a general worker, never re-drafted through draftAdhocBranch's
      // tiers. Match python/dashboard/app.py's own adhoc-requeue destination.
      const destDir = (task.source === 'derived_task' && derivedDir) ? derivedDir : (isAdhocTask(task) && adhocDir) ? adhocDir : pendingDir;
      const newPath = path.join(destDir, name);
      fs.mkdirSync(destDir, { recursive: true });
      fs.writeFileSync(newPath, JSON.stringify(task, null, 2));
      // A task picked up from queue/adhoc/ requeues back to queue/adhoc/ -- same path.
      // Only unlink when the source and destination genuinely differ, or we'd delete the
      // file we just wrote.
      if (path.resolve(filePath) !== path.resolve(newPath)) fs.unlinkSync(filePath);
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

module.exports = { rejectRetryCheck, invalidPremiseBeforeCheckExisted, isReviewRejection, isPreCritiqueBlock, isPreImplementBlock, isDraftFailureBlock, isStructurallyOversizedDraftFailure, isPlanDegenerateBlock, alreadyEscalatedSinceLastReadmission, computeBlockSignature };

if (require.main === module) {
  main();
}
