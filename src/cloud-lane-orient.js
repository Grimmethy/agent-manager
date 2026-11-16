'use strict';

// Node read-only orient pass (HUB0481). A narrow, read-only orientation pass that runs
// inside a node cloud lane before the plan/implement tier. It exposes ONLY the three
// read-only tools Read / Grep / Glob to the model, refuses every other tool name
// (Bash, Write, Edit, web, etc.) without executing it -- the refusal still counts as a
// turn so the model learns the boundary quickly -- and caps the total turns via the
// AGENT_MANAGER_NODE_ORIENT_TURNS env var (default 8).
//
// Contract: `runNodeOrientPass(task, { grounding, runClaude, checkoutDir, logger })`
// returns a Promise resolving to { notes, turnsUsed, skipped, error }. On any thrown
// error the function returns { notes: grounding, turnsUsed: 0, skipped: true, error:
// <string> } and logs the reason via `logger`.

const NODE_ORIENT_TOOLS = ['Read', 'Grep', 'Glob'];
const ENV_VAR_NAME = 'AGENT_MANAGER_NODE_ORIENT_TURNS';
const DEFAULT_ORIENT_TURNS = 8;

function parseTurnCap(env) {
  const raw = env[ENV_VAR_NAME];
  if (raw === undefined || raw === null || raw === '') return DEFAULT_ORIENT_TURNS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return DEFAULT_ORIENT_TURNS;
  return n;
}

function buildOrientPrompt(task, groundingText) {
  const ctx = task.promptContext || {};
  return [
    'You are ORIENTING a codebase for a one-off task. You have real, read-only tools (Read, Grep, Glob) against a real checkout of this repository at the working directory you are given. You will NOT change anything -- your only output is an ORIENTATION REPORT that a planner and an implementer will build on.',
    '',
    `Title: ${task.title || ''}`,
    '',
    ctx.rawText || JSON.stringify(ctx).slice(0, 4000),
    '',
    groundingText ? `A deterministic grep already found the following -- CONFIRM it and FILL THE GAPS; do NOT re-run searches for what is already shown here:\n\n${groundingText}\n` : '',
    'You are ONLY allowed to use the tools Read, Grep, Glob. Any other tool name (Bash, Write, Edit, or any web tool) will be refused -- the refusal still counts as a turn, so do not waste turns on it. Set your working directory to the checkout directory provided to you.',
    'Spend your turns reading the code the task actually touches. Then, as your FINAL message (no more tool calls), write the ORIENTATION REPORT in this shape:',
    '',
    'CURRENT STATE: what exists now that is relevant to this task (2-4 sentences).',
    'KEY FILES/SYMBOLS: each as `path:line -- what it is`, only ones you actually read.',
    'EXISTING PATTERN TO MIRROR: if the task adds something, the closest existing thing it should look like, with a path:line.',
    'EDIT LOCATION(S): where the change goes, as specifically as you can (path, and the function/line region).',
    'OPEN QUESTION: anything genuinely ambiguous a human may need to decide -- or "none".',
    '',
    'Be concrete and cite real path:line. If you could not confirm something, say "unconfirmed" -- do not guess.',
  ].filter(Boolean).join('\n');
}

// gateToolCalls: given a list of tool names from a model response, return { allowed, refused }.
// Allowed tools are passed through unchanged. Refused tools are dropped from the call but
// the turn still counts.
function gateToolCalls(toolNames) {
  const allowed = [];
  const refused = [];
  for (const name of toolNames) {
    if (NODE_ORIENT_TOOLS.includes(name)) {
      allowed.push(name);
    } else {
      refused.push(name);
    }
  }
  return { allowed, refused };
}

async function runNodeOrientPass(task, { grounding, runClaude, checkoutDir, logger }) {
  const notesInit = typeof grounding === 'string' ? grounding : (grounding && grounding.text) || '';
  let turnsUsed = 0;
  let skipped = false;
  let error = undefined;
  const cap = parseTurnCap(process.env);

  try {
    let response;
    let prompt = buildOrientPrompt(task, notesInit);
    const toolNames = [...NODE_ORIENT_TOOLS];

    while (turnsUsed < cap) {
      turnsUsed += 1;

      response = await runClaude({
        prompt,
        tools: toolNames,
        workingDirectory: checkoutDir,
        maxTurns: 1,
      });

      const toolCalls = response && response.toolCalls;
      if (!toolCalls || !Array.isArray(toolCalls) || toolCalls.length === 0) {
        // No tool calls in response -- orient pass complete
        break;
      }

      // Gate: check each tool name; refuse those not in NODE_ORIENT_TOOLS
      const { allowed, refused } = gateToolCalls(
        toolCalls.map((tc) => tc && tc.tool)
      );

      if (refused.length > 0) {
        // Refused tools still count as a turn (already incremented above)
        // Continue the loop -- the model will learn the boundary
      }

      // Check if there are any allowed tool calls
      const hasAllowedTools = toolCalls.some((tc) => tc && tc.tool && NODE_ORIENT_TOOLS.includes(tc.tool));
      if (!hasAllowedTools) {
        // No allowed tool calls in this response -- orient pass complete
        break;
      }

      // Build next prompt with tool results
      const toolResults = toolCalls
        .filter((tc) => tc && tc.tool && NODE_ORIENT_TOOLS.includes(tc.tool))
        .map((tc) => `${tc.tool}: ${tc.result || ''}`)
        .join('\n');

      prompt += `\n\nTool results:\n${toolResults}\n\nContinue orienting or write the ORIENTATION REPORT if done.`;
    }

    // Extract notes from the final response
    const finalResponse = response && response.response;
    const notes = finalResponse && finalResponse.trim() ? finalResponse.trim() : notesInit;

    return { notes, turnsUsed, skipped: false, error: undefined };
  } catch (reason) {
    if (logger && typeof logger.error === 'function') {
      logger.error(`[cloud-lane-orient] error: ${reason && reason.message || reason}`);
    } else if (typeof console.error === 'function') {
      console.error(`[cloud-lane-orient] error: ${reason && reason.message || reason}`);
    }
    return {
      notes: notesInit,
      turnsUsed: 0,
      skipped: true,
      error: String(reason && reason.message || reason),
    };
  }
}

module.exports = { runNodeOrientPass, NODE_ORIENT_TOOLS, parseTurnCap };
