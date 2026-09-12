'use strict';

// Post-implement citation check for pipeline_debrief reports (2026-09-12). Root-caused
// live from a 6-task sample (and a wider 31-task blocked cluster): the drafting prompt
// (pipelineDebriefImplementPrompt, prompts.js) tells the model "Cite task id + history
// stage + model_calls row for each [SO WHAT] flag", and the evidence it's given is
// genuinely well-structured for this -- each audited task gets its own labeled
// "### COMPLETED N: <real-task-id>" block with a model_calls breakdown right under it.
// The model still, inconsistently, writes a generic aggregate claim ("across all 25
// tasks...") with zero citation. Confirmed live via a controlled re-test: the SAME task's
// SAME real evidence, re-run fresh (no priorRejectionFeedback), succeeded with real
// citations one time and failed the identical way a second time -- not a hard capability
// ceiling, but not reliably self-correcting either, and prior real attempts show the
// existing free-text priorRejectionFeedback loop repeating the identical generic mistake
// after being told about it twice in a row.
//
// This check is purely deterministic (no model call) -- unlike deep-dive-grounding-
// check.js's Check 2 fallback, there's no "is this semantically accurate" judgment to
// make here, only "did the SO WHAT section cite ANY of the real, closed set of evidence
// items it was handed." Wired via the generic, source-agnostic `postImplementCheck` hook
// (local-draft.js) -- same convention as deep_dive/function_length_review/premiseCheck;
// an 'ungrounded' verdict routes into the exact same blockedStage:'review' path a real
// review rejection takes, so the existing redraft/priorRejectionFeedback machinery picks
// it up unchanged. The rejection message lists the REAL valid citation tokens (same
// "closed-list" discipline this file's own prompts.js NOW-WHAT-Files-line fix already
// uses) so the next attempt has concrete options instead of vague English feedback.
//
// Kill switch: AGENT_MANAGER_PIPELINE_DEBRIEF_SO_WHAT_CHECK=false.

const COMPLETED_BLOCK_RE = /### COMPLETED (\d+):/g;
const NO_CONFIDENT_RE = /^\s*NO CONFIDENT INEFFICIENCY\b/i;

function isEnabled() {
  return process.env.AGENT_MANAGER_PIPELINE_DEBRIEF_SO_WHAT_CHECK !== 'false';
}

// Real, closed set of "COMPLETED N" numbers this task's evidence actually contains --
// the ONLY citation tokens a compliant SO WHAT may reference.
function realCompletedNumbers(task) {
  const evidenceText = (task.promptContext && task.promptContext.evidenceText) || '';
  const numbers = [];
  let m;
  COMPLETED_BLOCK_RE.lastIndex = 0;
  while ((m = COMPLETED_BLOCK_RE.exec(evidenceText))) numbers.push(m[1]);
  return numbers;
}

function realTaskIds(task) {
  const ids = (task.promptContext && task.promptContext.taskIds) || [];
  return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string' && id) : [];
}

// Isolates the SO WHAT section (between its own heading and the next section heading) --
// the citation requirement is specific to SO WHAT, not the whole report (WHAT is a
// call-profile summary, NOW WHAT has its own separate Files: line discipline already
// enforced elsewhere). Falls back to the whole text when the heading can't be found
// cleanly, matching this codebase's "can't isolate it -> check what we have, never throw"
// discipline (same as deep-dive-grounding-check.js's realFilesOf/checkFabricatedSymbols
// pattern of degrading to a no-op rather than a false block).
function extractSoWhatSection(text) {
  const m = /SO WHAT\s*\n([\s\S]*?)(?:\n\s*ALREADY-DETERMINISTIC CHECK\b|\n\s*NOW WHAT\b|$)/i.exec(text);
  return m ? m[1] : text;
}

// task, implementResponse -> { verdict: 'ok'|'ungrounded', reason? }
function runSoWhatCitationCheck(task, implementResponse) {
  if (!isEnabled()) return { verdict: 'ok' };
  const text = String(implementResponse || '');
  if (!text.trim()) return { verdict: 'ok' }; // empty is handled by the degenerate-output gate, not this check
  if (NO_CONFIDENT_RE.test(text.trim())) return { verdict: 'ok' }; // a valid, correct terminal outcome -- nothing to cite

  const completedNumbers = realCompletedNumbers(task);
  const taskIds = realTaskIds(task);
  if (!completedNumbers.length && !taskIds.length) return { verdict: 'ok' }; // nothing real to cite against -- don't invent a requirement the evidence itself can't support

  const soWhat = extractSoWhatSection(text);
  const citesCompleted = completedNumbers.some((n) => new RegExp(`\\bCOMPLETED\\s+${n}\\b`).test(soWhat));
  const citesTaskId = taskIds.some((id) => soWhat.includes(id));
  if (citesCompleted || citesTaskId) return { verdict: 'ok' };

  const sample = completedNumbers.slice(0, 5).map((n) => `COMPLETED ${n}`).join(', ');
  return {
    verdict: 'ungrounded',
    reason: `SO WHAT does not cite any specific evidence item (a "COMPLETED N" reference or a real task id) for its flagged inefficiency -- it must cite at least one, e.g.: ${sample || '(see evidence)'}. A generic aggregate claim ("across all N tasks...") with no citation is not grounded, even if the underlying observation is correct.`,
  };
}

module.exports = { runSoWhatCitationCheck, realCompletedNumbers, realTaskIds, extractSoWhatSection };
