'use strict';

// Draft-retry policy: pure helpers for computing retry delays and attempt limits per
// failure class. No side effects, no timers, no re-arming loops -- just math.
//
// The "delay source" parameter lets tests inject their own delay provider (e.g., a
// function returning 0) so retry logic can be exercised without real waits. Production
// code passes the default exponential backoff; tests pass a no-op.
//
// Failure classes:
//   - 'transient-infra': infrastructure flakiness (network, DNS, etc.) -- retryable, capped
//   - 'claude-exit-1': Claude API exit code 1 (transient model error) -- retryable, capped
//   - 'content-rejection': content policy rejection -- unlimited retries (human may fix content)
//
// Delay formula: baseMs * 2^(attemptN - 1), capped at capMs
//   attempt 1: baseMs (2000ms)
//   attempt 2: baseMs * 2 (4000ms)
//   attempt 3: baseMs * 4 (8000ms)
//   ... capped at capMs (30000ms)

const DEFAULT_BASE_MS = 2000;
const DEFAULT_CAP_MS = 30000;
const MAX_ATTEMPTS = 10;

// Default delay source: exponential backoff
function defaultDelaySource() {
  return (attemptN, { baseMs, capMs } = {}) => {
    const base = baseMs || DEFAULT_BASE_MS;
    const cap = capMs || DEFAULT_CAP_MS;
    const exponent = Math.max(0, attemptN - 1);
    const delay = base * Math.pow(2, exponent);
    return Math.min(delay, cap);
  };
}

// Compute delay for attempt N
function computeDelay(attemptN, options = {}) {
  const { delaySource, baseMs, capMs } = options;
  const source = delaySource || defaultDelaySource();
  return source(attemptN, { baseMs, capMs });
}

// Attempt limit per failure class (undefined = unlimited)
function attemptLimitForClass(failureClass) {
  switch (failureClass) {
    case 'transient-infra':
    case 'claude-exit-1':
      return MAX_ATTEMPTS;
    case 'content-rejection':
      return undefined; // unlimited
    default:
      return undefined; // unknown class, no limit
  }
}

module.exports = {
  computeDelay,
  attemptLimitForClass,
  defaultDelaySource,
  DEFAULT_BASE_MS,
  DEFAULT_CAP_MS,
  MAX_ATTEMPTS,
};
