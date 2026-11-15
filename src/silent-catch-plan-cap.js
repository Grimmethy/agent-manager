'use strict';

// silent-catch-plan-cap.js -- optional character cap for plan-stage output on
// the `silent-catch-block` observation rule. When a plan is being generated
// for a finding that was expected to be dismissed (expectedDisposition ===
// 'dismiss' or 'dismissed'), the plan text is truncated to
// SILENT_CATCH_PLAN_MAX_CHARS to keep the queue payload bounded; every other
// (ruleId, disposition) combination passes through untouched. Pure, no I/O, no
// external requires (same constraint deterministic-recheck-registry.js holds,
// another core file on a hot path).

/**
 * @module silent-catch-plan-cap
 * @description Bounds plan-stage output length for the
 *   `silent-catch-block` rule when the expected disposition is dismissed.
 *   Exposes `SILENT_CATCH_PLAN_MAX_CHARS` (1500), `capPlanStageOutput`,
 *   `deriveExpectedDisposition`, and `deriveRuleId`.
 *   Deterministic and pure: no I/O, no external requires.
 */

const SILENT_CATCH_PLAN_MAX_CHARS = 1500;

/**
 * Derive the expected disposition for a task. Only an observability_review
 * finding that was marked dismissed yields 'dismissed'. Everything else,
 * including genuine silent-catch findings, yields null so it stays uncapped.
 * @param {object} task - The pipeline task record.
 * @returns {'dismissed'|null}
 */
function deriveExpectedDisposition(task) {
  if (!task || typeof task !== 'object') return null;
  if (task.source !== 'observability_review') return null;
  if (String(task.reviewDisposition || '').trim() === 'dismissed') return 'dismissed';
  return null;
}

/**
 * Derive the observation rule id from a prompt context.
 * Precedence: originalRule, then rule, then 'unknown'.
 * @param {object} promptContext - The prompt context, may be undefined.
 * @returns {string}
 */
function deriveRuleId(promptContext) {
  const c = promptContext || {};
  return c.originalRule || c.rule || 'unknown';
}

/**
 * Cap a plan-stage output string.
 * @param {string} planText - The plan text as produced by the plan stage.
 * @param {string} ruleId - The observation rule that produced the finding.
 * @param {string} expectedDisposition - The disposition expected for the
 *   finding, e.g. `'dismiss'`, `'dismissed'`, or `'fix'`.
 * @returns {string} `planText.slice(0, SILENT_CATCH_PLAN_MAX_CHARS)` when
 *   `ruleId === 'silent-catch-block'` AND expectedDisposition is `'dismiss'`
 *   or `'dismissed'`; otherwise `planText` unchanged (same reference, never
 *   copied).
 */
function capPlanStageOutput(planText, ruleId, expectedDisposition) {
  const dismissed = expectedDisposition === 'dismiss' || expectedDisposition === 'dismissed';
  if (ruleId === 'silent-catch-block' && dismissed) {
    return planText.slice(0, SILENT_CATCH_PLAN_MAX_CHARS);
  }
  return planText;
}

module.exports = {
  SILENT_CATCH_PLAN_MAX_CHARS,
  capPlanStageOutput,
  deriveExpectedDisposition,
  deriveRuleId,
};
