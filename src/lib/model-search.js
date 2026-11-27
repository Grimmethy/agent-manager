'use strict';

// Forgiving human lookup for model tags, workers, and queue items.
// Pure functions only: no timers, no I/O, no model calls.

// Lowercase, replace every run of non-letter/non-number characters
// (Unicode-aware) with a single space, and trim.
function normalizeModelSearch(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// Normalized form with all spaces removed, e.g. "qwen25coder".
function compactModelSearch(value) {
  return normalizeModelSearch(value).replace(/ /g, '');
}

// True when the query matches any candidate value, comparing either the
// space-normalized or the compacted form of the query against the same
// forms of each candidate. An empty query matches everything.
function matchesModelSearch(query, values) {
  const list = Array.isArray(values) ? values : [values];
  const q = normalizeModelSearch(query);
  const qc = compactModelSearch(query);
  if (!q) return true;
  return list.some((candidate) => {
    const v = normalizeModelSearch(candidate);
    const vc = compactModelSearch(candidate);
    return v.includes(q) || (qc !== '' && vc.includes(qc));
  });
}

module.exports = {
  normalizeModelSearch,
  compactModelSearch,
  matchesModelSearch,
};
