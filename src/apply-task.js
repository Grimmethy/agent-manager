'use strict';

// Deterministic apply step: writes/edits/deletes the right file for an already-approved
// task (via apply-group-a.js / apply-group-b.js, or a source's own registered `apply`),
// then does the entire git branch/commit/push sequence itself via child_process -- no LLM
// involved in apply at all, ever.
//
// CLI: node apply-task.js <task.json>
// Writes ONE line of JSON to stdout:
//   { succeeded: true, branch: 'agent/<id>' }
//   { succeeded: true, doneMarker: '<path>' }
//   { succeeded: false, reason: '<message>' }

const fs = require('fs');
const path = require('path');
const { getConfig, ensureRegistered } = require('./config.js');
const { getRegisteredSource, resolveSourceName } = require('./task-source-registry.js');
const { applySecondBrainNote, applyProjectSearchFindings, applyDeepDiveFindings, applyBrainDumpSort, applyPathPrefetchResolve, closeBrainDumpEntryResolved, applyResearchTask, isEffectivelyEmptyResponse, applyArchDiscoveryCandidates } = require('./apply-group-a.js');
const { applyGroupB, batchContainsDeleteMode } = require('./apply-group-b.js');
const { createRealGitRunner } = require('./git-runner.js');
const { appendHistoryEvent } = require('./task-history.js');
const { requeueBlockedTasksForSignature } = require('./blocked-drain.js');

// Registers this package's 6 built-in sources FIRST (side effect of the require) -- the
// consumer's own registration file (ensureRegistered, below) calls updateTaskSource on
// some of these built-ins (e.g. attaching a custom `apply` to arch_discovery), which
// throws if the base entry isn't registered yet. Order matters.
require('./task-sources.js');
ensureRegistered();

// A source whose apply is a low-risk, additive-only append to a candidates-tracking doc
// (never real application code) declares `directToMain: true` on its registration and
// skips the throwaway agent/<id> branch + review + merge cycle entirely -- it commits
// straight to main. The candidate-generating hygiene sources (arch_discovery, arch_import,
// observability_review, performance_review) all set it; the code-writing follow-ups
// (arch_review, observability_fix, ...) do NOT -- they go through the normal branch flow.
//
// History: this was DIRECT_TO_MAIN_DOMAINS checked against task.domain, which every one of
// those sources stamps as "default" -- so it never matched, and the fast path was dead
// code from the day it was written (~311 throwaway branches created, 10 reviewed, 0 merged
// before 2026-08-21). Fixed to check task.source, then (ADR-0022 Stage A1) moved onto the
// registry as `directToMain`, and (Stage G) the source-name literal was dropped entirely.

// task.draftModel (stamped by local-draft.js/adhoc-agentic-draft.js at draft time, same
// "claude:<model>"-or-"<real ollama tag>" label model-provider.js's labelFor() and the
// Workers/Models tabs already use) says which backend actually drafted this change -- was
// previously ignored entirely, hardcoding every commit's Co-Authored-By to Ornith even
// when e.g. the adhoc agentic pass (Claude Code CLI, never Ornith) produced the diff.
// Falls back to Ornith for any task queued before draftModel existed, matching the old
// hardcoded behavior.
//
// FIXED 2026-08-20 (Grimmethy: "It's showing that ornith authored the script which
// implies that the program is inaccurately representing model used"): the non-Claude
// branch below used to discard draftModel entirely and always print the bare string
// "Ornith", even though labelFor() (model-provider.js) already returns the REAL local
// model tag (process.env.LOCAL_MODEL, e.g. "qwen3.8:27b-q4_K_M" -- not literally
// "ornith") for exactly this case. Every local-drafted commit in this pipeline's history
// was crediting a generic brand name instead of the actual model that did the work, while
// the Claude branch right above it was always specific ("Claude (sonnet)"). Confirmed
// live: dashboard-settings.json currently pins all three lanes to
// qwen3.8:27b-q4_K_M -- none of them are literally named "ornith" at all.
function coAuthorTrailer(task) {
  const draftModel = task.draftModel || '';
  if (draftModel.startsWith('claude:')) {
    return `Co-Authored-By: Claude (${draftModel.slice('claude:'.length)}) <noreply@anthropic.com>`;
  }
  // 2026-08-24 (Grimmethy: "Ornith is no longer the default model... reference local
  // instead") -- this used to hardcode "Ornith" as the local drafting model's identity,
  // which was already stale per this function's own comment above (dashboard-settings.json
  // pins qwen3.8:27b-q4_K_M, not literally "ornith"). Names whichever local model actually
  // drafted it instead of assuming a fixed brand.
  if (draftModel && draftModel !== 'ornith' && draftModel !== 'local') {
    return `Co-Authored-By: Local Model (${draftModel}) <noreply@agent-manager.local>`;
  }
  return 'Co-Authored-By: Local Model <noreply@agent-manager.local>';
}

function usesGroupB(task) {
  const source = getRegisteredSource(resolveSourceName(task));
  return !(source && typeof source.apply === 'function');
}

