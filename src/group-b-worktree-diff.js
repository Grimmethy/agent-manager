'use strict';

// Shared helper: apply a Group-B JSON diff (create/edit/delete, same format apply-group-b.js
// already safely applies for observability_fix/arch_import/etc.) against an ISOLATED git
// worktree -- never the shared apply-target working tree apply-task.js operates on, same
// isolation reasoning adhoc-agentic-draft.js's own worktree already documents (two real
// incidents, docs/pipeline-incident-2026-07-19.md and its 2026-07-21 repeat, from editing
// a working tree the pipeline also operates on live) -- then captures the result as a real
// unified diff, the exact shape applyAdhocDiff (apply-adhoc-diff.js) already knows how to
// land on the real repo via `git apply`.
//
// Reuses apply-group-b.js's own applyOneChange/rollback logic completely unmodified (it
// already accepts an arbitrary repoRoot -- see its own signature) rather than a second,
// possibly-inconsistent file-mutation path. This is what lets a LOCAL model produce a real
// git diff despite never getting direct git/Bash access itself: it only ever proposes a
// Group-B JSON change; this module is what actually mutates a (throwaway, isolated) file
// tree and turns that into a diff.
//
// Built 2026-08-22 (Grimmethy: "expand the tooling capabilities so that the local
// reasoning model can handle the work") for two callers that both need exactly this:
// adhoc-harness-draft.js's harness-search-first tier and local-agentic-draft.js's
// multi-turn tool-calling tier.

const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { detectDefaultBranch } = require('./git-runner.js');
const { applyGroupB } = require('./apply-group-b.js');

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
const GIT_TIMEOUT_MS = 60_000;

function runGit(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV, timeout: GIT_TIMEOUT_MS });
}

/**
 * Applies a Group-B implementResponse against a throwaway worktree branched off
 * origin/<default branch>, captures the result as a real `git diff`, and always tears the
 * worktree back down again -- success or failure.
 *
 * Throws on ANY failure (fetch, worktree create, invalid/inapplicable Group-B JSON, diff
 * capture) -- callers should treat a throw as "this attempt couldn't produce a change,"
 * the same non-fatal, try-the-next-tier meaning adhoc-agentic-draft.js's own try/catch
 * already gives a failed Claude call, not a hard pipeline error.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot - The REAL repo (never written to directly).
 * @param {string} opts.pipelineDir - Passed through to applyGroupB (delete-mode kill switch).
 * @param {string} opts.implementResponse - Group-B JSON (single object or array).
 * @param {string} opts.worktreeSuffix - Unique per-call suffix (e.g. task.id) so concurrent
 *   callers never collide on the same worktree directory/branch name.
 * @returns {string} The captured unified diff, trimmed (may be empty if Group-B produced
 *   no net change against origin, e.g. an edit whose replace equals its find).
 */
function captureGroupBDiffInWorktree({ repoRoot, pipelineDir, implementResponse, worktreeSuffix }) {
  const mainBranch = detectDefaultBranch(repoRoot);
  const worktreeDir = path.join(os.tmpdir(), `agent-manager-groupb-worktree-${worktreeSuffix}`);
  const branchName = `throwaway/groupb-${worktreeSuffix}`;

  runGit(['fetch', 'origin', mainBranch], repoRoot);
  runGit(['worktree', 'add', worktreeDir, '-b', branchName, `origin/${mainBranch}`], repoRoot);

  try {
    applyGroupB({ implementResponse, repoRoot: worktreeDir, pipelineDir });
    runGit(['add', '-A'], worktreeDir);
    const rawDiff = runGit(['diff', '--cached'], worktreeDir);
    return rawDiff.trim();
  } finally {
    // Best-effort cleanup regardless of outcome -- same reasoning adhoc-agentic-draft.js's
    // own finally block documents (a SIGKILL'd worker skips this, stranding a harmless
    // scratch worktree; not a correctness issue, just occasional manual/cron cleanup).
    try { runGit(['worktree', 'remove', '--force', worktreeDir], repoRoot); } catch (e) { /* best-effort */ }
    try { runGit(['branch', '-D', branchName], repoRoot); } catch (e) { /* best-effort */ }
  }
}

module.exports = { captureGroupBDiffInWorktree };
