'use strict';

// silent-catch-plan-cap.js -- optional character cap for plan-stage output on
// the `silent-catch-block` observation rule. When a plan is being generated
// for a finding that was expected to be dismissed (expectedDisposition ===
// 'dismiss'), the plan text is truncated to SILENT_CATCH_PLAN_MAX_CHARS to
// keep the queue payload bounded; every other (ruleId, disposition)
// combination passes through untouched. Pure, no I/O, no external requires
// (same constraint deterministic-recheck-registry.js holds, another core file
// on a hot path).

/**
 * @module silent-catch-plan-cap
 * @description Bounds plan-stage output length for the
 *   `silent-catch-block` rule when the expected disposition is `dismiss`.
 *   Exposes `SILENT_CATCH_PLAN_MAX_CHARS` (1500) and `capPlanStageOutput`.
 *   Deterministic and pure: no I/O, no external requires.
 */

const SILENT_CATCH_PLAN_MAX_CHARS = 1500;

/**
 * Cap a plan-stage output string.
 * @param {string} planText - The plan text as produced by the plan stage.
 * @param {string} ruleId - The observation rule that produced the finding.
 * @param {string} expectedDisposition - The disposition expected for the
 *   finding, e.g. `'dismiss'` or `'fix'`.
 * @returns {string} `planText.slice(0, SILENT_CATCH_PLAN_MAX_CHARS)` when
 *   `ruleId === 'silent-catch-block'` AND `expectedDisposition === 'dismiss'`;
 *   otherwise `planText` unchanged (same reference, never copied).
 */
function capPlanStageOutput(planText, ruleId, expectedDisposition) {
  if (ruleId === 'silent-catch-block' && expectedDisposition === 'dismiss') {
    return planText.slice(0, SILENT_CATCH_PLAN_MAX_CHARS);
  }
  return planText;
}

module.exports = { SILENT_CATCH_PLAN_MAX_CHARS, capPlanStageOutput };
