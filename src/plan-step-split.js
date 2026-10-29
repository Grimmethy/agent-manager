'use strict';

// Deterministic fallback for the decompose give-up split (2026-10-15).
//
// When an agentic implement pass answers RESOLUTION: decompose but produces no usable sub-task JSON, runGiveUpSplit
// (local-agentic-write-draft.js) runs one single-call decompose pass. If that pass returns nothing or fewer than two
// pieces (no decompose plugin loaded, a model failure, garbage output) the task used to be requeued for another full
// agentic pass. This module splits the task's OWN plan instead: the numbered steps the plan stage already wrote.
//
// No model call. Returns null whenever it cannot produce `min` or more pieces, so the caller keeps today's behaviour.
// AGENT_MANAGER_DECOMPOSE_REPAIR=off disables the whole repair path (this module and the first-miss trigger).

const MAX_TITLE_CHARS = 100;
const MAX_PARENT_REQUEST_CHARS = 1500;

function repairEnabled() {
  return String(process.env.AGENT_MANAGER_DECOMPOSE_REPAIR || '').trim().toLowerCase() !== 'off';
}

// "  **1.** Do x" / "1) Do x" / "1. Do x" -> the step number and the rest of the line.
const STEP_RE = /^\s*(?:\*\*)?(\d+)[.)](?:\*\*)?\s+(.*)$/;

function planStepsOf(planText) {
  const lines = String(planText || '').split('\n');
  const steps = [];
  for (const line of lines) {
    if (/^\s*CRITERIA:\s*$/i.test(line)) break; // the criteria block is not a step
    const m = STEP_RE.exec(line);
    if (m) {
      steps.push({ n: Number(m[1]), lines: [m[2].trim()] });
    } else if (steps.length > 0 && line.trim()) {
      steps[steps.length - 1].lines.push(line.trim()); // continuation of the previous step
    }
  }
  return steps.map((s) => s.lines.join('\n'));
}

function firstSentence(text) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  const m = /^(.+?[.!?])(\s|$)/.exec(flat);
  const s = (m ? m[1] : flat).replace(/[*`]/g, '').trim();
  return s.length > MAX_TITLE_CHARS ? `${s.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…` : s;
}

// Splits `items` into `groups` consecutive, near-equal chunks (earlier chunks take the remainder).
function balancedGroups(items, groups) {
  const out = [];
  const base = Math.floor(items.length / groups);
  let extra = items.length % groups;
  let at = 0;
  for (let g = 0; g < groups; g++) {
    const size = base + (extra > 0 ? 1 : 0);
    if (extra > 0) extra--;
    out.push(items.slice(at, at + size));
    at += size;
  }
  return out;
}

/**
 * @param {object} task - uses task.planResponse || task.lastGoodPlan, task.title, task.promptContext.rawText
 * @returns {{subTasks: Array<{title: string, rawText: string, after?: number}>}|null}
 */
function deterministicPlanSplit(task, { min = 2, max = 5 } = {}) {
  const steps = planStepsOf(task && (task.planResponse || task.lastGoodPlan));
  if (steps.length < min) return null;
  const groups = steps.length > max ? balancedGroups(steps, max) : steps.map((s) => [s]);
  const parentTitle = String((task && task.title) || task.id || 'the parent task');
  const request = String((task && task.promptContext && task.promptContext.rawText) || '').slice(0, MAX_PARENT_REQUEST_CHARS);
  const subTasks = groups.map((group, i) => {
    const rawText = [
      `Part ${i + 1} of ${groups.length} of the parent task "${parentTitle}" (split mechanically from the parent's own plan).`,
      '',
      'YOUR PART OF THE PLAN:',
      group.map((s, k) => `${k + 1}. ${s}`).join('\n'),
      ...(request ? ['', 'THE PARENT TASK\'S REQUEST, FOR CONTEXT ONLY (do only your part above):', request] : []),
    ].join('\n');
    const piece = { title: firstSentence(group[0]) || `${parentTitle} (part ${i + 1})`, rawText };
    if (i > 0) piece.after = i - 1; // plan steps are sequential: each piece waits for the previous one to merge
    return piece;
  });
  return { subTasks };
}

module.exports = { deterministicPlanSplit, repairEnabled, planStepsOf };
