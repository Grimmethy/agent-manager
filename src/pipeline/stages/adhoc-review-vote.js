'use strict';

// Adhoc review-vote stage: routes one review-vote request through the auto-approve gate
// and records the outcome on the task's history.
//
// decide() in src/gate/auto-approve.js is async and never rejects, so this stage awaits
// it exactly once per request. Approval records 'gate.auto-approved'; every other outcome
// (a non-approval, a malformed result, or a thrown error) records 'gate.failed'.

const { decide } = require('../../gate/auto-approve');
const { appendHistoryEvent } = require('../../task-history');

async function runAdhocReviewVote(task, request) {
  let result;
  try {
    result = await decide(request);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    appendHistoryEvent(task, 'gate.failed', 'decide threw: ' + message);
    return { approved: false, reason: 'gate-threw: ' + message };
  }

  if (result && result.approved === true) {
    appendHistoryEvent(task, 'gate.auto-approved', 'gate approved review-vote request');
    return result;
  }

  const reason = result && typeof result.reason === 'string' ? result.reason : 'malformed-gate-result';
  appendHistoryEvent(task, 'gate.failed', 'gate did not approve: ' + reason);
  return result && typeof result === 'object' ? result : { approved: false, reason };
}

module.exports = { runAdhocReviewVote };
