'use strict';

// draft-context.js -- extracted from src/local-draft.js ([[hub-task-integration]] node-module decompose).

const path = require('path');
const { sharedInstancesDir } = require('../instances-dir.js');
const { buildPlanGrounding } = require('../plan-grounding.js');
const { appendHistoryEvent, setHistoryPersistHook } = require('../task-history.js');
const {
  beginDraftAttempt, recordPlan, recordImplement, recordCritique, recordOrient, recordPlanCritique, recordTier, finalizeDraftAttempt,
} = require('../draft-attempt-record.js');
const { appendTierWorkLog, pruneWorkLogs } = require('../work-log.js');
const { providerFor, labelFor, resolveModelProfile } = require('../model-provider.js');
const { getConfig, ensureRegistered } = require('../config.js');
const { withLock: defaultWithLock } = require('../single-flight-lock.js');
const gpuArbiter = require('../gpu-arbiter.js');
const { parseClarificationOptions, formatSubTaskProposalsForReview } = require('../agentic-draft-common.js');
const { runDecomposePassIfAvailable } = require('../decompose-pass-route.js');
const { checkDraft } = require('../fact-checker.js');
const { resolveSourceName, getRegisteredSource } = require('../task-source-registry.js');
const { isClaudePaused } = require('../claude-pause.js');
const { writeHeartbeatFile } = require('../heartbeat.js');
const { localOllamaLockKey, writeTaskJson, researchClaudeStatus, isResearchDomainTask, draftDoneDetail, concludeDraft } = require('./draft-lifecycle.js');

