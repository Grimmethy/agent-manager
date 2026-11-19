'use strict';
// Pure module: no filesystem, git, network, or model calls.
// Flags reviewer quotes that do not appear in the implement response.

const MIN_SPAN = 12;
const QUOTE = 34;
const BACKSLASH = 92;

function normalize(s) {
  return String(s).replace(/\s+/g, ' ').trim().toLowerCase();
}

function extractDoubleQuoted(text) {
  const spans = [];
  let i = 0;
  while (i < text.length) {
    if (text.charCodeAt(i) !== QUOTE) { i++; continue; }
    let j = i + 1;
    while (j < text.length && text.charCodeAt(j) !== QUOTE) {
      j += text.charCodeAt(j) === BACKSLASH ? 2 : 1;
    }
    if (j >= text.length) break;
    spans.push(text.slice(i + 1, j));
    i = j + 1;
  }
  return spans;
}

function detectReviewerHallucination(reviewerText, implementResponse) {
  const text = typeof reviewerText === 'string' ? reviewerText : '';
  const response = normalize(typeof implementResponse === 'string' ? implementResponse : '');
  const checkable = extractDoubleQuoted(text).filter((span) => normalize(span).length >= MIN_SPAN);
  if (checkable.length === 0) return { hallucinated: false, checked: 0, missing: [] };
  const missing = checkable.filter((span) => !response.includes(normalize(span)));
  return { hallucinated: missing.length > 0, checked: checkable.length, missing };
}

module.exports = { detectReviewerHallucination };
