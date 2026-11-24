'use strict';

// Renders a failure value (string, number, Error, or plain object such as a command or test record) as readable text.
// Never returns '[object Object]'. Null, undefined, false and '' render as '' so callers can fall back with ||.

const DESCRIBE_KEYS = ['name', 'command', 'exitCode', 'file', 'criterion', 'reason', 'detail', 'message'];

function describeFailure(failure) {
  if (failure === null || failure === undefined || failure === false || failure === '') return '';
  if (typeof failure === 'string') return failure;
  if (typeof failure === 'number' || typeof failure === 'boolean' || typeof failure === 'bigint') return String(failure);
  if (failure instanceof Error) return failure.message || failure.name || 'Error';
  if (Array.isArray(failure)) {
    return failure.map((x) => describeFailure(x)).filter(Boolean).join(', ');
  }
  if (typeof failure === 'object') {
    const parts = [];
    for (const key of DESCRIBE_KEYS) {
      const v = failure[key];
      if (v === undefined || v === null || v === '') continue;
      const text = typeof v === 'object' ? safeJson(v) : String(v);
      if (text) parts.push(`${key}: ${text}`);
    }
    if (parts.length) return parts.join(', ');
    const json = safeJson(failure);
    return json || '(unrenderable failure)';
  }
  return String(failure);
}

function safeJson(value) {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? '' : json;
  } catch (_) {
    return '';
  }
}

module.exports = { describeFailure };
