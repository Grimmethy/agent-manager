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

// Where does the snippet's own HEAD sit in the file, at or before `beforeIndex` (within HEAD_LOOKBACK_CHARS)? Two stable anchors, in order:
//   1. the DECLARED NAME of the function/class/def the snippet starts with, when exactly one declaration of that name exists in the file (the name survives a signature edit and a
//      block inserted right after it, which is what breaks the exact-text matches);
//   2. otherwise the snippet's first line with real content (>= 25 chars trimmed), when that exact text occurs exactly ONCE in the file.
// Absent or ambiguous -> -1 (the caller keeps its estimate). Never guesses between several.
const HEAD_LOOKBACK_CHARS = 40000;
const DECL_RES = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:async\s+)?def\s+([A-Za-z_]\w*)/,
  /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/,
];
function headLineIndex(content, rawSnippet, beforeIndex) {
  if (!rawSnippet) return -1;
  const within = (i) => (i !== -1 && i <= beforeIndex && beforeIndex - i <= HEAD_LOOKBACK_CHARS ? i : -1);
  const lines = String(rawSnippet).split('\n').slice(0, 12);
  // 1. the DECLARATION the snippet starts with (its name survives a signature edit and an insertion right after it)
  for (const raw of lines) {
    for (const re of DECL_RES) {
      const m = re.exec(raw);
      if (!m) continue;
      const decl = new RegExp(re.source.replace('([A-Za-z_$][\\w$]*)', m[1].replace(/[$]/g, '\\$&')).replace('([A-Za-z_]\\w*)', m[1]), 'gm');
      const found = [...content.matchAll(decl)];
      if (found.length === 1) return within(found[0].index + found[0][0].search(/\S|$/));
      return -1; // several declarations of that name: never pick one
    }
  }
  // 2. no declaration in the head: its first line with real content, when that exact text occurs exactly once
  const first = lines.map((l) => l.trim()).find((l) => l.length >= 25);
  if (first) {
    const i = content.indexOf(first);
    if (i !== -1 && content.indexOf(first, i + 1) === -1) return within(i);
  }
  return -1;
}

// -> { index, length, partial: 'prefix' | 'suffix' } | null, positions in the REAL (unstripped) content.
function findPartialMatch(content, strippedSnippet, strippedContent, rawSnippet) {
  const n = strippedSnippet.length;
  if (n <= MIN_PARTIAL_CHARS) return null;
  for (const kind of ['prefix', 'suffix']) {
    for (const len of partialLengths(n)) {
      const piece = kind === 'prefix' ? strippedSnippet.slice(0, len) : strippedSnippet.slice(n - len);
      const at = uniqueIndex(strippedContent, piece);
      if (at === -2) break; // ambiguous at this length: shorter pieces only get more ambiguous, try the other end
      if (at === -1) continue;
      // Where the snippet would START. A prefix match starts exactly there. For a suffix match the part of the snippet BEFORE it drifted, so backing up by its old length is only
      // an estimate and is wrong when that part has since grown (function-length-fix-ac-37: the estimate landed 94 lines late and the window missed the function). Prefer the snippet's
      // own first distinctive line when it occurs exactly once shortly before the match; fall back to the estimate.
      const pieceStart = realIndexForStrippedIndex(content, at);
      const realEnd = realIndexForStrippedIndex(content, at + len);
      let realStart = kind === 'prefix' ? pieceStart : realIndexForStrippedIndex(content, Math.max(0, at - (n - len)));
      if (kind === 'suffix') {
        const head = headLineIndex(content, rawSnippet, pieceStart);
        if (head !== -1) realStart = head;
      }
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
  if (strippedIdx === -1) return findPartialMatch(content, strippedSnippet, strippedContent, trimmed);

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
