'use strict';

// Multi-strategy plan retry module (HUB0316 · 2/4).
//
// When a planner produces a degenerate, incomplete, or exploratory plan, retry
// with progressively stronger prompt modifications. Three strategies are tried
// in order:
//
//   1. larger-output-budget   — ask the planner for more detail
//   2. simplified-request     — strip the prompt to essentials
//   3. constraint-heavy-prompt — add strict output constraints
//
// After all three fail the plan is treated as exhausted and the caller
// (task-pipeline) transitions the task to 'planner-failure'.

const MAX_RETRIES = 3;

const RETRY_STRATEGIES = [
  'larger-output-budget',
  'simplified-request',
  'constraint-heavy-prompt',
];

// ---------------------------------------------------------------------------
// Validation helpers (delegates to sibling plan-validation.js)
// ---------------------------------------------------------------------------

let _isDegeneratePlan = null;
let _isIncompletePlan = null;
let _isExploratoryNarration = null;

function loadPlanValidation() {
  if (_isDegeneratePlan !== null) return;
  try {
    const pv = require('./plan-validation');
    _isDegeneratePlan = typeof pv.isDegeneratePlan === 'function' ? pv.isDegeneratePlan : null;
    _isIncompletePlan = typeof pv.isIncompletePlan === 'function' ? pv.isIncompletePlan : null;
    _isExploratoryNarration = typeof pv.isExploratoryNarration === 'function' ? pv.isExploratoryNarration : null;
  } catch (_) {
    // Sibling module unavailable; fall back to a minimal inline check.
    _isDegeneratePlan = (text) => typeof text !== 'string' || text.trim().length === 0;
    _isIncompletePlan = (text) => typeof text !== 'string' || text.trim().length === 0;
    _isExploratoryNarration = () => false;
  }
}

/**
 * Return true when the plan looks valid (non-degenerate, complete, not just
 * exploratory narration).
 */
function isValidPlan(plan) {
  loadPlanValidation();
  if (plan == null || typeof plan !== 'string') return false;
  const trimmed = plan.trim();
  if (trimmed.length === 0) return false;
  if (_isDegeneratePlan && _isDegeneratePlan(plan)) return false;
  if (_isIncompletePlan && _isIncompletePlan(plan)) return false;
  if (_isExploratoryNarration && _isExploratoryNarration(plan)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Strategy application
// ---------------------------------------------------------------------------

/**
 * Produce a task object augmented with the chosen retry strategy.
 * The planner is expected to read `task._planStrategy` and adapt its prompt.
 */
function applyStrategy(task, strategy) {
  if (task == null || typeof task !== 'object') {
    throw new TypeError('task must be an object');
  }
  return Object.assign({}, task, { _planStrategy: strategy });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Retry the planner with successive strategy modifications until a valid plan
 * is produced or all strategies are exhausted.
 *
 * @param {object}   opts
 * @param {function} opts.planner  — (task) => string | null
 * @param {object}   opts.task      — base task object (not mutated)
 * @param {number}   [opts.attempt=1] — resume index into RETRY_STRATEGIES (1-based)
 * @returns {{ plan: string|null, strategy: string, exhausted: boolean }}
 */
function runWithRetry({ planner, task, attempt = 1 }) {
  if (typeof planner !== 'function') {
    throw new TypeError('planner must be a function');
  }

  // If the caller claims to be past the last retry, return exhausted immediately
  // without calling the planner — the pipeline should treat this as a final
  // failure state.
  if (attempt > RETRY_STRATEGIES.length) {
    return {
      plan: null,
      strategy: RETRY_STRATEGIES[RETRY_STRATEGIES.length - 1],
      exhausted: true,
    };
  }

  const startIdx = Math.max(0, attempt - 1);
  const strategies = RETRY_STRATEGIES.slice(startIdx);

  let lastStrategy = strategies[strategies.length - 1];

  for (const strategy of strategies) {
    const modifiedTask = applyStrategy(task, strategy);
    let plan;
    try {
      plan = planner(modifiedTask);
    } catch (_) {
      plan = null;
    }
    if (isValidPlan(plan)) {
      return { plan, strategy, exhausted: false };
    }
    lastStrategy = strategy;
  }

  return {
    plan: null,
    strategy: lastStrategy,
    exhausted: true,
  };
}

module.exports = {
  MAX_RETRIES,
  RETRY_STRATEGIES,
  runWithRetry,
};
