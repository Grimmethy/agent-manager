'use strict';

// Content-safety rejections from the model (the safeguards / acceptable-use policy flag).
// A policy rejection is NOT an infrastructure outage: retrying the same prompt cannot succeed,
// so the draft-failure classifier must give up on it at once instead of requeueing it.
// Matches the message text only, never the HTTP status code (a policy flag can arrive on a 502).
// Pure: no I/O, no timers.

const POLICY_PATTERNS = [
  /safeguards flagged this message/i,
  /anthropic\.com\/legal\/aup/i,
];

function isContentPolicyFailure(...texts) {
  const text = texts.filter((t) => typeof t === 'string').join('\n');
  return POLICY_PATTERNS.some((re) => re.test(text));
}

module.exports = { isContentPolicyFailure };
