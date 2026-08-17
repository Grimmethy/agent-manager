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
const { applySecondBrainNote, applyProjectSearchFindings, applyDeepDiveFindings, applyBrainDumpSort, applyPathPrefetchResolve, closeBrainDumpEntryResolved } = require('./apply-group-a.js');
const { applyGroupB, batchContainsDeleteMode } = require('./apply-group-b.js');
const { createRealGitRunner } = require('./git-runner.js');
const { appendHistoryEvent } = require('./task-history.js');

// Registers this package's 6 built-in sources FIRST (side effect of the require) -- the
// consumer's own registration file (ensureRegistered, below) calls updateTaskSource on
// some of these built-ins (e.g. attaching a custom `apply` to arch_discovery), which
// throws if the base entry isn't registered yet. Order matters.
require('./task-sources.js');
ensureRegistered();

// Shared by writeArtifact (which needs to know WHICH apply to call) and the
// awaiting-confirm gate below (which needs to know whether one's coming, before calling
// it) -- a source with its own registered `apply` (arch_discovery, arch_import,
// unused_export, etc.) never touches applyGroupB at all, so the delete gate has nothing to
// check for those; only a source with no custom apply falls through to the generic Group B
// JSON-change-object path.
// arch_discovery/arch_import's apply is a low-risk, additive-only append to a
// candidates-tracking doc -- never real application code (the actual code-writing
// follow-up, arch_review/arch_import_review, goes through the normal branch+review
// flow below like everything else). Confirmed live 2026-08-16: with every domain going
// through the same throwaway agent/<task.id> branch + skipPush's "commit locally, stop
// there" mode, these two domains' commits had nowhere durable to land -- ~311 such
// branches were created over time, only 10 ever survived to be reviewed, and NONE had
// ever reached main. See applyTask()'s own comment at the git-branch-diff flow for how
// this set changes the sequence.
const DIRECT_TO_MAIN_DOMAINS = new Set(['arch_discovery', 'arch_import']);

function usesGroupB(task) {
  const source = getRegisteredSource(resolveSourceName(task));
  return !(source && typeof source.apply === 'function');
}

function writeArtifact(task, repoRoot, pipelineDir) {
  if (!usesGroupB(task)) {
    const source = getRegisteredSource(resolveSourceName(task));
    return source.apply({ implementResponse: task.implementResponse, repoRoot, pipelineDir, task });
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
  if (task.domain !== 'adhoc') return;
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
      });
      if (result.skipped) return { succeeded: true, doneMarker: result.reason };
      return { succeeded: true, doneMarker: `filed under "${result.category}" -> ${result.file}` };
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

    // Non-secondbrain: git-branch-diff flow. Order matters -- fetch/reset/branch FIRST,
    // then write the artifact, so the change lands on the new branch, never on main.
    gitRunner.fetchMain();
    gitRunner.resetToMain();

    // commitsDirectlyToMain domains skip the branch entirely (branchName stays null) --
    // see DIRECT_TO_MAIN_DOMAINS' own header comment for why. Everything else keeps the
    // normal throwaway agent/<id> branch.
    const commitsDirectlyToMain = DIRECT_TO_MAIN_DOMAINS.has(task.domain);
    const branchName = commitsDirectlyToMain ? null : `agent/${task.id}`;
    if (branchName) gitRunner.createBranch(branchName);

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
      'Co-Authored-By: Ornith <noreply@ornith.local>',
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
    return { succeeded: true, branch: branchName, pushed: true };
  } catch (e) {
    const reason = e.stderr ? e.stderr.toString() : e.message;
    return { succeeded: false, reason };
  }
}

function main() {
  const taskPath = process.argv[2];
  if (!taskPath) {
    process.stdout.write(JSON.stringify({ succeeded: false, reason: 'usage: node apply-task.js <task.json>' }));
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
  // pattern ornith-draft.js/review-task.js already use -- lands before that move.
  // needsConfirmation checked first, matching apply-task.sh's own precedence: it reports
  // succeeded:false but is a hold for a human (a delete-containing batch), not a failure.
  const applyStage = result.needsConfirmation ? 'awaiting-confirm' : (result.succeeded ? 'applied' : 'apply-failed');
  appendHistoryEvent(task, applyStage, result.doneMarker || result.branch || result.reason);
  try {
    fs.writeFileSync(taskPath, JSON.stringify(task, null, 2));
  } catch (e) {
    // Non-fatal -- the apply outcome itself (result, already computed above) is what
    // actually gates the caller's file-move decision; a failure to also persist the
    // history event shouldn't turn a real apply success into a reported failure.
  }

  process.stdout.write(JSON.stringify(result));
}

module.exports = { applyTask };

if (require.main === module) {
  main();
}
