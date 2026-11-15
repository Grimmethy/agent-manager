'use strict';

// Task state management module (HUB0316 · 3/4).
//
// Defines the task state enum and the transition rules between states.
// The central concern of this module is the new 'planner-failure' state
// which a task enters when the planner exhausts all retry strategies
// while producing degenerate/incomplete/exploratory output.
//
// Transition rules:
//   - From 'planning' → 'planner-failure' when retry is exhausted.
//   - From 'needs-clarification' → 'planner-failure' ONLY when the last
//     transition into needs-clarification was caused by a degenerate plan
//     (i.e. _lastTransitionReason === 'degenerate-plan'). This prevents
//     genuine unmet-prerequisite cases from being overwritten by the
//     planner-failure path.
//
// All other transitions are governed by the pipeline and are NOT defined
// here. This module is deliberately narrow: it owns only the planner-failure
// entry rules.

// ---------------------------------------------------------------------------
// State definitions
// ---------------------------------------------------------------------------

/**
 * All known task states, including the new 'planner-failure' state.
 * Kept in sync with queue/ subdirectory names and the dashboard UI.
 */
const TASK_STATES = [
  'pending',
  'review',
  'approved',
  'blocked',
  'done',
  'needs-clarification',
  'awaiting-confirm',
  'coordinating',
  'planning',
  'planner-failure',
];

/**
 * The reason a task entered the 'planner-failure' state.
 * Used by the pipeline to record _lastTransitionReason so that the
 * transition rule from 'needs-clarification' can distinguish a genuine
 * unmet-prerequisite case from a degenerate-plan retry exhaustion.
 */
const PLANNER_FAILURE_REASON = 'degenerate-plan-exhausted-retries';

// ---------------------------------------------------------------------------
// Transition rules
// ---------------------------------------------------------------------------

/**
 * States that can validly transition to 'planner-failure'.
 * Returns an array of allowed source states.
 */
function getPlannerFailureSourceStates() {
  return ['planning', 'needs-clarification'];
}

/**
 * Check whether a transition to 'planner-failure' is allowed from the
 * given source state, given the provided options.
 *
 * @param {string} from - The current state.
 * @param {object} [opts]
 * @param {string} [opts.lastTransitionReason] - The reason for the most
 *   recent transition into the current state. Required when `from` is
 *   'needs-clarification'.
 * @returns {boolean} True if the transition is allowed.
 */
function canTransitionToPlannerFailure(from, opts = {}) {
  if (typeof from !== 'string') return false;

  const allowedSources = getPlannerFailureSourceStates();
  if (!allowedSources.includes(from)) return false;

  // From 'planning': always allowed (the planner just ran and exhausted retries).
  if (from === 'planning') return true;

  // From 'needs-clarification': only allowed if the last transition was
  // caused by degenerate-plan exhaustion. This prevents genuine
  // unmet-prerequisite cases from being overwritten.
  if (from === 'needs-clarification') {
    const reason = opts.lastTransitionReason;
    if (reason !== PLANNER_FAILURE_REASON) return false;
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

module.exports = {
  TASK_STATES,
  PLANNER_FAILURE_REASON,
  getPlannerFailureSourceStates,
  canTransitionToPlannerFailure,
};