// 2026-08-26, root-caused live via arch-review-ac-4 -- see prompts.js's
// candidateSplitInstructions and local-draft.js's parseCandidateSplit for the full
// incident/design. A resolved `{"mode": "split"}` task has no diff to apply -- its
// implementResponse is candidate-write-up JSON, not Group-B create/edit/delete JSON, so
// it must be intercepted here BEFORE usesGroupB's own dispatch, which would otherwise
// hand it straight to applyGroupB's JSON.parse and fail with a confusing "invalid mode"
// error. Writes each sub-candidate back into the SAME candidates doc the original came
// from -- reusing applyArchDiscoveryCandidates (apply-group-a.js), the exact appender
// arch_discovery's own apply already uses -- via the resolved source's own
// candidatesPath()/candidateDocTitle (task-sources.js/maintenance/*.js registrations),
// never a hardcoded path here, so a new candidate-fulfillment source only needs to
// register those two fields to get split support for free.
// Throws rather than returning {succeeded:false} on either failure path below -- the
// caller's own try/catch around writeArtifact() (see its own comment) already does the
// right cleanup (abandon the throwaway branch, or reset main's working tree) for a
// thrown apply error, exactly the same treatment a Group B parse failure gets; returning
// a bare {succeeded:false} here instead would fall through to the untouched
// `filesToAdd = artifact.files || [artifact.file]` line with neither present, a worse
// and less diagnosable failure than the one this function is trying to report clearly.
function applyCandidateSplit(task, source) {
  if (!source || typeof source.candidatesPath !== 'function') {
    throw new Error(`task ${task.id} has candidateSplitProposals but its source ("${resolveSourceName(task)}") has no registered candidatesPath to write them back to`);
  }
  // AC-1, AC-2, ... placeholder numbering -- parseArchDiscoveryCandidates (apply-group-a.js)
  // requires a real digit after "AC-" just to recognize a block boundary at all
  // (`/(?=^#{1,6}\s*AC-\d+)/m`); applyArchDiscoveryCandidates re-derives the REAL id from
  // whatever already exists in the target doc regardless of what's written here (same
  // "the real numbering is assigned when this is written to the doc" convention
  // backlogDecompositionImplementPrompt already tells the model directly), so these only
  // need to be valid enough to parse, never actually correct.
  const markdown = task.candidateSplitProposals.map((c, i) => [
    `### AC-${i + 1} · ${c.title}`,
    'Strength: Strong',
    // Split-Depth: N -- nextCandidateFulfillmentTask refuses to pre-split a candidate at
    // depth >= 1, the hard one-level recursion stop for the deterministic pre-split gate.
    c.splitDepth ? `Split-Depth: ${c.splitDepth}` : '',
    c.files ? `Files: ${c.files}` : '',
    '',
    'Problem:', c.problem,
    '',
    'Solution:', c.solution,
    '',
    'Benefits:', c.benefits || '(not specified)',
  ].join('\n')).join('\n\n');
  const result = applyArchDiscoveryCandidates({
    implementResponse: markdown,
    candidatesPath: source.candidatesPath(),
    ...(source.candidateDocTitle ? { docTitle: source.candidateDocTitle } : {}),
  });
  if (result.skipped) {
    // parseArchDiscoveryCandidates found nothing parseable -- parseCandidateSplit already
    // validated title/problem/solution are non-empty strings, so this would mean a
    // markdown-escaping edge case, not a legitimately-empty split.
    throw new Error(`candidate split approved but produced no parseable sub-candidate(s): ${result.reason}`);
  }
  // Same shape applyArchDiscoveryCandidates always returns ({file, candidateCount,
  // candidateIds}) -- identical to what arch_discovery's own registered `apply` hands
  // back for the exact same appender, so the generic "Group A returns {file: '...'}"
  // handling a few lines below this function's own caller already has picks it up with
  // no special-casing needed.
  return result;
}

function writeArtifact(task, repoRoot, pipelineDir) {
  if (Array.isArray(task.candidateSplitProposals) && task.candidateSplitProposals.length > 0) {
    return applyCandidateSplit(task, getRegisteredSource(resolveSourceName(task)));
  }
  if (!usesGroupB(task)) {
    const source = getRegisteredSource(resolveSourceName(task));
    return source.apply({ implementResponse: task.implementResponse, repoRoot, pipelineDir, task });
  }
  // Confirmed live 2026-08-22: several Group B sources (arch_review, observability_fix,
  // performance_fix, pipeline_self_audit, ...) are explicitly told to output the empty
  // string when there's genuinely nothing to change (see prompts.js's own instructions,
  // and review-task.js's EMPTY_APPROVAL_SOURCES, which already treats this exact case as
  // a legitimate approved outcome at REVIEW time) -- but this apply stage had no matching
  // check of its own, so an approved-empty task reached applyGroupB's JSON.parse
  // unconditionally and threw "Invalid JSON in Group B implementResponse: Unexpected end
  // of JSON input", landing the task in blocked/ instead of a clean, correct skip. Found
  // as a real 6-task cluster in queue/blocked/ this same session -- invisible to
  // pipeline_self_audit's own detector besides, since that error text matches none of its
  // REASON_CATEGORIES keywords. Same {skipped, reason} shape apply-group-a.js's own
  // applyVerdictOnly already uses for "nothing to write, that's a legitimate outcome."
  if (isEffectivelyEmptyResponse(task.implementResponse)) {
    return { skipped: true, reason: 'no code change needed (empty implement response, already approved at review)' };
  }
  return applyGroupB({ implementResponse: task.implementResponse, repoRoot, pipelineDir });
}

