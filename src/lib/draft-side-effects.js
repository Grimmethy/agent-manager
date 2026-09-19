'use strict';

// Side-effect files must never ride along in a draft's diff.
//
// Incident (PF-Client-Portal, 2026-09-19): to typecheck a one-file fix the agent ran `npm install` in its
// worktree. The sandbox's older npm rewrote package-lock.json (stripped the `libc` field from 27 native
// packages), the harness captured `git add -A && git diff --cached`, and the lockfile change was committed
// to the agent/ branch. The task never mentioned dependencies, the draft's own summary never mentioned the
// lockfile, and two of three review votes approved without noticing the 81-line unrelated hunk.
//
// Two mechanisms:
//   1. stageDraftChanges(): stage everything, then UNSTAGE side-effect paths (lockfiles, node_modules,
//      Python bytecode) unless the task is itself about dependencies. Applied at every place a draft's
//      diff is captured, so the harness commits only what the draft was meant to change.
//   2. unnamedChangedFiles(): deterministic scope check for review -- changed files that neither the task,
//      the plan, nor the draft's own summary mention. Surfaced to the voters as a scope note.

const path = require('path');

const SIDE_EFFECT_PATH_RE = new RegExp([
  String.raw`(?:^|/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Pipfile\.lock|poetry\.lock|Cargo\.lock|composer\.lock|Gemfile\.lock)$`,
  String.raw`(?:^|/)node_modules/`,
  String.raw`(?:^|/)__pycache__/`,
  String.raw`\.py[co]$`,
].join('|'));

// A task that is genuinely about dependencies legitimately edits the lockfile.
const DEPENDENCY_INTENT_RE = /\b(?:package(?:-lock)?\.json|lock ?file|dependenc(?:y|ies)|npm (?:install|i|update|upgrade|add|remove|uninstall)|yarn (?:add|upgrade|remove)|pnpm (?:add|update|remove)|pip install|requirements\.txt|pyproject|cargo (?:add|update)|bump|upgrade)\b/i;

function taskWantsDependencyChange(task) {
  const pc = (task && task.promptContext) || {};
  return DEPENDENCY_INTENT_RE.test(`${(task && task.title) || ''}\n${pc.rawText || ''}`);
}

// runGit(args, cwd) -> stdout, the same helper the capture sites already use.
// Returns { excluded: [paths] }. Never throws for the unstage step: a failure to unstage one path must not
// lose the whole diff, so it is skipped and reported by omission.
function stageDraftChanges({ worktreeDir, runGit, task }) {
  runGit(['add', '-A'], worktreeDir);
  if (taskWantsDependencyChange(task)) return { excluded: [] };
  let staged = [];
  try {
    staged = String(runGit(['diff', '--cached', '--name-only', '-z'], worktreeDir)).split('\0').filter(Boolean);
  } catch {
    return { excluded: [] };
  }
  const excluded = [];
  for (const p of staged) {
    if (!SIDE_EFFECT_PATH_RE.test(p)) continue;
    try {
      runGit(['reset', '-q', 'HEAD', '--', p], worktreeDir);
      excluded.push(p);
    } catch { /* leave it staged rather than fail the capture */ }
  }
  return { excluded };
}

function changedFilesOfDiff(rawDiff) {
  const files = [];
  for (const m of String(rawDiff || '').matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) files.push(m[2]);
  return [...new Set(files)];
}

// Files the diff changes that NOTHING in the task, plan or draft summary mentions (by full path or basename).
function unnamedChangedFiles(task) {
  if (!task || !task.rawDiff) return [];
  const pc = task.promptContext || {};
  const blob = [
    task.title, pc.rawText, task.planResponse, task.lastGoodPlan, task.implementResponse,
    Array.isArray(pc.prefetchedPaths) ? pc.prefetchedPaths.join('\n') : '',
  ].filter(Boolean).join('\n');
  return changedFilesOfDiff(task.rawDiff).filter((f) => !blob.includes(f) && !blob.includes(path.basename(f)));
}

module.exports = { SIDE_EFFECT_PATH_RE, taskWantsDependencyChange, stageDraftChanges, changedFilesOfDiff, unnamedChangedFiles };
