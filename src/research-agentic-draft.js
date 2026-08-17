'use strict';

// Agentic drafting for research-domain tasks (Brain Dump #1 follow-up, 2026-08-17: "how
// can we turn [a note that requires investigating something on the web] into an
// actionable task"). Mirrors adhoc-agentic-draft.js's shape (a real agentic Claude Code
// CLI call instead of Ornith's plain-text-only path -- Ornith has no tool-calling
// capability at all, confirmed while building the Discuss harness-search feature) but is
// simpler: a research task never touches the tracked code repo, so there is no git
// worktree, no branch, no diff to capture -- just a real WebSearch/WebFetch-backed
// investigation whose write-up IS the output, captured as plain text and later written
// into SecondBrain by apply-group-a.js's applyResearchTask() once a human confirms it
// (see apply-task.js's awaiting-confirm gate).

const { call: defaultClaudeCall } = require('./claude-client.js');
const { recordCall: defaultRecordModelCall } = require('./model-stats-client.js');

// Real multi-turn web research (search, follow links, read, synthesize) runs longer than
// claude-client.js's normal 300s default (sized for a single text completion) but doesn't
// need adhoc's full 900s/30-turn budget (no investigate/edit/test cycle, no repo to dig
// through) -- sized independently and env-configurable, same convention as
// AGENT_MANAGER_ADHOC_TIMEOUT_MS/AGENT_MANAGER_ADHOC_MAX_TURNS.
const RESEARCH_TIMEOUT_MS = Number(process.env.AGENT_MANAGER_RESEARCH_TIMEOUT_MS) || 600_000;
const RESEARCH_MAX_TURNS = Number(process.env.AGENT_MANAGER_RESEARCH_MAX_TURNS) || 15;

const RESULT_RE = /RESEARCH:\s*(completed|inconclusive)\b/i;

function buildResearchPrompt(task) {
  const ctx = task.promptContext || {};
  return [
    'You are researching a topic for someone\'s personal notes, using real web search and ' +
    'page-reading tools -- you have WebSearch/WebFetch tool access, use it. This is not a ' +
    'code task and there is no repository involved.',
    '',
    `Title: ${task.title || ''}`,
    '',
    ctx.rawText || '',
    '',
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
  ].join('\n');
}

/**
 * Drafts task.researchDoc/task.implementResponse for a research-domain task via a real
 * agentic Claude Code CLI call with WebSearch/WebFetch tool access. Mutates `task` in
 * place (researchDoc, researchResolution, implementResponse) on success.
 * @returns {Promise<{succeeded: boolean, blocked?: boolean, blockedReason?: string, reason?: string}>}
 */
async function draftResearchImplement(task, { claudeCall = defaultClaudeCall, recordModelCall = defaultRecordModelCall } = {}) {
  try {
    const startedAt = new Date().toISOString();
    const startMs = Date.now();
    const result = await claudeCall({
      prompt: buildResearchPrompt(task),
      allowedTools: 'WebSearch,WebFetch',
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
  }
}

module.exports = { draftResearchImplement, buildResearchPrompt };