/**
 * The actual apply logic, independent of the CLI/stdout wrapper below -- exported so tests
 * can call it directly with a fake git runner and a throwaway repoRoot/pipelineDir,
 * instead of exercising a real git repo or shelling out to a child process.
 * @param {object} task - The parsed task record.
 * @param {object} config
 * @param {string} config.repoRoot
 * @param {string} config.pipelineDir
 * @param {string} [config.secondBrainDir]
 * @param {string} [config.projectSearchIndexPath]
 * @param {string} [config.deepDiveAnalysisDir]
 * @param {string} [config.deepDiveCoveragePath]
 * @param {string} [config.brainDumpPath]
 * @param {object} [config.gitRunner] - Defaults to a real git runner against repoRoot.
 * @param {boolean} [config.skipPush] - "Implement" mode. No longer skips the push itself
 *   (see the git-branch-diff flow's own comment for why an unpushed branch is a
 *   durability risk, not just an inspection nicety) -- the branch/direct-to-main commit
 *   always gets pushed regardless. What this still controls: for the per-task-branch
 *   path, stays checked out on the branch (rather than returning to main) so the local
 *   working tree actually reflects the applied change for inspection.
 * @returns {{succeeded: boolean, branch?: string, pushed?: boolean, doneMarker?: string, reason?: string}}
 */
// Auto-closes the originating Brain Dump entry once an adhoc task is actually resolved
// (Brain Dump #67) -- productionizes the manual hand-editing step a human/Claude session
// had been doing after every real fix landed this way. Only fires for domain:'adhoc'
// (the agentic-implement path, adhoc-agentic-draft.js, is the only one that stamps
// task.rawDiff/task.adhocResolution) with a brainDumpEntryId ("Process now" stamps this;
// a raw queue-adhoc-task.js CLI task submitted with no brain-dump origin has none, and
// correctly has nothing to close here). Best-effort -- see closeBrainDumpEntryResolved's
// own header for why a missing/already-mutated entry is not an apply failure.
function closeOriginatingBrainDumpEntry(task, brainDumpPath, note) {
  // research (Brain Dump #1 follow-up, 2026-08-17): same shape as adhoc -- a
  // brainDumpEntryId only ever appears on a task queued by applyBrainDumpSort's own
  // requiresResearch branch, so this is unambiguous the same way adhoc's own check is.
  if (task.domain !== 'adhoc' && task.domain !== 'research') return;
  const brainDumpEntryId = task.promptContext && task.promptContext.brainDumpEntryId;
  if (!brainDumpEntryId) return;
  try {
    closeBrainDumpEntryResolved({ brainDumpPath, brainDumpEntryId, note });
  } catch (e) {
    // Never let bookkeeping failure turn a real, already-applied fix into a reported
    // apply failure -- same "recording shouldn't break the real feature" contract
    // model_stats_client.py's own header states for its own best-effort writes.
  }
}