function resolveDraftContext(task, { localCall, withLockFn }) {
  // Resolved here rather than as a static default param: the right backend depends on the
  // task's reasoning tier (model-provider.js's reasoningTierFor()), which isn't known
  // until the task object itself is in hand -- passing the whole task (not just
  // task.source) lets a per-instance task.reasoningTier override take effect, e.g. Brain
  // Dump #77's automatic high-reasoning retry for a needs-clarification task. Explicit
  // test/caller overrides (localCall passed in) always win -- this only fills the gap
  // production code leaves (local-draft.js's own main() calls draftTask(task) with no
  // second argument at all).
  // 2026-08-24 (model-profile-registry.js): when the task's own source declares a
  // modelProfile, its model/numCtx/numPredict become defaults for every real call below --
  // spread BEFORE each call site's own opts so a pass's own tuned numPredict (plan=1400,
  // critique=900, ...) still wins over the profile's generic default, while model/numCtx
  // (never set by any call site's own opts today) reliably take effect. Skipped entirely
  // for an injected localCall (test/caller override) -- that already wins outright, same
  // as it always has; wrapping it here would silently change what a test believes it's
  // calling.
  const modelProfile = resolveModelProfile(task);
  const profileOverrides = modelProfile
    ? { model: modelProfile.model, numCtx: modelProfile.numCtx, numPredict: modelProfile.numPredict }
    : null;
  const baseLocalCall = localCall || providerFor(task).call;
  const profileWrappedCall = profileOverrides && !localCall
    ? (opts) => baseLocalCall({ ...profileOverrides, ...opts })
    : baseLocalCall;
  // Side-finding capture (2026-09-05, side-finding.js) defaults to on for every call --
  // opt a source out via `strictOutputOnly: true` on its registerTaskSource() entry when
  // its implement pass MUST come back clean/parseable-only (brain_dump_sort's classify
  // JSON, a digest-verdict pass, decompose's JSON array, path-prefetch-resolve) and
  // couldn't tolerate an interleaved SIDE-FINDING: block. Read off the registry (not a
  // hardcoded source-name list) same as candidateFulfillment/emptyApproval/etc. already
  // are -- see isCandidateFulfillmentSource's own comment for why a hardcoded array was
  // rejected here before.
  const sourceEntry = getRegisteredSource(resolveSourceName(task));
  const allowSideFindings = !(sourceEntry && sourceEntry.strictOutputOnly);
  const resolvedLocalCall = allowSideFindings
    ? profileWrappedCall
    : (opts) => profileWrappedCall({ ...opts, allowSideFindings: false });
  // 2026-08-24 (root-caused live: every brain_dump_sort draft failed outright with
  // "does not support thinking" for as long as the brain-dump-cheap-local profile
  // existed) -- unlike model/numCtx/numPredict above, `think` can't just join
  // profileOverrides: every call site below passes its OWN explicit think value as part
  // of `opts` (plan/critique/revise: true; implement: !hasFixedLiterals), and opts is
  // spread AFTER profileOverrides in resolvedLocalCall above, so a profile-level think
  // override would never actually take effect no matter what value it held. Each call
  // site below now ANDs its own reasoning-needed value with this, instead.
  const profileSupportsThink = !modelProfile || modelProfile.think !== false;

  // Real plan/implement lock split (2026-08-22, Grimmethy: "build it now" -- see
  // single-flight-lock.js's own header for the full incident this fixes). Every real
  // resolvedLocalCall() invocation below -- plan, the non-A/B implement branch, critique,
  // revision -- shares the SAME resolved backend for one draftTask() call (it's computed
  // once, above), so this is computed once too rather than re-checked at each call site.
  // Deliberately based on labelFor(task) ALONE, not on whether localCall was injected --
  // an earlier version of this gated on `!localCall` too (skip locking whenever a test
  // supplies a mock call), but that conflated "is this call actually local" with "are we
  // in a test," which meant a test asserting real locking behavior for a normal task
  // would have to leave localCall unset and make a real Ollama/Claude call to exercise
  // it. A real flock acquire/release is single-digit milliseconds (confirmed live) --
  // cheap enough that tests just inject withLockFn as a lightweight in-memory spy instead
  // (see local-draft.test.js), and production behavior stays exactly what labelFor(task)
  // says regardless of how a test wires the rest of this function. For adhoc, the IMPLEMENT
  // path is a single write-agentic pass (draftAdhocBranch) which manages its own lock; for
  // research (when opted into Claude), the implement call is a Claude call that never
  // touches the local GPU. For every other task, plan and implement resolve to the SAME
  // backend, so locking around each call individually (rather than one lock spanning the
  // whole function) costs a few extra flock round-trips in exchange for never holding the
  // lock across an off-GPU call by construction.
  // labelFor(task) can genuinely return undefined now (LOCAL_MODEL has no hardcoded
  // fallback string as of the earlier fix today -- see local-client.js's own comment) --
  // treat that the same safe-default way as everywhere else in this codebase treats an
  // unresolved label ("assume local, lock" rather than risk skipping a real local call's
  // protection): `(label || '')` so `.startsWith` never throws on undefined, and an empty
  // string correctly fails the 'claude:' prefix check.
  const resolvedLabel = labelFor(task) || '';
  const resolvedCallIsLocal = !resolvedLabel.startsWith('claude:');
  const instancesDir = sharedInstancesDir(getConfig().pipelineDir);
  // Locked per-model, not globally (2026-08-25 -- see single-flight-lock.js's own header
  // for the full "worker-1 and reasoning taking turns" incident this fixes): resolvedLabel
  // IS the resolved local model name whenever resolvedCallIsLocal is true (labelFor()
  // returns the bare model string for local, "claude:<model>" otherwise), so it's reused
  // directly as the lock key -- no separate resolution needed.
  // Restores the 2026-08-19 "queued" (waiting on the lock) vs "working" (actually
  // computing) heartbeat distinction that the 2026-08-22 plan/implement lock split
  // (see the header comment on local-worker.sh's own draft_display_model block) made
  // bash unable to report any more -- the real wait now happens right here, inside this
  // node process, so this is the one place that can still see it. `pass` labels which
  // sub-call is queued/working (plan/implement/critique/revise/...), same convention
  // local-worker.sh's own write_heartbeat_file calls already use for currentPass.
  // AGENT_MANAGER_INSTANCE_ID is exported by local-worker.sh specifically so a node
  // child can identify itself this way (see review-runner.sh's own identical export and
  // comment) -- best-effort no-op when absent (e.g. a direct CLI/test invocation with no
  // real daemon wrapper) rather than a hard requirement.
  const instanceId = process.env.AGENT_MANAGER_INSTANCE_ID;
  // Route the real GPU wait through the arbiter (priority class 'draft' -- below an
  // interactive chat/Discuss turn and below a reviewer vote), unless a test injected its
  // own withLockFn spy. gpu-arbiter.js wraps single-flight-lock.js's flock and adds the
  // cross-lane priority ordering + cancellation this used to lack.
  const usingInjectedLock = withLockFn !== defaultWithLock;
  // lockKey (2026-09-08, Grimmethy: "fix worker-1" -- see gpu-arbiter.js's own header for
  // the incident): the per-model default lets two DIFFERENT models generate concurrently
  // on the SAME physical GPU, which starved worker-1's light qwen2.5:3b into dozens of
  // hard OLLAMA_TIMEOUTs while worker-reasoning's heavy qwen3.8:27b-q4_K_M ran alongside
  // it. localOllamaLockKey() resolves to the actual Ollama ENDPOINT this call is going
  // to (this process's own OLLAMA_URL), so both draft-class calls below now serialize
  // against any other local model hitting that SAME endpoint, while a call to a genuinely
  // different endpoint (e.g. the P40 VM's AGENT_MANAGER_P40_OLLAMA_URL, which sets its own
  // OLLAMA_URL for that lane) still runs fully independently, exactly as before.
  const maybeLocked = (isLocal, fn, pass) => {
    if (!isLocal) return fn();
    if (instanceId) writeHeartbeatFile(instancesDir, instanceId, 'queued', resolvedLabel, task.id, pass);
    const run = () => {
      if (instanceId) writeHeartbeatFile(instancesDir, instanceId, 'working', resolvedLabel, task.id, pass);
      return fn();
    };
    if (usingInjectedLock) return withLockFn(instancesDir, run, resolvedLabel);
    return gpuArbiter.withGpu(instancesDir, { cls: 'draft', model: resolvedLabel, lockKey: localOllamaLockKey(), taskId: task.id, phase: pass }, run);
  };

  // Same as maybeLocked but keyed on an EXPLICIT model tag for heartbeat/display purposes
  // -- the real serialization key is still localOllamaLockKey() (the shared endpoint), not
  // this model tag, so a sub-call on a different model (e.g. the plan-critique's
  // qwen2.5:3b) no longer runs in parallel with a main-model draft on the SAME physical
  // GPU (that was the exact class of concurrency this fix closes); it still runs in
  // parallel with a draft on a genuinely SEPARATE endpoint.
  const maybeLockedOn = (model, fn, pass) => {
    const key = model || resolvedLabel;
    if (instanceId) writeHeartbeatFile(instancesDir, instanceId, 'queued', key, task.id, pass);
    const run = () => {
      if (instanceId) writeHeartbeatFile(instancesDir, instanceId, 'working', key, task.id, pass);
      return fn();
    };
    if (usingInjectedLock) return withLockFn(instancesDir, run, key);
    return gpuArbiter.withGpu(instancesDir, { cls: 'draft', model: key, lockKey: localOllamaLockKey(), taskId: task.id, phase: pass }, run);
  };

  return { resolvedLocalCall, profileSupportsThink, resolvedCallIsLocal, maybeLocked, maybeLockedOn };
}

