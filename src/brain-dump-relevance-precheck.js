'use strict';

// Pure relevance pre-check for brain-dump entries. Given the raw entry text and an injected
// search(term) function, it decides whether the entry is worth a model pass at all.
//
// Checks run in this exact order (the order is what protects real findings):
//   (a) identifier bypass on the raw text: any token containing '_', '-', '/', ending in '.js',
//       or camelCase -> relevant:true, reason 'identifier-bypass', search is never called.
//   (b) tokenize: lowercase, split on non-alphanumerics, drop tokens shorter than 4 characters
//       and stop-words.
//   (c) deduplicate, keep the first 12 by position, and report droppedTermCount (distinct terms
//       beyond the cap) so the audit trail shows when terms were cut.
//   (d) fewer than 3 terms -> relevant:true, reason 'too-few-terms', search is never called.
//   (e) search(term) for each term. A throw -> relevant:true, reason 'search-error' (fail open).
//   (f) any hit -> relevant:true, reason 'hit'; otherwise relevant:false, reason 'zero-hits'.
//
// Fail-open rule: every uncertain path answers relevant:true. Only 'zero-hits' dismisses.
// The injected search must cover file paths as well as file contents, or path-only matches
// will be missed and 'zero-hits' would be wrong. The wiring step must confirm that before use.
//
// Trade-offs (recorded, not fixed here):
//   - Ordinary hyphenated prose such as 'pre-check' or 're-run' trips the identifier bypass.
//     That makes the check less selective but never causes a wrong drop.
//   - A real code term past the 12th distinct term can produce a 'zero-hits' dismissal;
//     droppedTermCount > 0 is the signal a caller can use to route such entries to a human.
//
// This module is pure: no filesystem, no processes, no timers, only rawText and search.

const MAX_TERMS = 12;
const MIN_TERMS = 3;
const MIN_TERM_LENGTH = 4;

// Short and generic on purpose, so domain words such as 'task', 'hub' or 'pipeline' are kept.
const STOP_WORDS = new Set([
  'that', 'this', 'with', 'from', 'have', 'been', 'were', 'will', 'would', 'should',
  'could', 'there', 'their', 'they', 'them', 'then', 'than', 'when', 'what', 'which',
  'where', 'while', 'about', 'into', 'over', 'also', 'just', 'only', 'some', 'more',
  'most', 'very', 'does', 'doing', 'make', 'made', 'need', 'needs', 'like', 'also',
]);

function hasIdentifierShape(token) {
  return /[_\-/]/.test(token) || /\.js$/i.test(token) || /[a-z][A-Z]/.test(token);
}

function brainDumpRelevancePrecheck(rawText, search) {
  const text = String(rawText == null ? '' : rawText);

  // (a) identifier bypass, on the raw text, before any tokenizing or searching
  const rawTokens = text.split(/\s+/).filter(Boolean);
  if (rawTokens.some(hasIdentifierShape)) {
    return { relevant: true, reason: 'identifier-bypass', checkedTerms: [], hitCounts: {}, droppedTermCount: 0 };
  }

  // (b) tokenize
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= MIN_TERM_LENGTH && !STOP_WORDS.has(t));

  // (c) deduplicate by first position, cap at 12, count what was dropped
  const distinct = [...new Set(tokens)];
  const checkedTerms = distinct.slice(0, MAX_TERMS);
  const droppedTermCount = Math.max(0, distinct.length - MAX_TERMS);

  // (d) too few terms to judge
  if (checkedTerms.length < MIN_TERMS) {
    return { relevant: true, reason: 'too-few-terms', checkedTerms, hitCounts: {}, droppedTermCount };
  }

  // (e) search each term; a throwing search fails open
  const hitCounts = {};
  try {
    for (const term of checkedTerms) {
      hitCounts[term] = search(term);
    }
  } catch {
    return { relevant: true, reason: 'search-error', checkedTerms, hitCounts, droppedTermCount };
  }

  // (f) any hit keeps the entry; zero hits across all terms dismisses it
  const anyHit = checkedTerms.some((term) => hitCounts[term] > 0);
  if (anyHit) {
    return { relevant: true, reason: 'hit', checkedTerms, hitCounts, droppedTermCount };
  }
  return { relevant: false, reason: 'zero-hits', checkedTerms, hitCounts, droppedTermCount };
}

module.exports = { brainDumpRelevancePrecheck };