function applyTask(task, { repoRoot, pipelineDir, secondBrainDir, projectSearchIndexPath, deepDiveAnalysisDir, deepDiveCoveragePath, brainDumpPath, gitRunner = createRealGitRunner(repoRoot), skipPush = false }) {
  try {
    if (task.domain === 'secondbrain') {
      const result = applySecondBrainNote({
        implementResponse: task.implementResponse,
        notePath: task.promptContext.notePath,
        secondBrainDir,
      });
      return { succeeded: true, doneMarker: result.marker };
    }

    // brain_dump_sort's targets (brainDumpPath + a note under secondBrainDir) are both
    // outside repoRoot, same non-git shape as the three domains above -- see
    // apply-group-a.js's applyBrainDumpSort.
    if (task.domain === 'brain_dump_sort') {
      const result = applyBrainDumpSort({
        implementResponse: task.implementResponse,
        task,
        brainDumpPath,
        secondBrainDir,
        pipelineDir,
      });
      if (result.skipped) {
        // A recoverable skip already bumped the entry's sortAttempt inside applyBrainDumpSort,
        // so nextBrainDumpSortTask regenerates it under a fresh id (…-a1) rather than the
        // entry being dead behind this task's own record in done/.
        return { succeeded: true, doneMarker: result.recoverable ? `sort not applied (retrying): ${result.reason}` : result.reason };
      }
      if (result.queuedTaskId) return { succeeded: true, doneMarker: `queued ${result.queuedTaskId}${result.queuedProject ? ` in ${result.queuedProject}` : ''} -> ${result.file}` };
      return { succeeded: true, doneMarker: `filed -> ${result.file}` };
    }

    // project_search's target (UsefulProjectIndex/INDEX.md) lives OUTSIDE any project's
    // repo root by design (see ADR-0018) -- a non-git write, same shape as the secondbrain
    // path above, not the git-branch-diff flow below.
    if (task.domain === 'project_search') {
      const result = applyProjectSearchFindings({
        implementResponse: task.implementResponse,
        indexPath: projectSearchIndexPath,
      });
      if (result.skipped) return { succeeded: true, doneMarker: result.reason };
      return { succeeded: true, doneMarker: `${result.findingCount} finding(s) (${result.strongCount} strong) appended to ${result.file}` };
    }

    // deep_dive's target (UsefulProjectIndex/analysis/<project>.md) lives outside any
    // project's repo root too, same non-git shape as project_search above -- see ADR-0019.
    if (task.domain === 'deep_dive') {
      const result = applyDeepDiveFindings({
        implementResponse: task.implementResponse,
        task,
        analysisDir: deepDiveAnalysisDir,
        coveragePath: deepDiveCoveragePath,
      });
      if (result.skipped) return { succeeded: true, doneMarker: result.reason };
      return { succeeded: true, doneMarker: `${result.itemCount} action item(s) appended to ${result.file}` };
    }

    // path_prefetch_resolve's target (a held task JSON under pipelineDir/queue/
    // needs-clarification/) lives outside any project's repo root too, same non-git
    // shape as brain_dump_sort/project_search/deep_dive above -- see apply-group-a.js's
    // applyPathPrefetchResolve. Without this branch, the git-branch-diff flow below would
    // try to `git add`/commit an artifact shape (suggested/heldTaskId/paths) that was
    // never a {file}/{files} in the first place, on a domain with nothing to commit at all.
    if (task.domain === 'path_prefetch_resolve') {
      const result = applyPathPrefetchResolve({ implementResponse: task.implementResponse, task, pipelineDir });
      if (result.skipped) return { succeeded: true, doneMarker: result.reason };
      return { succeeded: true, doneMarker: `suggested ${result.paths.length} path(s) for ${result.heldTaskId} (confident: ${result.confident})` };
    }

    // Awaiting-confirm gate (usability/benefit investigation of TheAgent's per-action
    // approval idea, 2026-08-16): a Group B batch containing a `delete` gets ONE more
    // checkpoint before touching git or disk at all -- distinct from the reviewer's
    // whole-draft APPROVE/REJECT (review-task.js never distinguishes effect kind at all,
    // confirmed by reading its prompt-building code) and from the static, all-or-nothing
    // queue/.delete-mode-disabled kill switch (apply-group-b.js, global on/off with no
    // per-task record of who allowed what). TheAgent's own mechanism (an in-memory Map +
    // Promise blocking a live Express request, deny-by-default after a fixed 10-minute
    // window) doesn't port: nothing here is a long-lived process that COULD block on it --
    // every stage is a poll-and-exit daemon or a one-shot CLI call talking through
    // queue/<state>/ files. This is the filesystem-native equivalent instead: hold in
    // queue/awaiting-confirm/ (no fixed timeout -- matches how approved/blocked/needs-
    // clarification already just sit until a human acts, since this pipeline's real
    // observed review cadence is hours, not minutes) until the dashboard's confirm action
    // stamps deleteConfirmedAt and moves it back to queue/approved/ for a real re-run.
    // Only fires for tasks that would actually reach applyGroupB -- a source with its own
    // registered apply (arch_discovery, arch_import, unused_export) never touches Group B's
    // delete mode at all, so has nothing for this gate to check.
    if (usesGroupB(task) && !task.deleteConfirmedAt && batchContainsDeleteMode(task.implementResponse)) {
      return {
        succeeded: false,
        needsConfirmation: true,
        reason: 'this batch includes a delete -- held in queue/awaiting-confirm/ for human confirmation before touching git or disk',
      };
    }

    // REMOVED 2026-08-22 (Grimmethy: "I'd like to skip the confirm step. We already have
    // a manual step for merge to main. This extra step is unnecessary friction."): adhoc/
    // research_task/pipeline_self_audit/product_spec each used to hold here for an
    // explicit confirm click (adhocApplyConfirmedAt/researchApplyConfirmedAt/
    // pipelineSelfFixConfirmedAt/productSpecConfirmedAt) before a real diff could even
    // reach a pushed branch. That checkpoint's original purpose -- making sure a real
    // agentic-drafted change never lands with zero human awareness -- is still fully
    // covered downstream: nothing here merges to main on its own (git-branch-diff below
    // always stops at a pushed, unmerged agent/<id> branch; the actual merge is its own
    // separate, always-manual dashboard action, api_git_merge_branch). Holding a SECOND
    // gate in front of that first one was redundant, not additional safety -- every one
    // of these still needs the same human review at merge time regardless. The delete-
    // mode Group B gate just above this is UNCHANGED and deliberately not touched by this
    // removal: an irreversible delete is a different risk category than a revertable git
    // branch, and stays held for its own explicit confirm.
    // research's target (a note under secondBrainDir) is outside repoRoot and has nothing
    // to do with the tracked code repo's git state -- same non-git shape as secondbrain/
    // brain_dump_sort/project_search/path_prefetch_resolve above, intercepted here for the
    // same reason: the git-branch-diff flow below unconditionally fetches/resets/branches
    // the tracked repo for anything that reaches it, which would be actively wrong to run
    // for a task that never touches that repo at all.
    if (task.domain === 'research') {
      const result = applyResearchTask({ task, secondBrainDir });
      if (result.skipped) return { succeeded: true, doneMarker: result.reason };
      closeOriginatingBrainDumpEntry(task, brainDumpPath, `Researched and filed to ${result.file} -- Task: ${task.id}`);
      return { succeeded: true, doneMarker: `research write-up filed to ${result.file}` };
    }

    // Non-secondbrain: git-branch-diff flow. Order matters -- fetch/reset/branch FIRST,
    // then write the artifact, so the change lands on the new branch, never on main.
    gitRunner.fetchMain();
    gitRunner.resetToMain();

    // commitsDirectlyToMain sources skip the branch entirely (branchName stays null) and
    // commit straight to main -- see the `directToMain` header comment above. Everything
    // else keeps the normal throwaway agent/<id> branch. Declared per source on its
    // registration, so an out-of-tree plugin's source opts in without editing this file.
    const registered = getRegisteredSource(resolveSourceName(task));
    const commitsDirectlyToMain = !!(registered && registered.directToMain === true);
    const branchName = commitsDirectlyToMain ? null : `agent/${task.id}`;
    if (branchName) {
      // Defensive pre-cleanup (2026-08-25 -- same fix, same root cause, as adhoc-agentic-
      // draft.js's own scratch-worktree branch: confirmed live via apply-task-loop.log,
      // "fatal: a branch named 'agent/adhoc-add-a-hardware-tab-...' already exists" on
      // every single retry, forever). branchName is deterministic (task.id only) and
      // createBranch() below has no surrounding try/catch of its own -- if it throws
      // because a PRIOR interrupted apply attempt (a kill, a crash, a host reboot) left
      // this exact branch behind, the exception propagates straight out of applyTask()
      // with no cleanup at all, and every future retry for this same task fails
      // identically. We're guaranteed to already be on main here (resetToMain() above
      // just checked it out), so deleting any stale same-named branch is always safe --
      // it can only ever be THIS task's own abandoned leftover, never another task's.
      try { gitRunner.deleteBranch(branchName); } catch (_) { /* no stale branch */ }
      gitRunner.createBranch(branchName);
    }

    let artifact;
    try {
      artifact = writeArtifact(task, repoRoot, pipelineDir);
    } catch (writeErr) {
      // checkoutMain + deleteBranch here only ever cleans up the git branch pointer -- it
      // does NOT touch uncommitted working-tree writes (an untracked file persists
      // regardless of branch; an edit just rides along as a dirty change). For a Group B
      // multi-item batch, writeErr.message already carries the outcome of THAT file's own
      // internal rollback of its already-applied items (see apply-group-b.js) by the time
      // it reaches here -- this block is not, and was never sufficient as, the only
      // guarantee against a partial multi-file write surviving a mid-batch failure.
      if (branchName) {
        try { gitRunner.checkoutMain(); gitRunner.deleteBranch(branchName); } catch (_) { /* best-effort cleanup */ }
      } else {
        // No branch to abandon -- just discard whatever partial write landed on main's
        // own working tree so it can't ride along uncommitted into a later, unrelated apply.
        try { gitRunner.resetToMain(); } catch (_) { /* best-effort cleanup */ }
      }
      return { succeeded: false, reason: writeErr.message };
    }

    if (artifact && artifact.skipped) {
      if (branchName) {
        gitRunner.checkoutMain();
        gitRunner.deleteBranch(branchName);
      }
      closeOriginatingBrainDumpEntry(task, brainDumpPath, artifact.reason);
      return { succeeded: true, doneMarker: artifact.reason };
    }

    // A decomposed adhoc parent (applyAdhocDiff) does NOT complete -- it becomes a
    // coordinator in queue/coordinating/ tracking the sub-tasks it just queued.
    // recordApplyOutcome maps `coordinating` to its own applyStage / task.status, and
    // apply-task.sh moves the file to queue/coordinating/.
    if (artifact && artifact.coordinating) {
      if (branchName) {
        try { gitRunner.checkoutMain(); gitRunner.deleteBranch(branchName); } catch (_) { /* best-effort */ }
      }
      closeOriginatingBrainDumpEntry(task, brainDumpPath, artifact.reason);
      return { coordinating: true, subTasks: artifact.subTasks, reason: artifact.reason };
    }

    // A Group A `apply` can also return { succeeded:false, needsConfirmation:true } to
    // hold the task at queue/awaiting-confirm/ for a human before anything is written --
    // pipeline_forensics does this so its ranked report is read before a fix candidate is
    // filed. Without this, the artifact has no `file` and the git-branch-diff staging
    // below runs `git add [undefined]` -> "fatal: pathspec 'undefined' did not match any
    // files" (confirmed live 2026-09-01, the first real forensic report). The delete-mode
    // needsConfirmation gate above only covers usesGroupB tasks; this is its Group A
    // counterpart. recordApplyOutcome routes `needsConfirmation` to awaiting-confirm/.
    if (artifact && artifact.needsConfirmation) {
      if (branchName) {
        try { gitRunner.checkoutMain(); gitRunner.deleteBranch(branchName); } catch (_) { /* best-effort */ }
      }
      return artifact;
    }

    // Group A functions return { file: '...' } (one artifact); Group B returns
    // { files: [...] } (one or more). Normalize to an array so both shapes stage
    // correctly regardless of which path produced the artifact.
    const filesToAdd = artifact.files || [artifact.file];
    gitRunner.add(filesToAdd);

    const msgPath = path.join(require('os').tmpdir(), `apply-commit-msg-${task.id}.txt`);
    const commitMessage = [
      task.title,
      '',
      `Task: ${task.id} (${task.domain}/${task.source})`,
      '',
      coAuthorTrailer(task),
    ].join('\n');
    fs.writeFileSync(msgPath, commitMessage);
    try {
      gitRunner.commit(msgPath);
    } finally {
      fs.unlinkSync(msgPath);
    }

    if (commitsDirectlyToMain) {
      // Always pushes here, deliberately ignoring the global skipPush flag: unlike the
      // branch path below (where "commit locally, stop there" just leaves a harmless
      // unpushed branch for later inspection), a direct commit to main that's ahead of
      // origin gets silently destroyed by the very next apply's resetToMain() hard
      // reset -- leaving it unpushed would just recreate the exact data-loss bug this
      // whole path exists to fix. These domains' apply is additive-only doc content
      // that already passed the normal review gate before reaching here, so pushing
      // without the extra skipPush gate is the same risk profile as any other approved
      // task, not a new one.
      try {
        gitRunner.pushMain();
      } catch (pushErr) {
        // Deliberately NOT rolled back, unlike the branch path's push-failure rollback
        // below: the commit is real, already-reviewed work. Discarding it here would
        // recreate the loss this change exists to prevent. It stays local and goes out
        // with whatever push succeeds next -- only a sustained, repeated push failure
        // risks eventually losing it to a future resetToMain().
        return { succeeded: false, reason: `push to main failed after commit succeeded (kept local, not rolled back): ${pushErr.message}` };
      }
      return { succeeded: true, branch: gitRunner.mainBranch, pushed: true };
    }

    // Always pushes the branch now, regardless of skipPush -- confirmed live
    // 2026-08-16/17: an applied-but-unpushed agent/<id> branch is a real durability
    // risk, not just an inspection convenience. It sits invisible (queue/done/ reports
    // this task as succeeded either way, and nothing else in the dashboard
    // distinguishes "done and actually reachable" from "done, only copy is a local
    // branch"), and ~300 branches shaped exactly like this were eventually lost to a
    // bulk local branch cleanup with no warning. Pushing doesn't merge anything or
    // skip review -- the branch still needs a human (or arch_review/arch_import_
    // review's own follow-up) to actually land it on main -- it just means the one
    // copy of the applied work isn't purely local anymore. skipPush's only remaining
    // effect is whether this returns to main afterward or stays checked out on the
    // branch for local inspection -- that part of "Implement mode" is still worth
    // keeping, since it's genuinely about convenience, not about hiding the change.
    try {
      gitRunner.push(branchName);
    } catch (pushErr) {
      // Deliberately NOT rolled back, unlike the old behavior here: the commit is
      // real work that already passed review. Deleting the branch because a push
      // attempt failed would be strictly worse than leaving it local for a human (or
      // a later retry) to push by hand -- same reasoning as the direct-to-main path
      // above.
      return { succeeded: false, branch: branchName, reason: `push failed after commit succeeded (kept local, not rolled back): ${pushErr.message}` };
    }
    if (!skipPush) {
      gitRunner.checkoutMain();
    }

    closeOriginatingBrainDumpEntry(task, brainDumpPath, `Implemented and pushed to branch ${branchName} -- Task: ${task.id}`);

    // Auto-drain (2026-08-20, blocked-drain.js -- see its own header for the full
    // design): a signature-scoped fix just landed for real (this is the genuine
    // committed-and-pushed outcome, not an earlier unconfirmed pass and not a "nothing
    // groundable" no-op, which returns doneMarker instead and never reaches this line) --
    // requeue every currently-stuck task sharing that failure signature.
    //   pipeline_self_audit    -> sweep queue/blocked/
    //   pipeline_forensics_fix -> sweep queue/blocked/ AND queue/needs-clarification/
    //     (2026-09-01: a forensic study clusters tasks that landed in either state, so the
    //     fix has to drain both -- otherwise confirming the report files the fix and
    //     nothing ever pulls the studied tasks back, the exact gap this closes).
    // Best-effort: a drain failure must never turn a real, successful apply into a reported
    // failure; the fix itself already landed regardless.
    const drainSources = { pipeline_self_audit: ['blocked'], pipeline_forensics_fix: ['blocked', 'needs-clarification'] };
    if (drainSources[task.source] && task.promptContext && task.promptContext.signature) {
      let requeuedIds = [];
      try {
        ({ requeuedIds } = requeueBlockedTasksForSignature(pipelineDir, task.promptContext.signature, { dirs: drainSources[task.source] }));
        if (requeuedIds.length > 0) {
          console.error(`[apply-task] auto-requeued ${requeuedIds.length} stuck task(s) sharing signature "${task.promptContext.signature}": ${requeuedIds.join(', ')}`);
        }
      } catch (e) {
        // Non-fatal: the fix already landed; the next scheduler pass will retry.
        console.warn("[apply-task] auto-requeue failed (non-fatal)", {
          requeuedIds,
          signature: task.promptContext.signature,
          message: e?.message ?? String(e),
          stack: e?.stack,
        });
      }
    }

    return { succeeded: true, branch: branchName, pushed: true };
  } catch (e) {
    const reason = e.stderr ? e.stderr.toString() : e.message;
    return { succeeded: false, reason };
  }
}