function runStalenessFastpath(task, attempt) {
  const { deterministicRecheck } = require('../staleness-fastpath.js');
  const verdict = deterministicRecheck(task, getConfig().repoRoot);
  if (!verdict) return null;
  task.planResponse = 'Deterministic recheck: the original finding came from a scanner rule this pipeline can re-run directly against the file\'s current content -- no search terms or model judgment needed.';
  recordPlan(attempt, { text: task.planResponse, attempts: 0 });
  appendHistoryEvent(task, 'plan-done', 'deterministic recheck, no model call');
  task.promptContext.harnessHits = verdict.hits;
  task.promptContext.harnessFiles = [];
  appendHistoryEvent(task, 'harness-search', `deterministic re-scan, ${verdict.hits.length} hit(s)`);
  task.implementResponse = verdict.reportText;
  recordImplement(attempt, { text: task.implementResponse, note: `deterministic recheck: ${verdict.recommendation}` });
  appendHistoryEvent(task, 'implement-done', `deterministic recheck: ${verdict.recommendation}`);
  task.critiqueOutcome = 'no-issues';
  recordCritique(attempt, { outcome: 'no-issues' });
  appendHistoryEvent(task, 'critique-done', 'no-issues (deterministic report, nothing for a critique pass to add)');
  concludeDraft(task);
  return { succeeded: true, blocked: false };
}

