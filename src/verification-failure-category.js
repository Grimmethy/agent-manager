'use strict';

// Safe error description and verification failure classification.
// Self-contained: no timers, polls, network, child_process, or filesystem access.

function safeString(value) {
  try {
    return String(value);
  } catch (_err) {
    return '';
  }
}

// Returns a readable string for any value. Never returns the literal '[object Object]'.
// Order: string as-is -> .message -> .stack -> JSON.stringify -> String(value) -> fixed placeholder.
function describeError(value) {
  if (typeof value === 'string') return value;

  if (value !== null && value !== undefined) {
    if (typeof value.message === 'string' && value.message) return value.message;
    if (typeof value.stack === 'string' && value.stack) return value.stack;
  }

  try {
    const json = JSON.stringify(value);
    if (typeof json === 'string' && json) return json;
  } catch (_err) {
    // Circular structures and BigInt values throw; fall through.
  }

  const text = safeString(value);
  if (text && text !== '[object Object]') return text;

  return 'unknown error';
}

// Classifies a verification failure entry.
// - 'module-load': a unittest _FailedTest, or an ImportError with no completed test run.
// - 'assertion': a test ran and was marked failed.
// - 'unknown': anything else (extrapolated beyond the spec; documented here on purpose).
// The entry shape is not fully confirmed; the checks below use the most likely fields.
function classifyVerificationFailure(entry) {
  if (!entry || typeof entry !== 'object') return 'unknown';

  const ctor = entry.constructor;
  if (ctor && ctor.name === '_FailedTest') return 'module-load';

  const text = [entry.message, entry.stack, entry.error]
    .map((part) => (typeof part === 'string' ? part : ''))
    .join('\n');
  const testRan = entry.ran === true;
  if (/ImportError/.test(text) && !testRan) return 'module-load';

  if (entry.outcome === 'failed' || entry.status === 'failed') return 'assertion';

  return 'unknown';
}

module.exports = { describeError, classifyVerificationFailure };
