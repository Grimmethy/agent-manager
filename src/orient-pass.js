'use strict';

// Agentic orient pass for adhoc tasks (2026-09-04) -- component 3 of the "plan mode" port.
// The deterministic grounding (plan-grounding.js) covers "the files/symbols the task names";
// this covers the rest -- "how does the surrounding subsystem work, what's the existing
// pattern to mirror, where exactly does the edit go" -- by actually reading the code with
// read-only tools BEFORE the plan is written, so the plan is grounded in confirmed facts
// and tier 3 doesn't burn its turn budget re-orienting.
//
// It runs ONLY when the deterministic grounding did NOT already cover the task
// (groundingCovers === false) -- a small, well-specified task pays 0 GPU here. The run
// itself is a read-only runPlanWithTools loop (~8 turns) seeded with the deterministic
// grounding so it confirms + extends rather than exploring from cold.
//
// Contract is an ORIENTATION REPORT, not tier 2's RESOLUTION+diff -- this pass never
// proposes a change, only maps the ground.

const { runPlanWithTools } = require('./local-tool-client.js');
const { summariseInvestigation } = require('./local-agentic-draft.js');
const { buildPlanGrounding, groundingCovers } = require('./plan-grounding.js');

const ORIENT_TURNS = Number(process.env.AGENT_MANAGER_ADHOC_ORIENT_TURNS) || 8;
const ORIENT_NOTES_CAP = 4000;

function buildOrientPrompt(task, groundingText) {
  const ctx = task.promptContext || {};
  return [
    'You are ORIENTING for a one-off task before a plan is written. You have real, read-only tools (grep_codebase, read_file, list_directory) against a real checkout of this repository. You will NOT change anything -- your only output is an ORIENTATION REPORT that a planner and an implementer will build on.',
    '',
    `Title: ${task.title || ''}`,
    '',
    ctx.rawText || JSON.stringify(ctx).slice(0, 4000),
    '',
    groundingText ? `A deterministic grep already found the following -- CONFIRM it and FILL THE GAPS; do NOT re-run searches for what is already shown here:\n\n${groundingText}\n` : '',
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

// task, { grounding?, runPlan?, maybeLocked } -> { notes: string, turnsUsed: number, skipped: bool }
async function runOrientPass(task, { grounding, runPlan = runPlanWithTools, maybeLocked } = {}) {
  const g = grounding || buildPlanGrounding(task);
  const groundingText = g ? g.text : '';

  // Nothing named, nothing found, or everything named is already covered -> skip the GPU.
  if (g && groundingCovers(task, g) && process.env.AGENT_MANAGER_ADHOC_ORIENT_ALWAYS !== 'true') {
    return { notes: groundingText, turnsUsed: 0, skipped: true };
  }

  const call = () => runPlan({ prompt: buildOrientPrompt(task, groundingText), maxTurns: ORIENT_TURNS, source: task.source, taskId: task.id, stage: 'orient' });
  let result;
  try {
    result = maybeLocked ? await maybeLocked(true, call, 'orient') : await call();
  } catch (e) {
    // Orient is best-effort -- a failed run just means the plan falls back to the
    // deterministic grounding.
    return { notes: groundingText, turnsUsed: 0, skipped: true, error: String(e && e.message || e).slice(0, 200) };
  }

  const responseText = (result && result.response) || '';
  const summary = summariseInvestigation(responseText, result && result.toolCallLog);
  let notes = summary || responseText.trim() || groundingText;
  if (notes.length > ORIENT_NOTES_CAP) notes = `${notes.slice(0, ORIENT_NOTES_CAP)}\n...[orient notes truncated]`;
  return { notes, turnsUsed: (result && result.turnsUsed) || 0, skipped: false };
}

module.exports = { runOrientPass, buildOrientPrompt, ORIENT_TURNS };
