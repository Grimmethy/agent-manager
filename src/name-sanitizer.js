'use strict';

// Deterministic first-name-only pass for content entering shared/indexed stores.
// The map is explicit so every replacement is auditable. Unlisted names are untouched.
const FULL_NAME_TO_FIRST = [
  ['Natassa Gelinas', 'Natassa'],
  ['Scott Snofke', 'Scott'],
];

// Names are plain letters, so whitespace between the two parts may vary (space, double space, newline).
const PATTERNS = FULL_NAME_TO_FIRST.map(([full, first]) => ({
  re: new RegExp(full.split(/\s+/).join('\\s+'), 'g'),
  first,
}));

function sanitizeNames(text) {
  if (typeof text !== 'string') return text;
  let out = text;
  for (const { re, first } of PATTERNS) out = out.replace(re, first);
  return out;
}

function sanitizeDeep(value) {
  if (typeof value === 'string') return sanitizeNames(value);
  if (Array.isArray(value)) return value.map(sanitizeDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitizeDeep(v);
    return out;
  }
  return value;
}

module.exports = { sanitizeNames, sanitizeDeep, FULL_NAME_TO_FIRST };
