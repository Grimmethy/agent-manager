'use strict';

// Shared infra-outage signature (HUB0592 1/6). This is the single source for the pattern that the
// draft and review workers inline in scripts/local-worker.sh (around line 401) and
// scripts/review-runner.sh (around line 389). Those inline copies stay in place for now; later
// subtasks wire them to this module.
//
// An EMPTY failure text is infra-shaped in the callers (a process killed before writing any output).
// isInfraBlockReason('') returns false on purpose, so callers must keep the empty-output rule themselves.
//
// The manual-pause pattern (MANUAL_PAUSE_PATTERN in local-worker.sh) is intentionally NOT here.

const INFRA_FAILURE_PATTERN = /timed out|ECONNREFUSED|ETIMEDOUT|EPIPE|fetch failed|econnreset|socket hang up|bad gateway|service unavailable|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|ENOTFOUND|model \x27[^\x27]*\x27 not found|\b50[0-9]\b/i;

// Give-up wording written once the bounded infra requeue budget is spent (draft and review).
const INFRA_GIVE_UP_RE = /did not clear even after \d+ requeue round\(s\)/;

// TODO: Apply: retry transient infra errors -- the grep for "transient infra" found no apply-timeout
// infra pattern (only comments and tests), so no pattern is defined here. Do not add one without a spec.

function isInfraBlockReason(text) {
  const s = String(text ?? '');
  if (!s.trim()) return false;
  return INFRA_FAILURE_PATTERN.test(s) || INFRA_GIVE_UP_RE.test(s);
}

module.exports = { INFRA_FAILURE_PATTERN, isInfraBlockReason };
