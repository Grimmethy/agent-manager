'use strict';

// Agentic drafting for adhoc-domain tasks (Brain Dump #67: "formalize the workflow
// pattern [for processing Brain Dump entries]... entirely and predictably within the
// agent manager app itself"). Ornith has no tool-calling path at all (confirmed while
// building the Discuss harness-search feature, 2026-08-17) -- only Claude Code CLI mode
// can actually investigate a real repo, implement a real fix, and run real tests before
// finishing, the way a human session (this one, all of today) has been doing by hand
// outside the app entirely. This module is what local-draft.js's draftTask() calls
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
const fs = require('fs');
const { execFileSync } = require('child_process');
const { getConfig } = require('./config.js');
const { detectDefaultBranch } = require('./git-runner.js');
const { call: defaultClaudeCall } = require('./claude-client.js');
const { recordCall: defaultRecordModelCall } = require('./model-stats-client.js');

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
const GIT_TIMEOUT_MS = 60_000;

// AGENT_MANAGER_ADHOC_SANDBOX (2026-08-24, sandbox.js): '0' opts out, defaults ON -- same
// env-var-with-sane-default convention as ADHOC_MAX_TURNS above. An explicit escape hatch
// for a host where bwrap causes real trouble, without needing a code change.
const SANDBOX_ENABLED = process.env.AGENT_MANAGER_ADHOC_SANDBOX !== '0';

// Resolves the Claude CLI's real binary location so the sandbox can bind exactly what's
// actually needed, not a hardcoded path -- this host happens to install it as a symlink
// (~/.local/bin/claude) to a self-contained single-file binary under
// ~/.local/share/claude/versions/<N>, but that's this host's own layout, not guaranteed.
// Binds BOTH the symlink's own directory (so PATH-based resolution still works inside the
// sandbox) and the resolved target's directory (the actual binary, wherever it lives).
// Returns null (sandbox opts stay minimal, not broken) if `which`/realpath fails for any
// reason -- same fail-open reasoning as the rest of this sandboxing pass.
function resolveClaudeBinDirs() {
  try {
    const bin = process.env.CLAUDE_CLI_BIN || 'claude';
    const which = execFileSync('which', [bin], { encoding: 'utf8' }).trim();
    const real = fs.realpathSync(which);
    return [...new Set([path.dirname(which), path.dirname(real)])];
  } catch (e) {
    return [];
  }
}

function buildSandboxOpts(resolvedRepoRoot, worktreeDir) {
  // Regression, 2026-08-24 (found live: an adhoc draft's own summary noted "git log isn't
  // usable in this worktree... gitdir path doesn't exist in this sandbox," confirmed via
  // direct reproduction) -- git canonicalizes the `gitdir:` pointer a worktree's own .git
  // FILE contains to the real, symlink-resolved path, not whatever path string repoRoot
  // happened to be passed in as. This deployment's own AGENT_MANAGER_REPO_ROOT
  // (/media/wok/model-cache/agent-manager-apply-target) is itself a symlink to
  // /media/model-cache/github/agent-manager-apply-target -- binding the SYMLINK path (what
  // this function used to do) left the REAL path git's own gitdir file actually points at
  // completely unbound, so every git command needing history (the prompt's own first
  // instruction: "check git log... for evidence the described problem was already
  // addressed") silently failed inside the sandbox, forcing every affected draft to fall
  // back to code-only inspection with no history grounding at all. realpathSync() both
  // paths before building any bind so this always binds where git ACTUALLY looks,
  // regardless of whether repoRoot (or worktreeDir, same class of risk) was reached via a
  // symlink or not.
  const realRepoRoot = fs.realpathSync(resolvedRepoRoot);
  const realWorktreeDir = fs.realpathSync(worktreeDir);
  const readOnlyBinds = [
    '/usr', '/bin', '/lib', '/lib64', '/etc/resolv.conf', '/etc/ssl',
    ...resolveClaudeBinDirs(),
    path.join(realRepoRoot, '.git'),
  ];
  const writableBinds = [
    realWorktreeDir,
    // The worktree's own thin git-dir (index/HEAD/logs -- see this module's header on
    // `git worktree`'s real on-disk layout) -- needs to be writable even though the rest
    // of <repoRoot>/.git above is read-only, so `git status`/local `git log` writes from
    // INSIDE the worktree (not the main repo) still work. Bound AFTER the read-only
    // <repoRoot>/.git bind above so it correctly overrides just this one subpath (see
    // sandbox.js's own comment on bind ordering). basename computed from the REAL
    // worktree path -- git names this directory after the worktree's own basename, and
    // that must match whichever path form git itself resolved when creating it.
    path.join(realRepoRoot, '.git', 'worktrees', path.basename(realWorktreeDir)),
  ];
  return {
    readOnlyBinds,
    writableBinds,
    // workDir passed to sandbox.js's own --chdir must be the SAME real path these binds
    // are built against -- chdir-ing into the original (possibly symlinked) worktreeDir
    // would land outside every bind just constructed above.
    workDir: realWorktreeDir,
    env: { CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN, PATH: process.env.PATH },
  };
}

