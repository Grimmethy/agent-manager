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
const { execFileSync } = require('child_process');
const { getConfig, ensureRegistered } = require('./config.js');
const { getRegisteredSource, resolveSourceName } = require('./task-source-registry.js');
const { applySecondBrainNote } = require('./apply-group-a.js');
const { applyGroupB } = require('./apply-group-b.js');

// Registers this package's 6 built-in sources FIRST (side effect of the require) -- the
// consumer's own registration file (ensureRegistered, below) calls updateTaskSource on
// some of these built-ins (e.g. attaching a custom `apply` to arch_discovery), which
// throws if the base entry isn't registered yet. Order matters.
require('./task-sources.js');
ensureRegistered();

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
};
const GIT_TIMEOUT_MS = 60_000;

function runGit(args, repoRoot) {
  return execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe', encoding: 'utf8', env: GIT_ENV, timeout: GIT_TIMEOUT_MS });
}

function writeArtifact(task, repoRoot, pipelineDir) {
  const sourceName = resolveSourceName(task);
  const source = getRegisteredSource(sourceName);
  if (source && typeof source.apply === 'function') {
    return source.apply({ implementResponse: task.implementResponse, repoRoot, pipelineDir, task });
  }
  return applyGroupB({ implementResponse: task.implementResponse, repoRoot, pipelineDir });
}

function main() {
  const taskPath = process.argv[2];
  if (!taskPath) {
    process.stdout.write(JSON.stringify({ succeeded: false, reason: 'usage: node apply-task.js <task.json>' }));
    return;
  }

  const { repoRoot, pipelineDir, secondBrainDir } = getConfig();

  let task;
  try {
    task = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
  } catch (e) {
    process.stdout.write(JSON.stringify({ succeeded: false, reason: `Could not read/parse task JSON: ${e.message}` }));
    return;
  }

  try {
    if (task.domain === 'secondbrain') {
      const result = applySecondBrainNote({
        implementResponse: task.implementResponse,
        notePath: task.promptContext.notePath,
        secondBrainDir,
      });
      process.stdout.write(JSON.stringify({ succeeded: true, doneMarker: result.marker }));
      return;
    }

    // Non-secondbrain: git-branch-diff flow. Order matters -- fetch/reset/branch FIRST,
    // then write the artifact, so the change lands on the new branch, never on main.
    runGit(['fetch', 'origin', 'main'], repoRoot);
    runGit(['checkout', 'main'], repoRoot);
    runGit(['reset', '--hard', 'origin/main'], repoRoot);

    const branchName = `agent/${task.id}`;
    runGit(['checkout', '-b', branchName], repoRoot);

    let artifact;
    try {
      artifact = writeArtifact(task, repoRoot, pipelineDir);
    } catch (writeErr) {
      try { runGit(['checkout', 'main'], repoRoot); runGit(['branch', '-D', branchName], repoRoot); } catch (_) { /* best-effort cleanup */ }
      process.stdout.write(JSON.stringify({ succeeded: false, reason: writeErr.message }));
      return;
    }

    if (artifact && artifact.skipped) {
      runGit(['checkout', 'main'], repoRoot);
      runGit(['branch', '-D', branchName], repoRoot);
      process.stdout.write(JSON.stringify({ succeeded: true, doneMarker: artifact.reason }));
      return;
    }

    // Group A functions return { file: '...' } (one artifact); Group B returns
    // { files: [...] } (one or more). Normalize to an array so both shapes stage
    // correctly regardless of which path produced the artifact.
    const filesToAdd = artifact.files || [artifact.file];
    runGit(['add', ...filesToAdd], repoRoot);

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
      runGit(['commit', '-F', msgPath], repoRoot);
    } finally {
      fs.unlinkSync(msgPath);
    }

    runGit(['push', '-u', 'origin', branchName], repoRoot);
    runGit(['checkout', 'main'], repoRoot);

    process.stdout.write(JSON.stringify({ succeeded: true, branch: branchName }));
  } catch (e) {
    const reason = e.stderr ? e.stderr.toString() : e.message;
    process.stdout.write(JSON.stringify({ succeeded: false, reason }));
  }
}

main();
