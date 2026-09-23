'use strict';

// Default decompose/split-proposal detection hook (S3-a of the hub-tasks extraction,
// 2026-09-23). review-task.js resolves "is this task a decompose/candidate-split
// proposal, not an ordinary diff" through this overridable predicate instead of
// duplicating the same two-field check inline in more than one place -- a future
// hub-tasks plugin could supply its own detection (a different proposal shape) via
// setDecomposeProposalDetection() without review-task.js needing to know the field
// names. Single process-wide swap point, same reasoning as hub-apply-routing.js: a
// decompose/split proposal can arrive from any source (adhoc decompose, candidate-split
// hubs), so there's no one task-source registration to key it off of.

// Exactly today's inline check from review-task.js, unchanged: candidateSplitProposals
// (a candidate-fulfillment split, any source) or adhocResolution:'decompose' on a manual
// (adhoc) task.
function isDecomposeOrSplitProposal(task) {
  return !!(task && task.candidateSplitProposals)
    || !!(task && task.source === 'manual' && task.adhocResolution === 'decompose');
}

const DEFAULT_DECOMPOSE_PROPOSAL_DETECTION = { isDecomposeOrSplitProposal };

let current = DEFAULT_DECOMPOSE_PROPOSAL_DETECTION;

function getDecomposeProposalDetection() {
  return current;
}

// A single swap point, not a registry -- same discipline as hub-apply-routing.js.
// Passing no argument (or a falsy value) restores the default; used by tests to reset
// state between runs since this module is a singleton for the life of the process.
function setDecomposeProposalDetection(detection) {
  current = detection || DEFAULT_DECOMPOSE_PROPOSAL_DETECTION;
}

module.exports = {
  isDecomposeOrSplitProposal,
  DEFAULT_DECOMPOSE_PROPOSAL_DETECTION,
  getDecomposeProposalDetection,
  setDecomposeProposalDetection,
};
