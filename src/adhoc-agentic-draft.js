'use strict';

// Agentic drafting for adhoc-domain tasks (Brain Dump #67: "formalize the workflow
// pattern [for processing Brain Dump entries]... entirely and predictably within the
// agent manager app itself"). Ornith has no tool-calling path at all (confirmed while
// building the Discuss harness-search feature, 2026-08-17) -- only Claude Code CLI mode
// can actually investigate a real repo, implement a real fix, and run real tests before
// finishing, the way a human session (this one, all of today) has been doing by hand
// outside the app entirely. This module is what ornith-draft.js's draftTask() calls
// instead of the generic blind-JSON-diff implement pass for every task.domain === 'adhoc'
// task ("Process now" queues one of these, regardless of task.source -- see
// task-source-registry.js's resolveSourceName()).
//
// Runs the agentic call against an ISOLATED `git worktree`, never the shared apply-target
// working tree apply-task.js operates on -- git-runner.js's own resetToMain() already
// auto-stashes specifically because "this repo is sometimes edited live in the same
// working tree the pipeline operates on" (two real incidents document what happens
// otherwise: docs/pipeline-incident-2026-07-19.md and its 2026-07-21 repeat). Drafting and
// applying are separate pipeline stages/processes; letting Claude edit the SAME directory
// apply-task.js's fetchMain()/resetToMain() sequence later resets would either lose the
// draft's edits (reset runs before apply) or race a concurrently-drafting task against a
// concurrently-applying one. A worktree sidesteps this entirely -- only the resulting
// `git diff` (captured here, applied later via `git apply` against the real repo -- see
// apply-adhoc-diff.js) ever needs to survive past this function returning.

const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { getConfig } = require('./config.js');
const { detectDefaultBranch } = require('./git-runner.js');
const { call: defaultClaudeCall } = require('./claude-client.js');
const { recordCall: defaultRecordModelCall } = require('./model-stats-client.js');

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
const GIT_TIMEOUT_MS = 60_000;

// Real implement+test cycles run far longer than claude-client.js's normal 300s default
// (sized for a single text completion, not an agentic tool-use loop) -- generous enough
// for a real investigate/edit/test cycle, bounded so a stuck call doesn't hang a worker
// tick forever (dead-process-check.js's own zombie-restart threshold, 1200s, still
// applies on top of this as the outer bound).
const ADHOC_TIMEOUT_MS = Number(process.env.AGENT_MANAGER_ADHOC_TIMEOUT_MS) || 900_000;
const ADHOC_MAX_TURNS = Number(process.env.AGENT_MANAGER_ADHOC_MAX_TURNS) || 30;

const RESOLUTION_RE = /RESOLUTION:\s*(implemented|no-changes-needed)\b/i;

// Same "claude:<model>" label format model-provider.js's labelFor()/ornith-worker.sh's
// HEARTBEAT_MODEL use -- stamped onto task.draftModel below so apply-task.js's commit
// message can attribute Co-Authored-By to whichever model actually drafted the change,
// instead of always crediting Ornith (this path never calls Ornith at all).
const DRAFT_MODEL_LABEL = `claude:${process.env.CLAUDE_MODEL || 'sonnet'}`;

