'use strict';

// anomalyco-opencode-176: fixed-rule gate evaluator. Plain code rules on action.riskTier and action.type; no model call, no store or pending-record access, no I/O or timers, so it is side-effect free.
// Assumed vocabulary (verify against callers): action is an object with string fields `riskTier` ('low' | 'medium' | 'high') and `type`.

const KNOWN_TIERS = new Set(['low', 'medium', 'high']);
// Assumption: the auto-approvable action types. Confirm this list with the task owner.
const AUTO_APPROVABLE_TYPES = new Set(['docs', 'format']);

// Returns 'auto-approve' or 'park'. Fails closed: anything missing or unrecognised parks.
function evaluate(action) {
  if (!action || typeof action !== 'object') return 'park';
  const tier = action.riskTier;
  if (typeof tier !== 'string' || !KNOWN_TIERS.has(tier)) return 'park';
  if (tier === 'low' && AUTO_APPROVABLE_TYPES.has(action.type)) return 'auto-approve';
  return 'park';
}

module.exports = { evaluate };
