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
const { applySecondBrainNote, applyProjectSearchFindings } = require('./apply-group-a.js');
const { applyGroupB } = require('./apply-group-b.js');
const { createRealGitRunner } = require('./git-runner.js');

// Registers this package's 6 built-in sources FIRST (side effect of the require) -- the
// consumer's own registration file (ensureRegistered, below) calls updateTaskSource on
// some of these built-ins (e.g. attaching a custom `apply` to arch_discovery), which
// throws if the base entry isn't registered yet. Order matters.
require('./task-sources.js');
ensureRegistered();

function writeArtifact(task, repoRoot, pipelineDir) {
  const sourceName = resolveSourceName(task);
  const source = getRegisteredSource(sourceName);
  if (source && typeof source.apply === 'function') {
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
 * @param {object} [config.gitRunner] - Defaults to a real git runner against repoRoot.
 * @returns {{succeeded: boolean, branch?: string, doneMarker?: string, reason?: string}}
 */
function applyTask(task, { repoRoot, pipelineDir, secondBrainDir, projectSearchIndexPath, gitRunner = createRealGitRunner(repoRoot) }) {
  try {
    if (task.domain === 'secondbrain') {
      const result = applySecondBrainNote({
        implementResponse: task.implementResponse,
        notePath: task.promptContext.notePath,
        secondBrainDir,
      });
      return { succeeded: true, doneMarker: result.marker };
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

    return { succeeded: true, branch: branchName };
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

  const { repoRoot, pipelineDir, secondBrainDir, projectSearchIndexPath } = getConfig();

  let task;
  try {
    task = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
  } catch (e) {
    process.stdout.write(JSON.stringify({ succeeded: false, reason: `Could not read/parse task JSON: ${e.message}` }));
    return;
  }

  const result = applyTask(task, { repoRoot, pipelineDir, secondBrainDir, projectSearchIndexPath });
  process.stdout.write(JSON.stringify(result));
}

module.exports = { applyTask };

if (require.main === module) {
  main();
}