function buildAgenticPrompt(task) {
  const ctx = task.promptContext || {};
  return [
    'You are implementing a real fix for a task submitted directly by a human, working ' +
    'inside a real git checkout of this repository on a fresh throwaway branch. You have ' +
    'real Read/Grep/Glob/Edit/Write/Bash tool access to this checkout -- use it.',
    '',
    `Title: ${task.title || ''}`,
    '',
    ctx.rawText || '',
    '',
    'First, investigate whether this is ALREADY resolved: check git log (e.g. `git log ' +
    '--oneline --all | grep ...`) and the current code for evidence the described ' +
    'problem or idea was already addressed by an earlier commit. If it clearly already ' +
    'is, make no code changes -- explain why in your final summary instead.',
    '',
    'If it is NOT already resolved and is a concrete, scoped, real change you can make ' +
    'confidently: implement it. Read whatever real files you need first -- do not guess ' +
    'at code you have not actually looked at. Run the real test suite relevant to what ' +
    'you changed (e.g. `npm test`, `python3 -m py_compile <changed .py files>`) before ' +
    'finishing, and fix any failures your own change introduced. If the task is too ' +
    'vague, too large, or requires a product/design decision only a human should make, ' +
    'do not guess -- explain why in your final summary instead of making a large, ' +
    'unrequested judgment call.',
    '',
    'When you are completely done, end your FINAL message with exactly one of these two ' +
    'lines (nothing after it on that line):',
    'RESOLUTION: implemented',
    'RESOLUTION: no-changes-needed',
    '',
    'followed by a short (2-4 sentence) plain-English summary of what you did, or why ' +
    'nothing was needed -- this is what a human reads to decide whether to apply your ' +
    'change.',
  ].join('\n');
}

function runGit(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV, timeout: GIT_TIMEOUT_MS });
}

/**
 * Drafts task.implementResponse/task.rawDiff for an adhoc-domain task via a real agentic
 * Claude Code CLI call against an isolated git worktree -- see this file's own header.
 * Mutates `task` in place (implementResponse, rawDiff, adhocResolution) on success. Never
 * touches the shared apply-target working tree.
 * @returns {Promise<{succeeded: boolean, blocked?: boolean, blockedReason?: string, reason?: string}>}
 */