// Real implement+test cycles run far longer than claude-client.js's normal 300s default
// (sized for a single text completion, not an agentic tool-use loop) -- generous enough
// for a real investigate/edit/test cycle, bounded so a stuck call doesn't hang a worker
// tick forever (dead-process-check.js's own zombie-restart threshold, 1200s, still
// applies on top of this as the outer bound).
const ADHOC_TIMEOUT_MS = Number(process.env.AGENT_MANAGER_ADHOC_TIMEOUT_MS) || 900_000;
const ADHOC_MAX_TURNS = Number(process.env.AGENT_MANAGER_ADHOC_MAX_TURNS) || 30;

const RESOLUTION_RE = /RESOLUTION:\s*(implemented|no-changes-needed|decompose|needs-human-decision)\b/i;

// Grimmethy, 2026-08-24: "we had discussed setting up a task that breaks down jobs that
// are too large" -- the actual task built for this (adhoc "Give agentic adhoc drafting a
// self-assessed decomposition path...") burned all 5 of its own draft retries hitting
// max_turns itself, too large a task for the very mechanism it was building. Implemented
// directly instead of leaving it stuck in that bootstrapping loop.
//
// A RESOLUTION: decompose response is expected to be followed by a JSON array of 2+
// {title, rawText} sub-tasks (see buildAgenticPrompt below for the exact instruction).
// Deliberately permissive parsing -- pulls out the first bracketed JSON array found
// anywhere after the RESOLUTION line (models don't reliably put pure JSON with nothing
// else around it, same reasoning apply-group-b.js's own JSON extraction already applies)
// and drops any entry missing a non-empty title/rawText rather than failing the whole
// batch over one malformed entry.
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

// Multiple-choice shortcut for a needs-human-decision resolution (Grimmethy, 2026-08-24:
// "we could build in some multiple choice options into the task log including an
// 'other:' option... reduce the friction caused by pausing the pipeline to set up a
// chat"). Deliberately optional and best-effort: a model that skips the OPTIONS block
// entirely, or gets the format slightly wrong, still has its plain-English open-question
// text preserved in full (see buildAgenticPrompt's own instruction above) -- this only
// ever ADDS a one-click shortcut in the dashboard, it never replaces the free-text
// fallback ("Other") every needs-clarification task still has regardless. Requires 2+
// well-formed lines to return anything -- a single stray "1. foo :: bar" isn't a real
// multiple-choice set, and returning just one option would make the human's Other-text
// fallback the ONLY other path, i.e. no real shortcut at all.
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

