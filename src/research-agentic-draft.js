'use strict';

// Agentic drafting for research-domain tasks (Brain Dump #1 follow-up, 2026-08-17: "how
// can we turn [a note that requires investigating something on the web] into an
// actionable task"). Mirrors adhoc-agentic-draft.js's shape (a real agentic Claude Code
// CLI call instead of the local model's plain-text-only path -- the local model has no tool-calling
// capability at all, confirmed while building the Discuss harness-search feature) but is
// simpler: a research task never touches the tracked code repo, so there is no git
// worktree, no branch, no diff to capture -- just a real WebSearch/WebFetch-backed
// investigation whose write-up IS the output, captured as plain text and later written
// into SecondBrain by apply-group-a.js's applyResearchTask() once a human confirms it
// (see apply-task.js's awaiting-confirm gate).

const { call: defaultClaudeCall } = require('./claude-client.js');
const { recordCall: defaultRecordModelCall } = require('./model-stats-client.js');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// GitHub-repo investigation (2026-08-24, Grimmethy: root-caused live -- 12 combined
// failed attempts across two "investigate this GitHub repo" research tasks, every one
// rejected for the same reason (hedged claims, README-only investigation, no real
// file-level citations) because WebSearch/WebFetch alone can never reliably browse an
// arbitrary repo's file tree or read many source files -- the review bar these tasks set
// for themselves ("cite the specific entry-point file... quote exact code") was
// structurally impossible with only page-fetching tools, no amount of redrafting fixes
// that. When the task text names a real github.com repo, shallow-clone it into a
// throwaway temp dir and grant real Read/Grep/Glob alongside WebSearch/WebFetch --
// read-only investigation, same as adhoc-agentic-draft.js's worktree but with no
// Write/Edit/Bash/branch/commit at all, since there is nothing here to change, only to
// read. Best-effort: a clone that fails (private repo, network hiccup, bad URL) silently
// falls back to the original web-only path rather than failing the task outright.
const GITHUB_REPO_URL_RE = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?=[\s)\]]|$)/;
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
const GIT_CLONE_TIMEOUT_MS = 60_000;

function extractGithubRepoUrl(text) {
  const match = (text || '').match(GITHUB_REPO_URL_RE);
  return match ? `https://github.com/${match[1]}/${match[2]}` : null;
}

/**
 * Best-effort shallow clone into a fresh throwaway temp dir. Returns the dir on success,
 * null on any failure (never throws) -- a clone failure degrades to the original
 * web-only investigation, it never blocks the task from running at all.
 */
function cloneRepoForInvestigation(repoUrl, taskId) {
  const dir = path.join(os.tmpdir(), `agent-manager-research-clone-${taskId}-${Date.now()}`);
  try {
    execFileSync('git', ['clone', '--depth', '1', repoUrl, dir], { env: GIT_ENV, timeout: GIT_CLONE_TIMEOUT_MS, stdio: 'pipe' });
    return dir;
  } catch (err) {
    const detail = [err.message];
    if (err.code) detail.push(`code=${err.code}`);
    if (err.signal) detail.push(`signal=${err.signal}`);
    console.warn(`git clone failed for ${repoUrl}: ${detail.join(' ')}`);
    return null;
  }
}

