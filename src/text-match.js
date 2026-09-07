'use strict';

// Extracted from grep-codebase-tool.js (2026-09-07) so search_tasks (local-tool-client.js)
// can reuse the exact same matcher instead of a second, possibly-inconsistent
// implementation. See grep-codebase-tool.js's own header for why the fallback exists:
// a full English phrase like "draft create review gate" almost never appears as a
// literal substring, so a stricter exact match is tried first and this falls back to
// "every token appears somewhere in the text, any order, case-insensitive" only once
// that fails -- a literal single-token or exact-name query still gets the tightest
// possible match first.
function lineMatches(line, query) {
  if (line.includes(query)) return true;
  const lowerLine = line.toLowerCase();
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return false;
  return tokens.every((t) => lowerLine.includes(t));
}

module.exports = { lineMatches };
