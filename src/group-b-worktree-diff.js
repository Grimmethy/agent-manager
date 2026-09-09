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
const { resolveGroundingRef } = require('./stacked-grounding.js');

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
const GIT_TIMEOUT_MS = 60_000;

function runGit(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV, timeout: GIT_TIMEOUT_MS });
}

// 2026-09-08, root-caused live (autodecomp-...-04-system-and-project-js, applied via
// tryDeterministicScriptExtractEdit which reuses this exact capture path): `.trim()`
// strips a valid `git diff --cached` output's ESSENTIAL trailing newline along with any
// leading/trailing whitespace, silently corrupting the last hunk of a large multi-symbol
// move -- confirmed directly: `git apply --check` on the stored rawDiff failed with
// "corrupt patch at line N", and the raw text's very last byte was the last hunk's final
// content line with no trailing `\n`, one line short of that hunk's own declared old-line
// count. A unified diff must end with exactly one trailing newline (or `git` emits an
// explicit "\ No newline at end of file" marker when the underlying file genuinely lacks
// one, which `git diff` itself already handles correctly -- this bug was introduced only
// by re-trimming its already-correct output afterward). Strips incidental leading/
// trailing whitespace the same way `.trim()` did, but always restores exactly one
// trailing newline on a non-empty diff; an empty/whitespace-only diff (no net change --
// see this file's own docstring) still returns `''` unchanged.
function normalizeDiffOutput(rawDiff) {
  if (!rawDiff || !rawDiff.trim()) return '';
  return `${rawDiff.replace(/^\s+/, '').replace(/\s+$/, '')}\n`;
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
 * @param {object} [opts.task] - The task this diff is being captured for. 2026-09-09,
 *   root-caused live (file-decompose-hub-autodecomp-adhoc-add-job-stage-groups-...): this
 *   always branched off origin/<mainBranch> unconditionally, so a stacked file-decompose
 *   sub-task's deterministic script-extract diff got captured against MASTER's version of
 *   the source file, not the shared stacked branch's -- which already has earlier sibling
 *   moves extracted from it, at different line offsets. The diff verified/applied cleanly
 *   in isolation but failed `git apply` for real once actually applied to the real stacked
 *   branch ("patch does not apply"). Same missing concept already fixed at 5 other call
 *   sites by stacked-grounding.js's resolveGroundingRef -- this is call site #6. Null for
 *   any non-stacked task, so every existing (non-stacked) caller is unaffected.
 * @returns {string} The captured unified diff, trimmed (may be empty if Group-B produced
 *   no net change against origin, e.g. an edit whose replace equals its find).
 */
function captureGroupBDiffInWorktree({ repoRoot, pipelineDir, implementResponse, worktreeSuffix, task }) {
  const mainBranch = detectDefaultBranch(repoRoot);
  const groundingBranch = (task && resolveGroundingRef(task, repoRoot)) || mainBranch;
  const worktreeDir = path.join(os.tmpdir(), `agent-manager-groupb-worktree-${worktreeSuffix}`);
  const branchName = `throwaway/groupb-${worktreeSuffix}`;

  runGit(['fetch', 'origin', groundingBranch], repoRoot);
  runGit(['worktree', 'add', worktreeDir, '-b', branchName, `origin/${groundingBranch}`], repoRoot);

  try {
    applyGroupB({ implementResponse, repoRoot: worktreeDir, pipelineDir });
    runGit(['add', '-A'], worktreeDir);
    const rawDiff = runGit(['diff', '--cached'], worktreeDir);
    return normalizeDiffOutput(rawDiff);
  } finally {
    // Best-effort cleanup regardless of outcome -- same reasoning adhoc-agentic-draft.js's
    // own finally block documents (a SIGKILL'd worker skips this, stranding a harmless
    // scratch worktree; not a correctness issue, just occasional manual/cron cleanup).
    try { runGit(['worktree', 'remove', '--force', worktreeDir], repoRoot); } catch (e) { /* best-effort */ }
    try { runGit(['branch', '-D', branchName], repoRoot); } catch (e) { /* best-effort */ }
  }
}

module.exports = { captureGroupBDiffInWorktree, normalizeDiffOutput };
