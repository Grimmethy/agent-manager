'use strict';

// Pure, dependency-free helpers for turning test failures into readable text.
// normalizeFailure reads object fields explicitly and never coerces an object
// to a string. extractResourceWarnings output is informational only and must
// never feed a pass/fail verdict.

function asText(value) {
  return typeof value === 'string' ? value : '';
}

function normalizeFailure(raw) {
  if (typeof raw === 'string') {
    return { testId: '', message: raw, traceback: '' };
  }
  if (raw === null || typeof raw !== 'object') {
    return { testId: '', message: '', traceback: '' };
  }
  const err = raw.err !== null && typeof raw.err === 'object' ? raw.err : null;
  const testId = asText(raw.testId) || asText(raw.name);
  let message = asText(raw.message);
  if (!message) {
    if (typeof raw.err === 'string') {
      message = raw.err;
    } else if (err) {
      message = asText(err.message);
    }
  }
  const traceback = asText(raw.stack) || (err ? asText(err.stack) : '');
  return { testId, message, traceback };
}

function renderFailures(list) {
  if (!Array.isArray(list) || list.length === 0) {
    return '';
  }
  return list
    .map((item) => {
      const f = normalizeFailure(item);
      return `Test: ${f.testId}\nMessage: ${f.message}\nTraceback:\n${f.traceback}`;
    })
    .join('\n\n');
}

function summarizeFailingTests(list) {
  if (!Array.isArray(list) || list.length === 0) {
    return '';
  }
  const names = list
    .map((item) => normalizeFailure(item).testId)
    .filter((id) => id !== '');
  return `Failing tests: ${names.length > 0 ? names.join(', ') : '(unnamed)'}`;
}

function extractResourceWarnings(stderrText) {
  if (typeof stderrText !== 'string') {
    return [];
  }
  return stderrText.split(/\r?\n/).filter((line) => line.includes('ResourceWarning'));
}

module.exports = {
  normalizeFailure,
  renderFailures,
  summarizeFailingTests,
  extractResourceWarnings,
};
