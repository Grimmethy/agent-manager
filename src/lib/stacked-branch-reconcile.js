'use strict';

// Preparing the stacked branch is the reconcile trigger, per ADR-0024 (triggers, not polls).
// This module is only called from that trigger. It has no timers, no polling loop, no model
// calls, and it does not require the local model client module. It never runs history-writing git
// commands: it only reads refs and applies diffs to working trees.

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };

// Same shape as runGit(args, cwd) in src/agentic-draft-common.js: utf8 stdout, throws on failure.
function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
}

function capture(cmd, e) {
  return {
    cmd,
    stdout: String((e && e.stdout) || ''),
    stderr: String((e && e.stderr) || ''),
    message: String((e && e.message) || e),
  };
}

function writeTempPatch(patch) {
  const file = path.join(os.tmpdir(), `stacked-reconcile-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.patch`);
  fs.writeFileSync(file, patch.endsWith('\n') ? patch : `${patch}\n`);
  return file;
}

function removeQuietly(file) {
  try { fs.unlinkSync(file); } catch { /* best-effort */ }
}

// Commits on `branch` whose patch is not yet in `master`, per `git cherry`. Returns the shas
// marked '+' (not yet applied upstream), oldest first, in the order git prints them.
function unmergedCommits(repoRoot, master, branch) {
  const out = git(['cherry', master, branch], repoRoot);
  return out
    .split('\n')
    .filter((line) => line.startsWith('+'))
    .map((line) => line.slice(1).trim().split(/\s+/)[0])
    .filter(Boolean);
}

// True when the commit's change is already present in the master worktree. A reverse-apply
// check succeeds only if the patch is currently applied, which is what happens when a
// squash-landed commit already carries the same change. Any other failure is rethrown.
function alreadyInMaster(masterWorktree, sha) {
  const patch = git(['show', '--format=', '--binary', sha], masterWorktree);
  const file = writeTempPatch(patch);
  try {
    git(['apply', '--reverse', '--check', file], masterWorktree);
    return true;
  } catch (e) {
    const text = `${(e && e.stderr) || ''}${(e && e.stdout) || ''}${(e && e.message) || ''}`;
    if (/does not apply|patch failed/.test(text)) return false;
    throw e;
  } finally {
    removeQuietly(file);
  }
}

// One bounded pass, no retries. Creates a detached scratch worktree at current master, then
// applies each unmerged commit's diff in order. Stops at the first failure and reports it.
// The scratch worktree is NOT removed here; the caller owns its cleanup.
// Returns { ok, conflicts, outputs }. `conflicts` lists the sha that failed to apply, and
// `outputs` holds the full stdout and stderr of each failed command.
function rebuildFromMaster(repoRoot, master, branch, scratchDir) {
  const conflicts = [];
  const outputs = [];

  try {
    git(['worktree', 'add', '--detach', scratchDir, master], repoRoot);
  } catch (e) {
    outputs.push(capture('git worktree add', e));
    return { ok: false, conflicts, outputs };
  }

  let shas;
  try {
    shas = unmergedCommits(repoRoot, master, branch);
  } catch (e) {
    outputs.push(capture('git cherry', e));
    return { ok: false, conflicts, outputs };
  }

  for (const sha of shas) {
    let file = null;
    try {
      const patch = git(['show', '--format=', '--binary', sha], repoRoot);
      file = writeTempPatch(patch);
      git(['apply', '--whitespace=nowarn', '--binary', file], scratchDir);
    } catch (e) {
      conflicts.push(sha);
      outputs.push(capture(`git apply (${sha})`, e));
      return { ok: false, conflicts, outputs };
    } finally {
      if (file) removeQuietly(file);
    }
  }

  return { ok: true, conflicts, outputs };
}

module.exports = { unmergedCommits, alreadyInMaster, rebuildFromMaster };
