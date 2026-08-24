'use strict';

// Commits a task's own record into a DEDICATED task-data repo -- never the project's own
// code repo (2026-08-24, Grimmethy, after the first version of this module committed
// directly into agent-manager's own repo: "That's going to bloat with multiple people
// working on the project. Can we build a sub-repo that stores task data?" -- a real
// separate GitHub repo, not a git submodule, which would add real friction for zero
// benefit here). Every task previously lived only in queue/<state>/<id>.json, gitignored,
// local to whichever machine runs this pipeline. This writes a git-tracked mirror at a
// STABLE path (tasks/<id>.json in the task-data repo, updated in place across the task's
// whole lifecycle, never moved between state-named folders the way queue/ is) so `git log
// --follow`/`git blame` on one file shows a task's complete history. The live
// queue/<state>/ directory structure this pipeline's own daemons actually read/write is
// completely unchanged -- this module only ever ADDS a mirror in a separate repo, it never
// becomes the operational source of truth and never touches the code repo's own history.
//
// Since the task-data repo is a genuinely separate remote (not the same repository as
// repoRoot), `git worktree add` -- which only works within one repository's own object
// database -- isn't usable here the way apply-task.js's own commits use it. Each sync
// instead does a throwaway SHALLOW clone (--depth 1, cheap even as the task-data repo
// itself grows over time) into a temp dir, writes/commits/pushes, then deletes it -- same
// "never touch a shared working tree from a concurrent process" safety property, just via
// clone instead of worktree since there's no shared repo to add a worktree onto.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
const GIT_TIMEOUT_MS = 60_000;
const TASKS_DIRNAME = 'tasks';

function runGit(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV, timeout: GIT_TIMEOUT_MS });
}

function relativeTaskPath(task) {
  return path.join(TASKS_DIRNAME, `${task.id}.json`);
}

function commitMessageFor(task) {
  return [
    `task: ${task.title || task.id} (${task.status || 'unknown'})`,
    '',
    `Task: ${task.id} (${task.domain || ''}/${task.source || ''})`,
  ].join('\n');
}

/**
 * Writes/updates a task's own record at tasks/<id>.json in the dedicated task-data repo.
 * @param {object} task
 * @param {{taskRepoUrl: string, mainBranch?: string}} opts
 * @returns {{relPath: string, committed: boolean, error?: string}}
 */
function syncTaskToRepo(task, { taskRepoUrl, mainBranch = 'main' } = {}) {
  if (!taskRepoUrl || !task || !task.id) {
    return { relPath: null, committed: false };
  }

  const cloneDir = path.join(os.tmpdir(), `agent-manager-task-sync-${task.id}-${Date.now()}`);
  try {
    runGit(['clone', '--depth', '1', '--branch', mainBranch, taskRepoUrl, cloneDir]);
  } catch (e) {
    return { relPath: null, committed: false, error: `could not clone task-data repo: ${e.message}` };
  }

  try {
    const relPath = relativeTaskPath(task);
    const fullPath = path.join(cloneDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, JSON.stringify(task, null, 2));
    runGit(['add', relPath], cloneDir);

    // Nothing to commit is a normal, expected outcome (e.g. syncing a task whose record
    // is byte-for-byte identical to what's already committed) -- not an error.
    const status = runGit(['status', '--porcelain'], cloneDir);
    if (!status.trim()) {
      return { relPath, committed: false };
    }

    const msgPath = path.join(os.tmpdir(), `task-sync-commit-msg-${task.id}.txt`);
    fs.writeFileSync(msgPath, commitMessageFor(task));
    try {
      runGit(['commit', '-F', msgPath], cloneDir);
    } finally {
      fs.unlinkSync(msgPath);
    }

    // Real, expected race: another sync pushed to origin/<mainBranch> between this
    // clone's own fetch and now -- retried ONCE via fetch+rebase+push before giving up,
    // rather than failing on the very first contention this module will realistically
    // see under any concurrent daemon activity (multiple workers/reviewer/watchdog can
    // all trigger a sync close together).
    try {
      runGit(['push', 'origin', `HEAD:${mainBranch}`], cloneDir);
    } catch (e) {
      runGit(['fetch', '--depth', '1', 'origin', mainBranch], cloneDir);
      runGit(['rebase', `origin/${mainBranch}`], cloneDir);
      runGit(['push', 'origin', `HEAD:${mainBranch}`], cloneDir);
    }
    return { relPath, committed: true };
  } catch (e) {
    return { relPath: null, committed: false, error: `task-repo-sync commit/push failed: ${e.message}` };
  } finally {
    try { fs.rmSync(cloneDir, { recursive: true, force: true }); } catch (e) { /* best-effort */ }
  }
}

module.exports = { syncTaskToRepo, relativeTaskPath, TASKS_DIRNAME };