function cleanupClone(dir) {
  if (!dir) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

// Real multi-turn web research (search, follow links, read, synthesize) runs longer than
// claude-client.js's normal 300s default (sized for a single text completion) but doesn't
// need adhoc's full 900s/30-turn budget (no investigate/edit/test cycle, no repo to dig
// through) -- sized independently and env-configurable, same convention as
// AGENT_MANAGER_ADHOC_TIMEOUT_MS/AGENT_MANAGER_ADHOC_MAX_TURNS.
const RESEARCH_TIMEOUT_MS = Number(process.env.AGENT_MANAGER_RESEARCH_TIMEOUT_MS) || 600_000;
const RESEARCH_MAX_TURNS = Number(process.env.AGENT_MANAGER_RESEARCH_MAX_TURNS) || 15;

const RESULT_RE = /RESEARCH:\s*(completed|inconclusive)\b/i;

function buildResearchPrompt(task, repoClone) {
  const ctx = task.promptContext || {};
  const lines = [
    'You are researching a topic for someone\'s personal notes, using real web search and ' +
    'page-reading tools -- you have WebSearch/WebFetch tool access, use it.',
    '',
    `Title: ${task.title || ''}`,
    '',
    ctx.rawText || '',
    '',
  ];
  // 2026-08-25: the plan pass (prompts.js's researchPlanPrompt) now runs with its own
  // real WebSearch/WebFetch access and is required to verify, not guess, any specific
  // fact it states -- feed its findings in here so this pass builds on what's already
  // confirmed instead of re-searching the same ground from scratch, and so a plan point
  // phrased as "could not confirm X" reads as a lead to chase, not a settled fact to
  // reproduce. This pass still does its own independent verification -- the plan's own
  // prompt describes it as a scoping pass, not the final word, and this instruction
  // reflects that explicitly rather than asking the model to defer to it.
  if (task.planResponse) {
    lines.push(
      '=== PLAN (from an earlier scoping pass with its own real search access -- verified ' +
      'findings are a head start, but re-confirm anything load-bearing yourself rather ' +
      'than taking it on faith; anything the plan flagged as unconfirmed is a lead to ' +
      'chase, not a fact) ===',
      task.planResponse,
      '',
    );
  }
  if (repoClone) {
    lines.push(
      'The GitHub repo this task asks about has been cloned for real, read-only ' +
      `investigation at: ${repoClone.dir} (from ${repoClone.url}). You ALSO have real ` +
      'Read/Grep/Glob tool access to this exact directory -- use it to actually open and ' +
      'read source files, not just the README. If the task asks you to cite a specific ' +
      'entry-point file, a data-ingestion module, a config/schema file, or quote exact ' +
      'code, you MUST get that from a real file you opened in this clone (cite the real ' +
      'relative path, e.g. src/index.ts, and the real line/function), never from a guess ' +
      "or from a README's prose description of what the code probably does. There is no " +
      'Write/Edit/Bash access here -- this is investigation only, nothing to change.',
      '',
    );
  } else {
    lines.push('This is not a code task and there is no repository involved.', '');
  }
  lines.push(
    'Investigate the topic above using real searches and by reading real sources -- do not ' +
    'rely on prior knowledge alone if the note asks about something current, specific, or ' +
    'checkable (an account, a product, a business, a recent event). Write a markdown ' +
    'write-up suitable for appending to a personal reference note: concrete facts, cite ' +
    'the real sources/URLs you found them from, and clearly flag anything you are unsure ' +
    'about rather than stating it as fact. If you genuinely cannot find real, verifiable ' +
    'information (searches turn up nothing relevant, sources are inaccessible, or the ' +
    'topic is too vague to research), say so honestly instead of fabricating content.',
    '',
    'When you are completely done, end your FINAL message with exactly one of these two ' +
    'lines (nothing after it on that line):',
    'RESEARCH: completed',
    'RESEARCH: inconclusive',
    '',
    'If "completed", everything before that line is the write-up itself (start it with a ' +
    '# heading, no preamble like "Here is my research" before the heading). If ' +
    '"inconclusive", explain briefly why nothing usable was found instead.',
  );
  return lines.join('\n');
}

/**
 * Drafts task.researchDoc/task.implementResponse for a research-domain task via a real
 * agentic Claude Code CLI call with WebSearch/WebFetch tool access. Mutates `task` in
 * place (researchDoc, researchResolution, implementResponse) on success.
 * @returns {Promise<{succeeded: boolean, blocked?: boolean, blockedReason?: string, reason?: string}>}
 */
async function draftResearchImplement(task, { claudeCall = defaultClaudeCall, recordModelCall = defaultRecordModelCall, cloneRepo = cloneRepoForInvestigation } = {}) {
  const repoUrl = extractGithubRepoUrl(task.promptContext && task.promptContext.rawText);
  const cloneDir = repoUrl ? cloneRepo(repoUrl, task.id) : null;
  const repoClone = cloneDir ? { dir: cloneDir, url: repoUrl } : null;
  try {
    const startedAt = new Date().toISOString();
    const startMs = Date.now();
    const allowedTools = repoClone ? 'WebSearch,WebFetch,Read,Grep,Glob' : 'WebSearch,WebFetch';
    const result = await claudeCall({
      prompt: buildResearchPrompt(task, repoClone),
      allowedTools,
      // A real clone to read alongside web tools needs the repo's own directory as cwd
      // so Read/Grep/Glob resolve relative paths against it, not this dashboard's own
      // repo -- same reasoning adhoc-agentic-draft.js's cwd: worktreeDir already applies.
      cwd: repoClone ? repoClone.dir : undefined,
      maxTurns: RESEARCH_MAX_TURNS,
      permissionMode: 'dontAsk',
      timeoutMs: RESEARCH_TIMEOUT_MS,
    });

    task.abCallId = recordModelCall({
      taskId: task.id,
      model: 'claude:research-agentic',
      startedAt,
      latencyMs: Date.now() - startMs,
      result,
    });

    if (result.degenerate) {
      return { succeeded: true, blocked: true, blockedReason: `Research agentic implement pass degenerate: ${result.degenerate}` };
    }

    const response = result.response || '';
    const resultMatch = response.match(RESULT_RE);
    const resolution = resultMatch ? resultMatch[1].toLowerCase() : null;

    if (!resolution) {
      // Same "fail loud, don't guess" reasoning as adhoc-agentic-draft.js's own RESOLUTION
      // check -- a response with no sentinel is treated as degenerate rather than silently
      // guessed at (e.g. auto-treated as "completed" and filed into SecondBrain unreviewed).
      return { succeeded: true, blocked: true, blockedReason: 'Research agentic implement pass did not end with a RESEARCH: line -- cannot determine outcome' };
    }

    if (resolution === 'inconclusive') {
      return { succeeded: true, blocked: true, blockedReason: `Research inconclusive: ${response.replace(RESULT_RE, '').trim().slice(0, 500)}` };
    }

    // Strip the trailing sentinel line itself -- the write-up is everything before it.
    task.researchDoc = response.replace(RESULT_RE, '').trim();
    task.researchResolution = resolution;
    task.implementResponse = task.researchDoc;

    return { succeeded: true, blocked: false };
  } catch (e) {
    return { succeeded: false, reason: e.message };
  } finally {
    cleanupClone(cloneDir);
  }
}

module.exports = { draftResearchImplement, buildResearchPrompt, extractGithubRepoUrl, cloneRepoForInvestigation };