// Mutates `task` in place with the outcome of an applyTask() result (history event, and
// on failure, blockedStage/blockedReason), returning the stage name written. Extracted
// from main() so this is unit-testable without spawning the CLI -- see its own inline
// comment on the apply-failed branch for why the stamping matters, not just the history
// event.
function recordApplyOutcome(task, result) {
  // Precedence matches apply-task.sh's move logic: `coordinating` (a decomposed parent
  // that now tracks its sub-tasks) and `needsConfirmation` (a human hold) are both checked
  // before succeeded/failed -- neither reports succeeded:true but neither is a failure.
  const applyStage = result.coordinating ? 'coordinating'
    : result.needsConfirmation ? 'awaiting-confirm'
      : (result.succeeded ? 'applied' : 'apply-failed');
  if (applyStage === 'coordinating') {
    task.subTasks = Array.isArray(result.subTasks) ? result.subTasks : [];
    task.progress = { done: 0, total: task.subTasks.length };
  }
  // An apply-failed task lands in queue/blocked/ next (apply-task.sh's own move), the same
  // directory reject-retry-check.js scans for blockedStage==='review' to auto-requeue. A
  // task that reached apply (i.e. got APPROVED) can still carry a stale blockedStage:
  // 'review'/blockedReason from an EARLIER, already-resolved review rejection -- approval
  // never clears those fields, only overwrites them on a NEW block. Confirmed live
  // 2026-08-18: a real apply failure (the --recount bug in apply-adhoc-diff.js) got
  // silently reclassified as a review rejection purely because of this leftover field, and
  // reject-retry-check.js discarded an already-approved, human-confirmed diff for a full
  // blind redraft instead of just leaving the apply failure for a human to look at. Stamp
  // this failure's OWN blockedStage/blockedReason here so that leftover field can never
  // survive past a real apply attempt -- 'apply' is deliberately not 'review', so
  // isReviewRejection() in reject-retry-check.js won't match it.
  if (applyStage === 'apply-failed') {
    task.blockedStage = 'apply';
    task.blockedReason = result.reason;
  }
  // Keep task.status in step with the queue directory apply-task.sh moves the file to next
  // (applied -> done/, apply-failed -> blocked/, awaiting-confirm -> awaiting-confirm/) --
  // same reason review-task.js's main() now does: the dashboard list view reads task.status
  // straight through, and nothing downstream of local-draft.js was updating it.
  task.status = { applied: 'done', 'apply-failed': 'blocked', 'awaiting-confirm': 'awaiting-confirm', coordinating: 'coordinating' }[applyStage];
  appendHistoryEvent(task, applyStage, result.doneMarker || result.branch || result.reason);
  return applyStage;
}

