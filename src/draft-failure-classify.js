'use strict';

// Draft-failure classifier: categorises a raw error string into one of four buckets so the
// retry / escalation policy can act on it.
//
// Check order (deliberate):
//   1. Safeguard / content-policy flag  → 'content-rejection'
//   2. Claude exit-code 1                → 'claude-exit-1'
//   3. Ollama HTTP 502 / connection err  → 'transient-infra'
//   4. Anything else (incl. non-string)  → 'unknown'
//
// The safeguard check runs BEFORE the exit-code and 502 checks because a content-policy
// rejection can be delivered on an HTTP 502 (see src/content-policy.js). If we checked the
// 502 first we would misclassify a policy stop as a transient outage and retry a prompt
// that will never succeed.
//
// Pure: no I/O, no timers, no model calls.

const { isContentPolicyFailure } = require('./content-policy.js');

// A short safeguard marker that is NOT covered by the longer pattern in content-policy.js
// (which requires the full phrase "safeguards flagged this message").
const SAFEGUARD_MARKER = /safeguards flagged/i;

// "claude exited with code 1" but not "code 10", "code 127", etc.
const EXIT_1_PATTERN = /claude exited with code 1\b/i;

// Broad catch-all for Ollama HTTP 502 and Node-level connection failures.
// Contains no host, port, or model-config references.
const INFRA_PATTERN = /(\b502\b|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENOTFOUND|socket hang up|fetch failed|Ollama HTTP)/i;

/**
 * Classify a draft-failure error string.
 * @param {unknown} errorText
 * @returns {'content-rejection' | 'claude-exit-1' | 'transient-infra' | 'unknown'}
 */
function classifyDraftFailure(errorText) {
  if (typeof errorText !== 'string' || errorText.length === 0) {
    return 'unknown';
  }

  // 1. Safeguard / content-policy flag first (highest precedence).
  if (isContentPolicyFailure(errorText) || SAFEGUARD_MARKER.test(errorText)) {
    return 'content-rejection';
  }

  // 2. Claude exit code 1.
  if (EXIT_1_PATTERN.test(errorText)) {
    return 'claude-exit-1';
  }

  // 3. Ollama HTTP 502 / connection error.
  if (INFRA_PATTERN.test(errorText)) {
    return 'transient-infra';
  }

  // 4. Anything else.
  return 'unknown';
}

module.exports = { classifyDraftFailure };
