'use strict';

// Test-only helper: polls read() until it returns a non-undefined value, or until the deadline
// and attempt limit are reached. Used only inside node:test processes.

async function pollWithTimeout(read, { timeoutMs, intervalMs = 20, message = 'pollWithTimeout: condition not met' } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('pollWithTimeout: timeoutMs must be a finite positive number');
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new TypeError('pollWithTimeout: intervalMs must be a finite positive number');
  }
  const deadline = Date.now() + timeoutMs;
  const maxAttempts = Math.floor(timeoutMs / intervalMs) + 1;
  // poll-ok: test-only bounded wait with deadline and attempt limit; runs only inside node:test processes, never in the idle system
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  const err = new Error(`${message} (timed out after ${timeoutMs}ms)`);
  err.name = 'PollTimeoutError';
  throw err;
}

module.exports = { pollWithTimeout };