// Apply many directToMain (candidate-doc / *_review triage) tasks under ONE
// fetch+reset+commit+push instead of one per task. These sources' apply is an additive
// append to a Docs/*_CANDIDATES.md file that already passed review; committing+pushing each
// one individually (forced, because an unpushed commit ahead of origin is destroyed by the
// next apply's resetToMain -- see the commitsDirectlyToMain block in applyTask) turned a
// 140-task backlog drain into 140 tiny commits pushed to master. Batching keeps the exact
// same git effect (append + commit + push to main) but as a single commit.
//
// Returns { results: { <taskId>: { succeeded, doneMarker?, reason? } }, committed, pushed?, branch? }.
// A task whose source is NOT directToMain is refused here (results[id].succeeded=false) --
// the caller must send those through the per-task applyTask path.
function applyDirectToMainBatch(tasks, { repoRoot, pipelineDir, secondBrainDir, brainDumpPath, gitRunner = createRealGitRunner(repoRoot) } = {}) {
  const results = {};
  const eligible = [];
  for (const task of tasks) {
    const reg = getRegisteredSource(resolveSourceName(task));
    if (reg && reg.directToMain === true) {
      eligible.push(task);
    } else {
      results[task.id] = { succeeded: false, reason: 'source is not directToMain -- must be applied individually, not in the triage batch' };
    }
  }
  if (eligible.length === 0) return { results, committed: false };

  gitRunner.fetchMain();
  gitRunner.resetToMain();

  const staged = [];
  for (const task of eligible) {
    try {
      const artifact = writeArtifact(task, repoRoot, pipelineDir);
      if (artifact && artifact.skipped) {
        results[task.id] = { succeeded: true, doneMarker: artifact.reason };
        closeOriginatingBrainDumpEntry(task, brainDumpPath, artifact.reason);
        continue;
      }
      if (artifact && artifact.needsConfirmation) {
        results[task.id] = artifact; // -> awaiting-confirm/, nothing staged for this one
        continue;
      }
      const files = artifact.files || [artifact.file];
      gitRunner.add(files);
      staged.push({ task, files });
    } catch (e) {
      // This task's append threw. Its file may carry a partial trailing line -- cosmetic
      // in an append-only markdown candidate doc and visible in review; not worth a
      // resetToMain here (that would discard every sibling's already-good append too).
      results[task.id] = { succeeded: false, reason: `writeArtifact failed: ${e.message}` };
    }
  }

  if (staged.length === 0) return { results, committed: false };

  const msgPath = path.join(require('os').tmpdir(), `apply-batch-msg-${process.pid}.txt`);
  const commitMessage = [
    `Triage batch: ${staged.length} candidate-doc update(s)`,
    '',
    ...staged.map((s) => `- ${s.task.title} (task ${s.task.id})`),
    '',
    coAuthorTrailer(staged[0].task),
  ].join('\n');
  fs.writeFileSync(msgPath, commitMessage);
  try {
    gitRunner.commit(msgPath);
  } finally {
    fs.unlinkSync(msgPath);
  }

  try {
    gitRunner.pushMain();
  } catch (pushErr) {
    // Same rationale as applyTask's commitsDirectlyToMain push-failure handling: the
    // commit is real, already-reviewed work; discarding it here recreates the data-loss
    // this whole path exists to prevent. It stays local and rides out with the next push.
    for (const s of staged) {
      results[s.task.id] = { succeeded: false, reason: `triage batch push to main failed after commit (kept local, not rolled back): ${pushErr.message}` };
    }
    return { results, committed: true, pushed: false };
  }

  for (const s of staged) {
    results[s.task.id] = { succeeded: true, doneMarker: `committed to ${gitRunner.mainBranch} in a ${staged.length}-task triage batch` };
    closeOriginatingBrainDumpEntry(s.task, brainDumpPath, `Applied in a triage batch -- Task: ${s.task.id}`);
  }
  return { results, committed: true, pushed: true, branch: gitRunner.mainBranch };
}

