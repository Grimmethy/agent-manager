'use strict';

// Provider-agnostic helpers for an agentic implement pass (isolated git worktree,
// RESOLUTION: sentinel parsing, decompose / needs-human-decision handling, diff capture).
// Extracted 2026-09-01 from the (now-deleted) Claude-only adhoc-agentic-draft.js so the
// local write-agentic tier (local-agentic-write-draft.js) and any future agentic drafter
// share ONE copy -- the drafting model is the only thing that differs, none of this is
// Claude-specific. Runs against an ISOLATED `git worktree`, never the shared apply-target
// tree: only the resulting `git diff` needs to survive past the call (see
// docs/pipeline-incident-2026-07-19.md for what editing the live tree causes).

const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { getConfig } = require('./config.js');
const { detectDefaultBranch } = require('./git-runner.js');

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
const GIT_TIMEOUT_MS = 60_000;

function runGit(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV, timeout: GIT_TIMEOUT_MS });
}

// Renders the prior-review-rejection block for an implement prompt, if any.
function priorRejectionBlock(task) {
  const feedback = Array.isArray(task.priorRejectionFeedback) ? task.priorRejectionFeedback : [];
  if (feedback.length === 0) return '';
  return [
    `PRIOR REVIEW REJECTIONS -- this task has been attempted ${feedback.length} time(s) and rejected each time. Address each one; do NOT just restate the same conclusion:`,
    ...feedback.map((r, i) => `  ${i + 1}. ${r}`),
    '',
  ].join('\n');
}

// The RESOLUTION verbs an agentic implement pass may end with. `implemented` +
// `no-changes-needed` produce a reviewable outcome; `decompose` yields a sub-task list;
// `needs-human-decision` routes straight to queue/needs-clarification/.
const RESOLUTION_RE = /RESOLUTION:\s*(implemented|no-changes-needed|decompose|needs-human-decision)\b/i;

// A RESOLUTION: decompose response is expected to be followed by a JSON array of 2+
// {title, rawText} sub-tasks. Deliberately permissive -- pulls the first bracketed JSON
// array found anywhere after the RESOLUTION line and drops malformed entries rather than
// failing the whole batch.
function parseSubTaskProposals(text) {
  const match = (text || '').match(/\[[\s\S]*\]/);
  if (!match) return null;
  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const cleaned = parsed
    .filter((t) => t && typeof t.title === 'string' && t.title.trim() && typeof t.rawText === 'string' && t.rawText.trim())
    .map((t) => ({ title: t.title.trim(), rawText: t.rawText.trim() }));
  return cleaned.length ? cleaned : null;
}

// Optional multiple-choice shortcut for a needs-human-decision resolution: an `OPTIONS:`
// header followed by `N. label :: description` lines. Best-effort -- requires 2+
// well-formed lines, otherwise the plain-English open question is the only surface.
const OPTIONS_LINE_RE = /^\s*\d+\.\s*(.+?)\s*::\s*(.+?)\s*$/;
function parseClarificationOptions(text) {
  const lines = (text || '').split('\n');
  const headerIdx = lines.findIndex((l) => /^OPTIONS:\s*$/.test(l));
  if (headerIdx === -1) return null;
  const options = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) { if (options.length) break; else continue; }
    const m = line.match(OPTIONS_LINE_RE);
    if (!m) break;
    const label = m[1].trim();
    const description = m[2].trim();
    if (label && description) options.push({ label, description });
  }
  return options.length >= 2 ? options : null;
}

// Resolves the standard worktree/branch names for one agentic draft. Both are
// deterministic, derived only from task.id, so anything found at these paths on a retry
// can only be OUR OWN stale leftover from an interrupted prior attempt.
function agenticWorktreePaths(taskId) {
  return {
    worktreeDir: path.join(os.tmpdir(), `agent-manager-adhoc-worktree-${taskId}`),
    branchName: `throwaway/adhoc-${taskId}`,
  };
}

// Creates the isolated scratch worktree: fetch the base branch, force-clear any stale
// leftover from a prior interrupted attempt at this SAME task.id, then `git worktree add`
// fresh. Returns { ok: true } or { ok: false, reason }. See adhoc-agentic-draft.js's own
// original comments (2026-08-25 incidents) for why the pre-cleanup is unconditional and
// why `fs.rmSync` is needed on top of `git worktree remove`.
function prepareAdhocWorktree(resolvedRepoRoot, mainBranch, worktreeDir, branchName) {
  try {
    runGit(['fetch', 'origin', mainBranch], resolvedRepoRoot);
  } catch (e) {
    return { ok: false, reason: `could not fetch origin/${mainBranch} before starting adhoc worktree: ${e.message}` };
  }

  try { runGit(['worktree', 'remove', '--force', worktreeDir], resolvedRepoRoot); } catch (e) { /* no stale worktree registered */ }
  try { fs.rmSync(worktreeDir, { recursive: true, force: true }); } catch (e) { /* nothing left to remove */ }
  try { runGit(['branch', '-D', branchName], resolvedRepoRoot); } catch (e) { /* no stale branch */ }

  try {
    runGit(['worktree', 'add', worktreeDir, '-b', branchName, `origin/${mainBranch}`], resolvedRepoRoot);
  } catch (e) {
    return { ok: false, reason: `could not create adhoc scratch worktree: ${e.message}` };
  }
  return { ok: true };
}

