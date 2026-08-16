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
const { applySecondBrainNote, applyProjectSearchFindings, applyDeepDiveFindings, applyBrainDumpSort, applyPathPrefetchResolve } = require('./apply-group-a.js');
const { applyGroupB, batchContainsDeleteMode } = require('./apply-group-b.js');
const { createRealGitRunner } = require('./git-runner.js');

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
 * @param {boolean} [config.skipPush] - "Implement" mode: commit locally on the new branch
 *   but don't push. Stays checked out on the branch (rather than returning to main) so the
 *   local working tree actually reflects the applied change for inspection.
 * @returns {{succeeded: boolean, branch?: string, pushed?: boolean, doneMarker?: string, reason?: string}}
 */
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

    const branchName = `agent/${task.id}`;
    gitRunner.createBranch(branchName);

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
      try { gitRunner.checkoutMain(); gitRunner.deleteBranch(branchName); } catch (_) { /* best-effort cleanup */ }
      return { succeeded: false, reason: writeErr.message };
    }

    if (artifact && artifact.skipped) {
      gitRunner.checkoutMain();
      gitRunner.deleteBranch(branchName);
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

    // "Implement" mode: commit locally and stop there. Deliberately does NOT roll back or
    // delete the branch on any later failure path the way the push branch below does --
    // there's nothing after this to fail, and the whole point is to leave the applied
    // branch/commit in place, checked out, for local inspection.
    if (skipPush) {
      return { succeeded: true, branch: branchName, pushed: false };
    }

    // A push failure here means the commit already succeeded -- a local branch with a
    // real, un-pushed commit would otherwise be left behind silently, and no caller could
    // tell this apart from a clean success (apply-runner.ps1 treats any non-throwing exit
    // as authoritative). Roll back specifically on push failure, distinct from the
    // write-failure cleanup above, so the failure is reported instead of orphaned.
    try {
      gitRunner.push(branchName);
    } catch (pushErr) {
      try { gitRunner.checkoutMain(); gitRunner.deleteBranch(branchName); } catch (_) { /* best-effort cleanup */ }
      return { succeeded: false, reason: `push failed after commit succeeded (rolled back): ${pushErr.message}` };
    }
    gitRunner.checkoutMain();

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
  process.stdout.write(JSON.stringify(result));
}

module.exports = { applyTask };

if (require.main === module) {
  main();
}
