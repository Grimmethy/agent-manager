'use strict';

const { stripWhitespace, realIndexForStrippedIndex } = require('./candidate-doc-parsing.js');

// A stale Snippet still points at the right place. 2026-09-21 (PF/agent-manager needs-clarification clearing): four function_length_fix candidates (AC-5, AC-10, AC-11,
// AC-24) were escalated as "no reliable anchor" although their target functions were still in the cited files: the Snippet is a big block copied when the candidate was
// written, and a single comment or parameter added INSIDE it since then made the whole-snippet comparison fail, so the window fell back to blind head-truncation
// (anchorConfidence 'none') and every retry saw the same useless slice. A match on the snippet's PREFIX (or, when the drift is at the start, its SUFFIX) locates the
// same code just as well: only the position matters for windowing.
//
// Guards against noise: the piece must be at least MIN_PARTIAL_CHARS of whitespace-stripped text (several lines, never a lone `}` or `return;`) and must occur EXACTLY ONCE
// in the file; an ambiguous piece is never guessed at.
const MIN_PARTIAL_CHARS = 120;
const PARTIAL_FRACTIONS = [0.75, 0.5, 0.35, 0.25, 0.15];

function partialLengths(n) {
  const out = new Set();
  for (const f of PARTIAL_FRACTIONS) out.add(Math.floor(n * f));
  out.add(MIN_PARTIAL_CHARS);
  return [...out].filter((l) => l >= MIN_PARTIAL_CHARS && l < n).sort((a, b) => b - a);
}

function uniqueIndex(haystack, needle) {
  const i = haystack.indexOf(needle);
  if (i === -1) return -1;
  return haystack.indexOf(needle, i + 1) === -1 ? i : -2; // -2 = ambiguous
}

// -> { index, length, partial: 'prefix' | 'suffix' } | null, positions in the REAL (unstripped) content.
function findPartialMatch(content, strippedSnippet, strippedContent) {
  const n = strippedSnippet.length;
  if (n <= MIN_PARTIAL_CHARS) return null;
  for (const kind of ['prefix', 'suffix']) {
    for (const len of partialLengths(n)) {
      const piece = kind === 'prefix' ? strippedSnippet.slice(0, len) : strippedSnippet.slice(n - len);
      const at = uniqueIndex(strippedContent, piece);
      if (at === -2) break; // ambiguous at this length: shorter pieces only get more ambiguous, try the other end
      if (at === -1) continue;
      // Where the snippet would START: for a suffix match, back up by the part of the snippet that precedes it.
      const startStripped = kind === 'prefix' ? at : Math.max(0, at - (n - len));
      const realStart = realIndexForStrippedIndex(content, startStripped);
      const realEnd = realIndexForStrippedIndex(content, at + len);
      return { index: realStart, length: Math.max(realEnd - realStart, 1), partial: kind };
    }
  }
  return null;
}

function findFuzzyMatch(content, snippet) {
  const trimmed = (snippet || '').trim();
  if (!trimmed) return null;
  const idx = content.indexOf(trimmed);
  if (idx !== -1) return { index: idx, length: trimmed.length };

  const strippedSnippet = stripWhitespace(trimmed);
  if (!strippedSnippet) return null;
  const strippedContent = stripWhitespace(content);
  const strippedIdx = strippedContent.indexOf(strippedSnippet);
  if (strippedIdx === -1) return findPartialMatch(content, strippedSnippet, strippedContent);

  const realStart = realIndexForStrippedIndex(content, strippedIdx);
  const realEnd = realIndexForStrippedIndex(content, strippedIdx + strippedSnippet.length);
  return { index: realStart, length: Math.max(realEnd - realStart, 1) };
}

function windowAroundIndex(content, idx, matchLen, maxChars) {
  const half = Math.floor(maxChars / 2);
  const from = Math.max(0, idx - half);
  const to = Math.min(content.length, idx + matchLen + half);
  const windowed = content.slice(from, to);
  const prefix = from > 0 ? '...[truncated]...\n' : '';
  const suffix = to < content.length ? '\n...[truncated]' : '';
  return `${prefix}${windowed}${suffix}`;
}

module.exports = { findFuzzyMatch, windowAroundIndex, MIN_PARTIAL_CHARS };
