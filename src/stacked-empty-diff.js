'use strict';

// Pure classifier for stacked tasks that produced an empty diff.
//
// This module performs no I/O and has no dependencies. Its result depends only on
// its four arguments. Callers (subtasks 2 and 3) are responsible for gathering the
// inputs and for acting on the result.
//
// Decision order (first match wins):
//   (a) endClass !== 'stop' OR toolErrorCount > 0 (or a non-finite toolErrorCount,
//       which is treated as not-clean): never already-landed. Routes to redraft.
//   (b) clean stop and targetPresentInBase === true: already-landed.
//   (c) clean stop and baseHasPredecessorLanding === true: redraft-on-landed-base.
//   (d) otherwise: needs-clarification.
//
// Note: 'true-conflict' is never emitted by this function. It cannot be derived from
// these four inputs, so callers must not expect it from here.

function classifyStackedEmptyDiff({ endClass, toolErrorCount, targetPresentInBase, baseHasPredecessorLanding } = {}) {
  const errors = Number.isFinite(toolErrorCount) ? toolErrorCount : NaN;
  const cleanStop = endClass === 'stop' && errors === 0;

  // (a) Not a clean stop. Never already-landed.
  if (!cleanStop) {
    if (errors > 0) {
      return { outcome: 'redraft-on-landed-base', reason: 'apply-failure' };
    }
    return { outcome: 'redraft-on-landed-base', reason: 'empty-stacked-diff' };
  }

  // (b) Clean stop and the target is already in base.
  if (targetPresentInBase === true) {
    return { outcome: 'already-landed', reason: 'already-landed' };
  }

  // (c) Clean stop and the base has the predecessor landing.
  if (baseHasPredecessorLanding === true) {
    return { outcome: 'redraft-on-landed-base', reason: 'empty-stacked-diff' };
  }

  // (d) Otherwise.
  return { outcome: 'needs-clarification', reason: 'empty-stacked-diff' };
}

module.exports = { classifyStackedEmptyDiff };
