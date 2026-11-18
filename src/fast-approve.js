'use strict';

// Fast-approve mode for the review pipeline: readFastApproveMode picks the mode from env,
// fastApproveDecision decides whether a first APPROVE vote with enough reasoning could be
// accepted without a full majority vote, and appendShadowRecord logs what the decision
// would have been so it can be compared against the real verdict.

const fs = require('fs');
const path = require('path');

const SHADOW_LOG_PATH = path.join(__dirname, '..', 'data', 'review-fast-approve-shadow.jsonl');

// Exact, case-sensitive match. Unset, empty, or unrecognised values mean 'off'.
function readFastApproveMode(env) {
  const raw = env && env.AGENT_MANAGER_REVIEW_FAST_APPROVE;
  if (raw === 'shadow' || raw === 'on') return raw;
  return 'off';
}

// Returns true only for a first vote of APPROVE whose reasoning, measured after trimming
// surrounding whitespace, is at least minReasoningChars long. Missing or non-numeric
// minReasoningChars returns false rather than guessing a default.
function fastApproveDecision({ firstVote, reasoning, minReasoningChars }) {
  if (firstVote !== 'APPROVE') return false;
  if (typeof reasoning !== 'string') return false;
  if (typeof minReasoningChars !== 'number') return false;
  return reasoning.trim().length >= minReasoningChars;
}

// Appends one JSON line to the shadow log, creating data/ if it is missing.
function appendShadowRecord(record) {
  fs.mkdirSync(path.dirname(SHADOW_LOG_PATH), { recursive: true });
  fs.appendFileSync(SHADOW_LOG_PATH, JSON.stringify(record) + '\n');
}

module.exports = { readFastApproveMode, fastApproveDecision, appendShadowRecord };
