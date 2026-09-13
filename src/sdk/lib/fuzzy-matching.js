'use strict';

const { stripWhitespace, realIndexForStrippedIndex } = require('./candidate-doc-parsing.js');

function findFuzzyMatch(content, snippet) {
  const trimmed = (snippet || '').trim();
  if (!trimmed) return null;
  const idx = content.indexOf(trimmed);
  if (idx !== -1) return { index: idx, length: trimmed.length };

  const strippedSnippet = stripWhitespace(trimmed);
  if (!strippedSnippet) return null;
  const strippedContent = stripWhitespace(content);
  const strippedIdx = strippedContent.indexOf(strippedSnippet);
  if (strippedIdx === -1) return null;

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

module.exports = { findFuzzyMatch, windowAroundIndex };