// Same "claude:<model>" label format model-provider.js's labelFor()/local-worker.sh's
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
    'finishing, and fix any failures your own change introduced.',
    '',
    'If the task is simply TOO LARGE to implement confidently in one pass (touches many ' +
    'files/subsystems, or you can tell you would run out of turns partway through), do ' +
    'NOT attempt a partial implementation and do NOT make any code changes. Instead split ' +
    'it into 2-6 smaller, independently-implementable pieces that together cover the ' +
    'original task -- each piece should be small enough for a single fresh session to ' +
    'finish on its own.',
    '',
    'If implementing genuinely requires a PRODUCT/DESIGN DECISION only a human should make ' +
    '(e.g. which library or approach to build on when none exists yet, what data to keep ' +
    'and for how long, which of several reasonable designs to pick) -- this is NOT the ' +
    'same as the task being too large (use the split above for that), and NOT the same as ' +
    'already being resolved (say so above if it is) -- do not guess at an answer and do ' +
    'not falsely claim nothing needs to change. Stop and say exactly what the real open ' +
    'question(s) are.',
    '',
    'When you are completely done, end your FINAL message with exactly one of these four ' +
    'lines (nothing after it on that line):',
    'RESOLUTION: implemented',
    'RESOLUTION: no-changes-needed',
    'RESOLUTION: decompose',
    'RESOLUTION: needs-human-decision',
    '',
    'If RESOLUTION: implemented or no-changes-needed -- follow with a short (2-4 sentence) ' +
    'plain-English summary of what you did, or why nothing was needed -- this is what a ' +
    'human reads to decide whether to apply your change.',
    '',
    'If RESOLUTION: decompose -- follow it immediately with a JSON array of the sub-tasks, ' +
    'in exactly this shape (a title and a full, self-contained description for each ' +
    'piece -- someone implementing just that one piece must not need to re-read the ' +
    'original task to understand it):',
    '[{"title": "short imperative title", "rawText": "a full, self-contained description of just this piece"}, ...]',
    'Then a short (1-3 sentence) explanation of why you split it this way.',
    '',
    'If RESOLUTION: needs-human-decision -- follow it with the specific open question(s), ' +
    'plainly stated, and enough real context (what you found investigating, what the ' +
    'actual tradeoffs are) for a human to answer them without having to re-investigate ' +
    'themselves. This goes straight to a human for a real answer, not through automatic ' +
    'review -- make it something they can actually act on.',
    '',
    'Then, if the real open question boils down to a small number of genuinely distinct ' +
    'answers (e.g. "which storage backend" or "which of these 3 architectures"), ALSO ' +
    'give 2-4 concrete options in exactly this format, so a human can resolve it with one ' +
    'click instead of writing a reply from scratch:',
    'OPTIONS:',
    '1. <short label, under 8 words> :: <one-sentence description of what choosing this means>',
    '2. <short label, under 8 words> :: <one-sentence description of what choosing this means>',
    '(a free-text "Other" answer is always available separately in the UI -- do not add ' +
    'an "other" option yourself)',
    'If the honest answer space is genuinely open-ended (e.g. "describe what you want ' +
    'this to do") rather than a handful of concrete choices, omit the OPTIONS block ' +
    'entirely and rely on the open question text alone -- do not force a fake multiple-' +
    'choice list onto a question that does not have one.',
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

  // Defensive pre-cleanup (2026-08-25, root-caused live: this exact task looping forever
  // on "a branch named '...' already exists") -- worktreeDir/branchName are BOTH
  // deterministic, derived only from task.id, and the real cleanup below only runs inside
  // the finally block guarding the SECOND try (the actual agentic call). A process killed
  // between here and there (a kill -9, dead-process-check.js's own zombie-restart, an OOM,
  // a host reboot -- this file's own finally comment already documented the risk, just
  // never closed the loop) strands the branch with no path back: `git worktree add -b`
  // always tries to CREATE the branch, so every future retry for the SAME task.id fails at
  // this exact step, forever, before ever reaching the finally cleanup at all. Since both
  // names are unique to this one task, anything found here can only be OUR OWN stale
  // leftover from a prior interrupted attempt at this same task -- never another task's or
  // another lane's real work -- so force-clearing it before creating fresh is always safe.
  try { runGit(['worktree', 'remove', '--force', worktreeDir], resolvedRepoRoot); } catch (e) { /* no stale worktree registered */ }
  try { runGit(['branch', '-D', branchName], resolvedRepoRoot); } catch (e) { /* no stale branch */ }

  try {
    runGit(['worktree', 'add', worktreeDir, '-b', branchName, `origin/${mainBranch}`], resolvedRepoRoot);
  } catch (e) {
    return { succeeded: false, reason: `could not create adhoc scratch worktree: ${e.message}` };
  }

  const sandbox = SANDBOX_ENABLED ? buildSandboxOpts(resolvedRepoRoot, worktreeDir) : null;

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
        ...(sandbox ? { sandbox } : {}),
      });
      totalCostUsd += result.costUsd || 0;
      // sandboxUnavailable (2026-08-24): fails OPEN (the call above still ran, unsandboxed)
      // but flagged loudly on the task itself, not just a console.error a human might never
      // see -- see sandbox.js's own header on why this hardening layer must never become a
      // new single point of failure that blocks real work.
      if (result.sandboxUnavailable) task.sandboxUnavailable = true;

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

    if (resolution === 'decompose') {
      // No diff capture here -- Claude was told not to make code changes for this
      // resolution, and even if it looked at files first that's read-only investigation,
      // nothing to stage. applyAdhocDiff.js queues subTaskProposals as fresh adhoc tasks
      // at apply time; this function's only job is producing a valid proposal list.
      const afterResolution = summary.slice(resolutionMatch.index + resolutionMatch[0].length);
      const subTasks = parseSubTaskProposals(afterResolution);
      if (!subTasks || subTasks.length < 2) {
        return { succeeded: true, blocked: true, blockedReason: `Adhoc agentic implement pass said RESOLUTION: decompose but did not follow it with a valid JSON array of at least 2 {title, rawText} sub-tasks (total_cost_usd=${totalCostUsd.toFixed(4)})` };
      }
      task.adhocResolution = resolution;
      task.subTaskProposals = subTasks;
      task.rawDiff = '';
      task.implementResponse = summary;
      return { succeeded: true, blocked: false };
    }

    if (resolution === 'needs-human-decision') {
      // 2026-08-24, Grimmethy: "We're here to create permanent systemic fixes... Why is
      // it declining to do the work?" -- root-caused live: adhoc-agentic-draft.js's own
      // prompt already told the model to explain itself and not guess at a real product/
      // design decision, but the only resolutions available were implemented/no-changes-
      // needed/decompose -- none of which honestly means "I have real open questions for
      // a human." The model was forced into no-changes-needed, which reads as a flat
      // refusal and gets rejected every time, regardless of how sound its reasoning was.
      // No diff, no sub-task list -- this goes straight to a human (see local-draft.js's
      // own handling of needsClarification, which routes this to queue/needs-
      // clarification/ instead of the normal review flow) rather than being judged by an
      // automatic reviewer that has no way to verify a genuinely open question.
      task.adhocResolution = resolution;
      task.rawDiff = '';
      task.implementResponse = summary;
      return { succeeded: true, blocked: false, needsClarification: true };
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

module.exports = { draftAdhocImplement, buildAgenticPrompt, parseSubTaskProposals, parseClarificationOptions, buildSandboxOpts };
