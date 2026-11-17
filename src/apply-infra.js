'use strict';

// Shared infra-vs-content classifier for git apply failures, plus a bounded retry wrapper.
//
// Decision (recorded here, not in code): the 60000 ms git-runner fetch ceiling stays UNCHANGED.
// Evidence: under load (load average ~14) an `ls-remote` took 0.77 s, and the SAME apply
// succeeded ~90 s later. The timeout under load is the signal; retrying with backoff is the
// fix, not raising the ceiling.
//
// INFRA_APPLY_RE mirrors INFRA_FAILURE_PATTERN in scripts/review-runner.sh (the pattern
// family for transient infra failures). It deliberately excludes git apply / --3way
// conflicts, stale patches, and acceptance-gate failures: those are content failures and
// must never be retried.

const INFRA_APPLY_RE = /timed out after \d+ms|ETIMEDOUT|ECONNRESET|EAI_AGAIN|index\.lock|lock timeout|single-flight lock|apply lock timed? ?out/i;

// Total 180 s of backoff across three retries.
const APPLY_INFRA_DELAYS_MS = [15000, 45000, 120000];

function classifyApplyFailure(reason) {
  if (typeof reason !== 'string') return 'content';
  return INFRA_APPLY_RE.test(reason) ? 'infra' : 'content';
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// applyOnce() must resolve to an object with `succeeded` (boolean) and, on failure, `reason`.
// Returns the final result spread with infraRetries (retries made) and infraExhausted
// (true only when every allowed retry was spent on an infra failure).
async function applyWithInfraRetry(applyOnce, { delays = APPLY_INFRA_DELAYS_MS, sleep = defaultSleep, onRetry } = {}) {
  let infraRetries = 0;
  for (;;) {
    const result = await applyOnce();
    if (result && result.succeeded) {
      return { ...result, infraRetries, infraExhausted: false };
    }
    const reason = result ? result.reason : undefined;
    if (classifyApplyFailure(reason) !== 'infra') {
      return { ...result, infraRetries, infraExhausted: false };
    }
    if (infraRetries >= delays.length) {
      return { ...result, infraRetries, infraExhausted: true };
    }
    const delayMs = delays[infraRetries];
    if (typeof onRetry === 'function') {
      onRetry({ attempt: infraRetries + 1, delayMs, reason });
    }
    await sleep(delayMs);
    infraRetries += 1;
  }
}

module.exports = {
  INFRA_APPLY_RE,
  classifyApplyFailure,
  APPLY_INFRA_DELAYS_MS,
  applyWithInfraRetry,
};