function cleanupAdhocWorktree(resolvedRepoRoot, worktreeDir, branchName) {
  try { runGit(['worktree', 'remove', '--force', worktreeDir], resolvedRepoRoot); } catch (e) { /* best-effort */ }
  try { runGit(['branch', '-D', branchName], resolvedRepoRoot); } catch (e) { /* best-effort */ }
}

// Convenience: prepare -> run -> resolve -> cleanup for one agentic draft. `runInWorktree`
// is `(worktreeDir) => Promise<{ response, degenerate?, ... }>` -- the model call, already
// pointed at the worktree. Returns the same shape resolveAgenticDraft does (or
// { succeeded:false, reason } for a worktree-setup failure).
async function runAgenticDraftInWorktree(task, { runInWorktree, modelLabel, repoRoot, retriedForTurnBudget = false } = {}) {
  const resolvedRepoRoot = repoRoot || getConfig().repoRoot;
  const mainBranch = detectDefaultBranch(resolvedRepoRoot);
  const { worktreeDir, branchName } = agenticWorktreePaths(task.id);

  const prep = prepareAdhocWorktree(resolvedRepoRoot, mainBranch, worktreeDir, branchName);
  if (!prep.ok) return { succeeded: false, reason: prep.reason };

  try {
    const result = await runInWorktree(worktreeDir);
    return resolveAgenticDraft(task, { result, worktreeDir, modelLabel, retriedForTurnBudget });
  } finally {
    cleanupAdhocWorktree(resolvedRepoRoot, worktreeDir, branchName);
  }
}

// Maps a finished agentic result onto `task` (implementResponse, rawDiff, adhocResolution,
// subTaskProposals, needsClarification) and returns a draftTask-shaped verdict. Provider-
// neutral: reads only `result.response` / `result.degenerate` and stages the worktree's
// diff. `retriedForTurnBudget` only tunes the "did not end with RESOLUTION" note.
function resolveAgenticDraft(task, { result, worktreeDir, modelLabel, retriedForTurnBudget = false }) {
  if (result && result.degenerate) {
    return { succeeded: true, blocked: true, blockedReason: `Agentic implement pass degenerate: ${result.degenerate}${retriedForTurnBudget ? ' (retried once at a larger turn budget)' : ''}` };
  }

  const summary = (result && result.response) || '';
  const resolutionMatch = summary.match(RESOLUTION_RE);
  const resolution = resolutionMatch ? resolutionMatch[1].toLowerCase() : null;
  if (modelLabel) task.draftModel = modelLabel;

  if (!resolution) {
    const budgetNote = retriedForTurnBudget
      ? ' -- ran out of turns twice in a row; a larger budget alone will not fix this'
      : '';
    return { succeeded: true, blocked: true, blockedReason: `Agentic implement pass did not end with a RESOLUTION: line -- cannot determine outcome${budgetNote}` };
  }

  if (resolution === 'decompose') {
    const afterResolution = summary.slice(resolutionMatch.index + resolutionMatch[0].length);
    const subTasks = parseSubTaskProposals(afterResolution);
    if (!subTasks || subTasks.length < 2) {
      return { succeeded: true, blocked: true, blockedReason: 'Agentic implement pass said RESOLUTION: decompose but did not follow it with a valid JSON array of at least 2 {title, rawText} sub-tasks' };
    }
    task.adhocResolution = resolution;
    task.subTaskProposals = subTasks;
    task.rawDiff = '';
    task.implementResponse = summary;
    return { succeeded: true, blocked: false };
  }

  if (resolution === 'needs-human-decision') {
    task.adhocResolution = resolution;
    task.rawDiff = '';
    task.implementResponse = summary;
    return { succeeded: true, blocked: false, needsClarification: true };
  }

  // implemented | no-changes-needed -- capture whatever actually landed in the worktree.
  let rawDiff = '';
  try {
    runGit(['add', '-A'], worktreeDir);
    rawDiff = runGit(['diff', '--cached'], worktreeDir);
  } catch (e) {
    return { succeeded: false, reason: `could not capture git diff from the worktree: ${e.message}` };
  }

  task.adhocResolution = resolution;
  task.rawDiff = rawDiff.trim();
  task.implementResponse = task.rawDiff
    ? `${summary}\n\n=== DIFF ===\n${task.rawDiff}`
    : summary;
  return { succeeded: true, blocked: false };
}

module.exports = {
  GIT_ENV, GIT_TIMEOUT_MS, runGit, priorRejectionBlock,
  RESOLUTION_RE, parseSubTaskProposals, parseClarificationOptions,
  agenticWorktreePaths, prepareAdhocWorktree, cleanupAdhocWorktree,
  runAgenticDraftInWorktree, resolveAgenticDraft,
};
