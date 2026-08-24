'use strict';

// Commits a task's own record into the repo it belongs to (2026-08-24, Grimmethy: "We're
// going to start saving the tasks directly to repo from now on. If we have all agent
// manager related tasks in the repo then collaborators can access not only future work but
// the history as well.") -- every task previously lived only in queue/<state>/<id>.json,
// gitignored, local to whichever machine runs this pipeline. This writes a SEPARATE,
// additional, git-tracked mirror at a STABLE path (.agent-manager/tasks/<id>.json, updated
// in place across the task's whole lifecycle, never moved between state-named folders the
// way queue/ is) so `git log --follow`/`git blame` on one file shows a task's complete
// history. The live queue/<state>/ directory structure this pipeline's own daemons
// actually read/write is completely unchanged -- this module only ever ADDS a mirror, it
// never becomes the operational source of truth.
//
// Two modes:
//   commit: true (default) -- a small, SELF-CONTAINED direct-to-main commit, via an
//     isolated git worktree (never the shared repoRoot working tree apply-task.js also
//     operates on -- see adhoc-agentic-draft.js's own header for the exact, twice-repeated
//     incident this avoids: "this repo is sometimes edited live in the same working tree
//     the pipeline operates on"). Used for every state transition that ISN'T already
//     producing a real code commit of its own (task creation, blocked, needs-
//     clarification -- see task-sources.js's writeTask()/local-draft.js's own call sites).
//   commit: false -- write only, inside whatever working tree the CALLER already has
//     checked out (repoRoot itself), returning the relative path written so the caller can
//     fold it into its OWN `git add`/commit that's already about to happen (apply-task.js's
//     real code-change commit) -- true piggyback, no second commit created.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { detectDefaultBranch } = require('./git-runner.js');

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
const GIT_TIMEOUT_MS = 60_000;
const TASKS_DIRNAME = '.agent-manager/tasks';

function runGit(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV, timeout: GIT_TIMEOUT_MS });
}

function relativeTaskPath(task) {
  return path.join(TASKS_DIRNAME, `${task.id}.json`);
}

function writeTaskFile(repoRoot, task) {
  const relPath = relativeTaskPath(task);
  const fullPath = path.join(repoRoot, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, JSON.stringify(task, null, 2));
  return relPath;
}

function commitMessageFor(task) {
  return [
    `task: ${task.title || task.id} (${task.status || 'unknown'})`,
    '',
    `Task: ${task.id} (${task.domain || ''}/${task.source || ''})`,
  ].join('\n');
}

/**
 * Writes/updates a task's own record at .agent-manager/tasks/<id>.json.
 * @param {object} task
 * @param {{repoRoot: string, commit?: boolean}} opts
 * @returns {{relPath: string, committed: boolean}}
 */
function syncTaskToRepo(task, { repoRoot, commit = true } = {}) {
  if (!repoRoot || !task || !task.id) {
    return { relPath: null, committed: false };
  }

  if (!commit) {
    // Piggyback mode -- caller already has repoRoot checked out and is about to commit
    // its own real change; just write the file and hand back the path.
    const relPath = writeTaskFile(repoRoot, task);
    return { relPath, committed: false };
  }

  // Self-contained direct-to-main commit, isolated worktree -- see this file's own header.
  const mainBranch = detectDefaultBranch(repoRoot);
  const worktreeDir = path.join(os.tmpdir(), `agent-manager-task-sync-${task.id}-${Date.now()}`);

  try {
    runGit(['fetch', 'origin', mainBranch], repoRoot);
  } catch (e) {
    return { relPath: null, committed: false, error: `could not fetch origin/${mainBranch}: ${e.message}` };
  }

  try {
    runGit(['worktree', 'add', worktreeDir, `origin/${mainBranch}`], repoRoot);
  } catch (e) {
    return { relPath: null, committed: false, error: `could not create sync worktree: ${e.message}` };
  }

  try {
    const relPath = writeTaskFile(worktreeDir, task);
    runGit(['add', relPath], worktreeDir);

    // Nothing to commit is a normal, expected outcome (e.g. syncing a task whose record
    // is byte-for-byte identical to what's already committed) -- not an error.
    const status = runGit(['status', '--porcelain'], worktreeDir);
    if (!status.trim()) {
      return { relPath, committed: false };
    }

    const msgPath = path.join(os.tmpdir(), `task-sync-commit-msg-${task.id}.txt`);
    fs.writeFileSync(msgPath, commitMessageFor(task));
    try {
      runGit(['commit', '-F', msgPath], worktreeDir);
    } finally {
      fs.unlinkSync(msgPath);
    }

    // Real, expected race: another sync (or an apply-task.js direct-to-main commit)
    // pushed to origin/<mainBranch> between this worktree's own fetch and now -- retried
    // ONCE via fetch+rebase+push before giving up, rather than failing on the very first
    // contention this module will realistically see under any concurrent daemon activity.
    try {
      runGit(['push', 'origin', `HEAD:${mainBranch}`], worktreeDir);
    } catch (e) {
      runGit(['fetch', 'origin', mainBranch], worktreeDir);
      runGit(['rebase', `origin/${mainBranch}`], worktreeDir);
      runGit(['push', 'origin', `HEAD:${mainBranch}`], worktreeDir);
    }
    return { relPath, committed: true };
  } catch (e) {
    return { relPath: null, committed: false, error: `task-repo-sync commit/push failed: ${e.message}` };
  } finally {
    try { runGit(['worktree', 'remove', '--force', worktreeDir], repoRoot); } catch (e) { /* best-effort */ }
  }
}

module.exports = { syncTaskToRepo, relativeTaskPath, TASKS_DIRNAME };
