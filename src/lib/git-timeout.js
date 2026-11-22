'use strict';

// git-timeout.js -- the one place the per-call git time limit is read (ADR-0024 follow-up).
//
// Measured 2026-11-03: apply blocked five times with "git fetch origin master timed out after 60000ms" while the shared disk's I/O pressure sat at 85-90%; the 60 s limit was a
// constant copied into src/git-runner.js, src/agentic-draft-common.js and src/apply-adhoc-diff.js with no way to raise it. AGENT_MANAGER_GIT_TIMEOUT_MS overrides it (default
// 60000, floor 5000 so a typo cannot turn every git call into an instant timeout). src/git-runner.js additionally retries a timed-out fetch once with a longer limit.

const DEFAULT_GIT_TIMEOUT_MS = 60_000;
const MIN_GIT_TIMEOUT_MS = 5_000;

function gitTimeoutMs(env = process.env) {
  const n = Number(env.AGENT_MANAGER_GIT_TIMEOUT_MS);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_GIT_TIMEOUT_MS;
  return Math.max(MIN_GIT_TIMEOUT_MS, Math.floor(n));
}

module.exports = { gitTimeoutMs, DEFAULT_GIT_TIMEOUT_MS, MIN_GIT_TIMEOUT_MS };