// node apply-task.js --partition <file...>  -> { direct: [...], other: [...] }
// Splits approved task files into the directToMain set (batchable by --batch) and the rest
// (per-task applyTask). A file that can't be read/classified goes to `other` so the normal
// path reports its failure properly.
function mainPartition() {
  const { repoRoot } = getConfig();
  void repoRoot;
  const direct = [];
  const other = [];
  for (const p of process.argv.slice(3)) {
    try {
      const t = JSON.parse(fs.readFileSync(p, 'utf8'));
      const reg = getRegisteredSource(resolveSourceName(t));
      if (reg && reg.directToMain === true) direct.push(p); else other.push(p);
    } catch {
      other.push(p);
    }
  }
  process.stdout.write(JSON.stringify({ direct, other }));
}

// node apply-task.js --batch <file...>  -> { batch: true, results: [{ taskId, path, succeeded, needsConfirmation, doneMarker?, reason? }] }
// Writes each task file back in place (recordApplyOutcome -> status/history) before the
// caller moves it, exactly like the single-task path.
function mainBatch() {
  const { repoRoot, pipelineDir, secondBrainDir, brainDumpPath } = getConfig();
  const paths = process.argv.slice(3);
  const loaded = [];
  const out = [];
  for (const p of paths) {
    try {
      const t = JSON.parse(fs.readFileSync(p, 'utf8'));
      loaded.push({ task: t, path: p });
    } catch (e) {
      out.push({ path: p, succeeded: false, reason: `Could not read/parse task JSON: ${e.message}` });
    }
  }

  const { results } = applyDirectToMainBatch(loaded.map((l) => l.task), { repoRoot, pipelineDir, secondBrainDir, brainDumpPath });

  for (const { task, path: p } of loaded) {
    const r = results[task.id] || { succeeded: false, reason: 'no batch result produced for this task' };
    recordApplyOutcome(task, r);
    try { fs.writeFileSync(p, JSON.stringify(task, null, 2)); } catch { /* non-fatal, same as single path */ }
    out.push({ taskId: task.id, path: p, succeeded: !!r.succeeded, needsConfirmation: !!r.needsConfirmation, coordinating: !!r.coordinating, doneMarker: r.doneMarker, reason: r.reason });
  }
  process.stdout.write(JSON.stringify({ batch: true, results: out }));
}

