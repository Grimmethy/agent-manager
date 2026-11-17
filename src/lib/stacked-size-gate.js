'use strict';

// stacked-size-gate.js -- pure decision helper for the stacked size gate (HUB0559 1/2).
//
// A stacked continuation is a task whose `stacked` field is present and whose `stacked.seq`
// is 2 or more (step 1 of a stacked chain is the root and is not a continuation). Such a
// task has already been sized by its parent decompose pass, so the size gate must not run
// again on it: applySizeGate returns 'implement' without calling runSizeCheck. Any other
// task defers to runSizeCheck and returns its result unchanged.
//
// No model calls and no timers live in this module.

function isStackedContinuation(task) {
  if (!task || !task.stacked) return false;
  return Number(task.stacked.seq) >= 2;
}

async function applySizeGate(task, runSizeCheck) {
  if (isStackedContinuation(task)) return 'implement';
  return await runSizeCheck(task);
}

module.exports = { isStackedContinuation, applySizeGate };