async function draftAdhocImplement(task, { claudeCall = defaultClaudeCall, recordModelCall = defaultRecordModelCall, repoRoot } = {}) {
  const resolvedRepoRoot = repoRoot || getConfig().repoRoot;
  const mainBranch = detectDefaultBranch(resolvedRepoRoot);
  const worktreeDir = path.join(os.tmpdir(), `agent-manager-adhoc-worktree-${task.id}`);
  const branchName = `throwaway/adhoc-${task.id}`;

  try {
    runGit(['fetch', 'origin', mainBranch], resolvedRepoRoot);
  } catch (e) {
    return { succeeded: false, reason: `could not fetch origin/${mainBranch} before starting adhoc worktree: ${e.message}` };
  }

  try {
    runGit(['worktree', 'add', worktreeDir, '-b', branchName, `origin/${mainBranch}`], resolvedRepoRoot);
  } catch (e) {
    return { succeeded: false, reason: `could not create adhoc scratch worktree: ${e.message}` };
  }

  try {
    const prompt = buildAgenticPrompt(task);
    let totalCostUsd = 0;
    let attemptTurns = ADHOC_MAX_TURNS;
    let retriedForTurnBudget = false;
    let result;

    for (let attempt = 0; attempt < 2; attempt++) {
      const startedAt = new Date().toISOString();
      const startMs = Date.now();
      result = await claudeCall({
        prompt,
        cwd: worktreeDir,
        allowedTools: 'Read,Grep,Glob,Edit,Write,Bash',
        maxTurns: attemptTurns,
        permissionMode: 'dontAsk',
        timeoutMs: ADHOC_TIMEOUT_MS,
      });
      totalCostUsd += result.costUsd || 0;

      task.abCallId = recordModelCall({
        taskId: task.id,
        model: DRAFT_MODEL_LABEL,
        startedAt,
        latencyMs: Date.now() - startMs,
        result,
      });
      task.draftModel = DRAFT_MODEL_LABEL;

      // 2026-08-23, Grimmethy: "Fix: Claude agentic adhoc drafts that exhaust their turn
      // budget get blindly retried at the same budget, wasting real spend" -- caught
      // live: a task's OWN outer retry (reject-retry-check.js requeuing a blocked task)
      // just re-ran this exact function from scratch at the exact same ADHOC_MAX_TURNS,
      // burning a full ~31-turn session again with no reason to expect a different
      // outcome. stop_reason:'tool_use' with no RESOLUTION line is Claude Code CLI's own
      // signal that it was still mid-investigation/edit when the turn budget ran out --
      // NOT a degenerate/malformed response (claude-client.js's call() already retries
      // those on its own) and not a case where the task is unfixable, just under-budgeted
      // for THIS attempt. Retried here, inside the SAME worktree (any partial edits
      // Claude already made carry over rather than being thrown away) with a bumped
      // budget, but only ONCE -- a task that exhausts twice in a row is a genuine size/
      // scope problem a bigger number won't fix, and this must never become an unbounded
      // doubling loop.
      const ranOutOfTurns = result.stopReason === 'tool_use' && !RESOLUTION_RE.test(result.response || '');
      if (!ranOutOfTurns || attempt === 1) break;
      retriedForTurnBudget = true;
      attemptTurns = Math.round(ADHOC_MAX_TURNS * 1.5);
    }

    if (result.degenerate) {
      return { succeeded: true, blocked: true, blockedReason: `Adhoc agentic implement pass degenerate: ${result.degenerate} (total_cost_usd=${totalCostUsd.toFixed(4)}${retriedForTurnBudget ? ', retried once at a larger turn budget' : ''})` };
    }

    const summary = result.response || '';
    const resolutionMatch = summary.match(RESOLUTION_RE);
    const resolution = resolutionMatch ? resolutionMatch[1].toLowerCase() : null;

    if (!resolution) {
      // Claude didn't follow the required sentinel format -- treat as a degenerate
      // response rather than silently guessing which outcome was intended (same "fail
      // loud, don't guess" reasoning as this pipeline's other deterministic gates).
      const budgetNote = retriedForTurnBudget
        ? ` (ran out of turns twice in a row -- retried once already at ${attemptTurns}, a larger budget alone will not fix this; total_cost_usd=${totalCostUsd.toFixed(4)})`
        : ` (total_cost_usd=${totalCostUsd.toFixed(4)})`;
      return { succeeded: true, blocked: true, blockedReason: `Adhoc agentic implement pass did not end with a RESOLUTION: line -- cannot determine outcome${budgetNote}` };
    }

    let rawDiff = '';
    try {
      // `git diff` alone only ever shows already-TRACKED files' changes -- a brand new
      // file Claude created via Write never appears in it at all until staged. `add -A`
      // first (stages new/modified/deleted alike), then `diff --cached`, so a new file
      // is captured exactly the same way a modified one already was.
      runGit(['add', '-A'], worktreeDir);
      rawDiff = runGit(['diff', '--cached'], worktreeDir);
    } catch (e) {
      return { succeeded: false, reason: `could not capture git diff from adhoc worktree: ${e.message}` };
    }

    // A mismatch between what Claude claimed (resolution) and what actually happened
    // (rawDiff) is handled entirely by apply-adhoc-diff.js downstream just by checking
    // rawDiff's own content -- deliberately no special-casing here: a real diff always
    // goes through normal human-gated review+apply regardless of what `resolution` said,
    // and an empty diff always skips apply regardless of what `resolution` said. Kept as
    // its own field purely so a human reviewing the task can see Claude's own claim.
    task.adhocResolution = resolution;
    task.rawDiff = rawDiff.trim();
    task.implementResponse = task.rawDiff
      ? `${summary}\n\n=== DIFF ===\n${task.rawDiff}`
      : summary;

    return { succeeded: true, blocked: false };
  } catch (e) {
    return { succeeded: false, reason: e.message };
  } finally {
    // Best-effort cleanup regardless of outcome -- a worker SIGKILL'd mid-call (dead-
    // process-check.js's zombie-restart) skips this finally entirely, stranding an
    // isolated scratch worktree in os.tmpdir(); harmless (never touches the real repo),
    // just needs occasional manual/cron cleanup -- not a correctness or safety issue.
    try { runGit(['worktree', 'remove', '--force', worktreeDir], resolvedRepoRoot); } catch (e) { /* best-effort */ }
    try { runGit(['branch', '-D', branchName], resolvedRepoRoot); } catch (e) { /* best-effort */ }
  }
}

module.exports = { draftAdhocImplement, buildAgenticPrompt };