function main() {
  if (process.argv[2] === '--partition') return mainPartition();
  if (process.argv[2] === '--batch') return mainBatch();

  const taskPath = process.argv[2];
  if (!taskPath) {
    process.stdout.write(JSON.stringify({ succeeded: false, reason: 'usage: node apply-task.js <task.json> | --partition <file...> | --batch <file...>' }));
    return;
  }

  const { repoRoot, pipelineDir, secondBrainDir, projectSearchIndexPath, deepDiveAnalysisDir, deepDiveCoveragePath, brainDumpPath } = getConfig();

  let task;
  try {
    task = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
  } catch (e) {
    process.stdout.write(JSON.stringify({ succeeded: false, reason: `Could not read/parse task JSON: ${e.message}` }));
    return;
  }

  // "Implement" mode, set by the dashboard's Project tab (or by hand) when a run should
  // commit locally without pushing -- see applyTask's skipPush param.
  const skipPush = process.env.AGENT_MANAGER_APPLY_SKIP_PUSH === 'true';

  const result = applyTask(task, { repoRoot, pipelineDir, secondBrainDir, projectSearchIndexPath, deepDiveAnalysisDir, deepDiveCoveragePath, brainDumpPath, skipPush });

  // Previously this module never wrote taskPath back at all -- a task landing in done/ or
  // blocked/ after this step carried no record it was ever applied: no timestamp, no
  // branch/commit info, no failure reason if apply itself failed. apply-task.sh (the
  // caller) moves the SAME file afterward, so writing it back here in place -- same
  // pattern local-draft.js/review-task.js already use -- lands before that move.
  const applyStage = recordApplyOutcome(task, result);
  try {
    fs.writeFileSync(taskPath, JSON.stringify(task, null, 2));
  } catch (e) {
    // Non-fatal -- the apply outcome itself (result, already computed above) is what
    // actually gates the caller's file-move decision; a failure to also persist the
    // history event shouldn't turn a real apply success into a reported failure.
  }

  process.stdout.write(JSON.stringify(result));
}

module.exports = { applyTask, recordApplyOutcome, applyDirectToMainBatch };

if (require.main === module) {
  main();
}
