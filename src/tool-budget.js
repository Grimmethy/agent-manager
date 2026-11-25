'use strict';
// Pure per-run tool-call budget tracker. No timers and no model-server calls.

const VERDICT = Object.freeze({ OK: 'ok', SOFT: 'soft', OVER: 'over', HARD: 'hard' });

// profile: { budget: number, multiple: number }
// ok   -> calls <= budget
// soft -> the first call past budget (one-time reminder for the run)
// over -> later calls past budget but not yet past budget * multiple (no further nudge)
// hard -> calls past budget * multiple (caller should stop the run)
function createToolBudget(profile) {
  if (!profile || typeof profile.budget !== 'number' || typeof profile.multiple !== 'number') {
    throw new TypeError('tool budget profile needs numeric budget and multiple');
  }
  const budget = profile.budget;
  const hardAt = budget * profile.multiple;
  let calls = 0;
  let softSent = false;
  return {
    record() {
      calls += 1;
      if (calls > hardAt) return { verdict: VERDICT.HARD, calls };
      if (calls > budget) {
        if (!softSent) {
          softSent = true;
          return { verdict: VERDICT.SOFT, calls };
        }
        return { verdict: VERDICT.OVER, calls };
      }
      return { verdict: VERDICT.OK, calls };
    },
    get calls() {
      return calls;
    },
  };
}

module.exports = { VERDICT, createToolBudget };
