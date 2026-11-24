'use strict';

// describe-failure.js -- turns any failure value (thrown or returned) into readable text.
//
// NO-COERCION RULE: never String()-coerce or template-interpolate an object. Doing so
// yields "[object Object]", which hides the real message. Objects are read field by field;
// anything that cannot be read that way falls back to a length-capped JSON.stringify.

const JSON_MAX_LEN = 500;
const UNPRINTABLE = '<unprintable>';
const MESSAGE_FIELDS = ['message', 'error', 'failure', 'output'];

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

function describeFailure(value) {
  // Error: "name: message" plus the first stack frame (the line after the header).
  if (value instanceof Error) {
    const name = isNonEmptyString(value.name) ? value.name : 'Error';
    const message = typeof value.message === 'string' ? value.message : '';
    const header = message ? `${name}: ${message}` : name;
    const stackLines = typeof value.stack === 'string' ? value.stack.split('\n') : [];
    const frame = stackLines.slice(1).map((l) => l.trim()).find((l) => l !== '');
    return frame ? `${header}\n${frame}` : header;
  }

  // string: returned unchanged.
  if (typeof value === 'string') return value;

  // plain object (non-null, non-array): first usable field, then name.
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of MESSAGE_FIELDS) {
      const field = value[key];
      if (isNonEmptyString(field)) return field;
      // A nested Error recurses once; describeFailure(Error) never recurses again.
      if (field instanceof Error) return describeFailure(field);
    }
    if (isNonEmptyString(value.name)) return value.name;
  }

  // Anything else: JSON, capped. Never coerce with String() or template literals.
  let json;
  try {
    json = JSON.stringify(value);
  } catch {
    return UNPRINTABLE;
  }
  if (typeof json !== 'string') return UNPRINTABLE;
  return json.length > JSON_MAX_LEN ? `${json.slice(0, JSON_MAX_LEN - 1)}…` : json;
}

module.exports = { describeFailure };