async function draftAdhocBranch(task, {
  maybeLocked, recordModelCall, attempt, resolvedLocalCall, resolvedCallIsLocal,
  draftAdhocViaLocalAgenticWriteFn,
}) {
  // Single LOCAL pass: local-agentic-write, multi-turn with real edit/write/run_bash in
  // an isolated worktree (this is what the deleted Claude adhoc-agentic-draft.js used to
  // do). Returns a terminal draftTask-shaped verdict (implemented / blocked /
  // needs-clarification) -- if it can't do the task it BLOCKS for a human. No Claude
  // fallback. Unconditionally lock-wrapped (always local).
  //
  // 2026-09-06, Grimmethy: this used to be a 3-tier escalation (cheap harness-search ->
  // read-only local-agentic -> this write-capable pass), added 2026-09-01 on the theory
  // that trying cheap tiers first would save time and that a read-only tier ahead of
  // write access was a meaningful safety gate. Real production history disproved both:
  // across 81 real adhoc tasks with a determinable winner, tier1 won 6% of the time and
  // tier2 won 5% -- the write tier won 89% regardless. Measured tier durations (tier1
  // avg 138.6s, tier2 avg 198.3s, tier3 avg 247.2s) meant the ~94% of tasks that declined
  // tier 1 paid its full cost for nothing, and expected-value math across the sample
  // showed starting every task at this tier directly saves ~55% of total drafting time
  // vs. the 3-tier cascade. A safety audit before removing tier 2's read-only gate found
  // zero real incidents of this tier's write access producing a bad edit that a cheaper
  // read-only pass would have caught (28 live tier-3 tasks' history checked for revert/
  // bad-edit signals -- zero hits, every decline was the model correctly refusing rather
  // than writing something wrong; only 2 revert commits exist in this repo's entire git
  // history and neither involves the adhoc ladder at all).
  //
  // Bracketed with an 'implement-started' checkpoint: this is a multi-turn agentic pass
  // that routinely runs for many minutes, so without it a task killed mid-draft shows
  // only '... -> plan-done' and the Pipeline History looks cut short. With main()'s
  // persist hook this lands on disk the moment it fires, so the log shows exactly how
  // far the draft got. (2026-08-31, Grimmethy: "the task log gets cut short" -- observed
  // on a stubborn brain-dump adhoc looping in this pass.)

  // PRELIMINARY DECOMPOSE CHECK (2026-09-02): one cheap model call, no tool loop, run
  // BEFORE the write-agentic pass. A task that is genuinely 5 endpoints + a UI + tests
  // wastes a full 35-turn agentic pass (and 2 retries) discovering that; catch it here
  // instead. Only on a FRESH task -- a retry / re-scoped / already-decomposed task has
  // specific feedback to act on and skips this. The decompose verdict flows straight to
  // review -> coordinator exactly like a RESOLUTION: decompose from the agentic pass.
  const preliminaryDecomposeEnabled = process.env.AGENT_MANAGER_PRELIMINARY_DECOMPOSE !== 'false';
  const isFreshAdhoc = !task.localRejectCount
    && !(Array.isArray(task.priorRejectionFeedback) && task.priorRejectionFeedback.length)
    && !task.rescopedFromDecompose
    && !task.autoDecomposeCount
    && !task.atomic // a file-decompose child IS the output of a decomposition -- re-splitting it loops
    && task.adhocResolution !== 'decompose';
  if (preliminaryDecomposeEnabled && isFreshAdhoc) {
    const split = await maybeLocked(resolvedCallIsLocal !== false, () => runDecomposePassIfAvailable(task, { mode: 'preliminary', call: resolvedLocalCall }), 'decompose-check');
    delete task._decomposeHint; // transient -- consumed by preliminaryPrompt above; never persist
    if (split && split.subTasks.length >= 2) {
      appendHistoryEvent(task, 'implement-started', `adhoc: preliminary size check -> decompose (${split.subTasks.length} pieces)`);
      task.adhocResolution = 'decompose';
      task.subTaskProposals = split.subTasks;
      task.rawDiff = '';
      task.implementResponse = `Preliminary size check: this task spans ${split.subTasks.length} independent pieces, so it was decomposed before any implementation attempt.\n\n${formatSubTaskProposalsForReview(split.subTasks)}`;
      concludeDraft(task);
      return { succeeded: true, blocked: false };
    }
  }

  // Local write-agentic. Returns the same verdict shape the Claude tier did
  // (succeeded/blocked/blockedReason/needsClarification); a non-succeeded result is a
  // genuine infra error (retry), everything else is terminal.
  appendHistoryEvent(task, 'implement-started', 'adhoc: local-agentic-write (multi-turn edit/write/run_bash in a worktree -- can take many minutes)');
  // Transient -- buildWriteAgenticPrompt reads it synchronously at the top of
  // draftAdhocViaLocalAgenticWrite; delete it right after so it is never persisted on the
  // task (same pattern as runPlanPass's task._seedPlan).
  if (typeof task.orientNotes === 'string' && task.orientNotes.trim()) {
    // The pre-plan orient pass (component 3) already mapped this task -- feed its report
    // in so this pass starts from confirmed findings instead of a blind re-grep.
    task._priorInvestigation = `Pre-plan orientation report (read-only pass, before the plan):\n\n${task.orientNotes.trim()}`;
  } else if (task.planWasGrounded && process.env.AGENT_MANAGER_ADHOC_PLAN_GROUNDING !== 'false') {
    // No agentic exploration ran, but the plan pass built deterministic grounding. Rebuild
    // it (cheap, no LLM) so this pass starts from verified file content instead of a blind re-grep.
    try {
      const g = buildPlanGrounding(task);
      if (g) task._priorInvestigation = `Deterministic grep grounding (no agentic exploration was run -- verify anything not shown):\n\n${g.text}`;
    } catch { /* non-fatal */ }
  }
  // PRE-FILTER FACT-CHECK: run the same deterministic fact-checker review-task.js uses
  // (checkDraft) against the text this pass is about to act on -- task.title +
  // promptContext.rawText + the blind plan (exactly the "ask" text
  // buildWriteAgenticPrompt assembles -- see local-agentic-write-draft.js) -- and stash
  // the resulting flags on task.preFilterFlags as an array of { type, detail } entries,
  // so the write-agentic prompt can warn the drafter up front about, e.g., files the
  // task claims that do not exist (missing-file / fabricated-commit-reference) instead
  // of only discovering it mid-loop. Best-effort: any failure (no repoRoot, fact-checker
  // throwing on an odd shape) leaves task.preFilterFlags untouched and this pass proceeds
  // exactly as before -- same non-fatal posture as the plan-grounding rebuild above.
  try {
    const fcText = [task && task.title,
      (task && task.promptContext && task.promptContext.rawText) || '',
      (task && (task.planResponse || task.lastGoodPlan))]
      .filter((s) => typeof s === 'string' && s.trim()).join('\n\n');
    if (fcText.trim()) {
      let fcRepoRoot;
      let fcExtraRoots = [];
      try {
        const cfg = getConfig();
        fcRepoRoot = cfg.repoRoot;
        fcExtraRoots = Array.isArray(cfg.grepAllowedDirs) ? cfg.grepAllowedDirs : [];
      } catch { /* fall through with whatever we have -- checkDraft tolerates it */ }
      const factCheck = checkDraft(fcText, fcRepoRoot, undefined, fcExtraRoots);
      // checkDraft returns { flags: [{ type, detail }, ...], ... } -- attach exactly the
      // flags array (guaranteed to be an array even when empty) per the pre-filter contract.
      task.preFilterFlags = Array.isArray(factCheck && factCheck.flags) ? factCheck.flags : [];
    }
  } catch (err) {
    console.warn('[local-draft] pre-filter fact-check failed (non-fatal):', err?.message ?? err);
  }
  const agenticResult = await maybeLocked(true, () => draftAdhocViaLocalAgenticWriteFn(task, { recordModelCall }), 'local-agentic-write');
  delete task._priorInvestigation;
  recordTier(attempt, {
    tier: 'local-agentic-write',
    resolution: agenticResult.resolution || task.adhocResolution,
    blocked: agenticResult.blocked,
    reason: agenticResult.reason || agenticResult.blockedReason,
    response: agenticResult.response,
    rawDiff: agenticResult.capturedDiff || (agenticResult.blocked ? undefined : task.rawDiff),
    turnsUsed: agenticResult.turnsUsed,
    toolCallLog: agenticResult.toolCallLog,
  });
  appendTierWorkLog(task, { tier: 'local-agentic-write', turnsUsed: agenticResult.turnsUsed, toolCallLog: agenticResult.toolCallLog, finalMessage: agenticResult.response });
  if (!agenticResult.succeeded) {
    return { succeeded: false, reason: agenticResult.reason };
  }
  if (agenticResult.blocked) {
    appendHistoryEvent(task, 'blocked', agenticResult.blockedReason);
    return { succeeded: true, blocked: true, blockedReason: agenticResult.blockedReason };
  }
  // 2026-08-24 (RESOLUTION: needs-human-decision, adhoc-agentic-draft.js): a real
  // open product/design question, not a diff or a sub-task list -- nothing here for
  // an automatic reviewer to verify against real repo state, so this skips review-
  // task.js/apply-task.js entirely and goes straight to queue/needs-clarification/
  // (local-worker.sh's own move-destination branch) for a human to actually answer.
  // Reuses `needsClarification`'s FIELD NAME (not path_prefetch_resolve's specific
  // shape) so the dashboard's existing "does this task have needsClarification"
  // check and Discuss button pick it up; `reason: 'design-decision'` is what
  // distinguishes this from path_prefetch's own ambiguous/no-match held tasks (see
  // python/dashboard/app.py's api_discuss_end, which branches on this exact field).
  // NB by the time execution reaches here, `BLOCKER-TYPE: budget-exhausted` and
  // `BLOCKER-TYPE: infra-error` have already been intercepted as retryable blocks in
  // resolveAgenticDraft (agentic-draft-common.js) -- the only thing that still arrives as
  // needsClarification is a genuine `BLOCKER-TYPE: design-question` (or an untagged real
  // open question), so the hardcoded reason:'design-decision' is now accurate.
  if (agenticResult.needsClarification) {
    // 2026-08-24 (Grimmethy: multiple-choice shortcut) -- options is undefined
    // (never a key at all, not even null) when the model didn't offer a clean
    // 2+ option OPTIONS block, so the dashboard's existing `nc.options` check
    // stays a plain truthy test either way.
    const options = parseClarificationOptions(task.implementResponse);
    task.needsClarification = {
      reason: 'design-decision', openQuestions: task.implementResponse,
      ...(options ? { options } : {}),
    };
    appendHistoryEvent(task, 'implement-done', `agentic, ${(task.implementResponse || '').length} chars, resolution=${task.adhocResolution}`);
    appendHistoryEvent(task, 'needs-clarification');
    return { succeeded: true, blocked: false, needsClarification: true };
  }
  appendHistoryEvent(task, 'implement-done', `agentic, ${(task.implementResponse || '').length} chars, resolution=${task.adhocResolution}`);
  concludeDraft(task);
  return { succeeded: true, blocked: false };
}

