'use strict';

// Pure classifier for the agentic implement pass's turn-cap outcome.
// Deliberately has NO require() of the agentic draft common module (that would be a circular dependency).

// Prefix of the placeholder implementResponse text written when a pass ran out of turns
// before reaching a conclusion (mirrors the fallback string in the agentic draft common module).
const PLACEHOLDER_PREFIX = '(the agentic implement pass ran out of turns before reaching a conclusion';

// Mirrors RERUN_NOT_A_QUESTION_RE from the agentic draft common module. MUST stay in sync with that line.
const RERUN_NOT_A_QUESTION_RE = /\bno (?:open |real |actual )?(?:design )?(?:question|decision)\b|\b(?:ran |run )out of turns\b|\bexhausted (?:my|its|the|this) turn(?: budget)?\b|\bre-?run (?:this|the|it|me)\b|\bfresh pass (?:can|could|will) (?:complete|finish)\b|\bwhat (?:did |does )not(?: yet)? land\b/i;

// partialDiffPresent is accepted for interface stability but is not used by these rules;
// the task does not define a decision that depends on it.
function classifyTurnCap(summary, turnBudgetExhausted, partialDiffPresent) {
  const text = String(summary || '').trim();

  if (!text && turnBudgetExhausted) {
    return { reason: 'ran-out-of-turns', openQuestions: '' };
  }

  if (!text) return null;

  if (RERUN_NOT_A_QUESTION_RE.test(text)) return null;

  if (text.includes('?')) {
    return { reason: 'design-decision', openQuestions: summary };
  }

  return null;
}

module.exports = { classifyTurnCap, PLACEHOLDER_PREFIX };
