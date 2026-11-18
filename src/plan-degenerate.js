/**
 * Plan-pass degenerate-output helpers.
 *
 * Pure module: no I/O, no clock reads, no network calls. The caller supplies
 * the plan runner, so this module never talks to the local model itself.
 *
 * classifyPlanOutput({ endClass, planText }) reports whether a plan result is
 * degenerate: truncated (endClass starts with 'length') or empty (trimmed
 * planText is empty).
 *
 * regeneratePlanUntilValid(runPlan) calls runPlan() repeatedly until a result
 * is not degenerate. There is deliberately no attempt cap and no delay between
 * attempts. A plan that is always degenerate will loop until the caller stops
 * it externally. This is flagged for human review.
 */
'use strict';

const PLAN_STAGE_BLOCKER = 'plan-stage';

function classifyPlanOutput({ endClass, planText } = {}) {
  if (typeof endClass === 'string' && endClass.startsWith('length')) {
    return { degenerate: true, reason: 'truncated' };
  }
  if (typeof planText !== 'string' || planText.trim() === '') {
    return { degenerate: true, reason: 'empty' };
  }
  return { degenerate: false, reason: null };
}

async function regeneratePlanUntilValid(runPlan) {
  for (;;) {
    const result = await runPlan();
    const verdict = classifyPlanOutput({
      endClass: result && result.endClass,
      planText: result && result.planText,
    });
    if (!verdict.degenerate) return result;
  }
}

module.exports = { classifyPlanOutput, PLAN_STAGE_BLOCKER, regeneratePlanUntilValid };