async function draftResearchBranch(task, { recordModelCall, draftResearchImplementFn, isClaudePausedFn = isClaudePaused, attempt }) {
  // research_task has no local implementation -- WebSearch/WebFetch are Claude-only. It
  // runs only when explicitly opted onto Claude AND a token is set AND Claude isn't
  // paused; otherwise it blocks cleanly for a human (draftTask hoists the same check
  // ahead of the plan pass, this is defence-in-depth).
  const claudeStatus = researchClaudeStatus(task, isClaudePausedFn);
  if (!claudeStatus.ok) {
    appendHistoryEvent(task, 'blocked', claudeStatus.reason);
    return { succeeded: true, blocked: true, blockedReason: claudeStatus.reason };
  }
  appendHistoryEvent(task, 'implement-started', 'agentic research (WebSearch/WebFetch, multi-turn -- can take minutes)');
  const researchResult = await draftResearchImplementFn(task, { recordModelCall });
  if (!researchResult.succeeded) {
    return { succeeded: false, reason: researchResult.reason };
  }
  if (researchResult.blocked) {
    recordTier(attempt, { tier: 'agentic-research', blocked: true, reason: researchResult.blockedReason });
    appendHistoryEvent(task, 'blocked', researchResult.blockedReason);
    return { succeeded: true, blocked: true, blockedReason: researchResult.blockedReason };
  }
  recordTier(attempt, { tier: 'agentic-research', resolution: 'implemented', response: task.implementResponse });
  appendHistoryEvent(task, 'implement-done', `agentic research, ${(task.implementResponse || '').length} chars`);
  concludeDraft(task);
  return { succeeded: true, blocked: false };
}

module.exports = { resolveDraftContext, runStalenessFastpath, draftAdhocBranch, draftResearchBranch };
