'use strict';

// implementation-shape.js -- pure predicate: does a response contain the SHAPE of an implementation?
//
// Returns true when the output carries one of:
//   - a unified diff header (`diff --git`, `--- a/` / `+++ b/`) or a hunk header (`@@ ... @@`), including inside a code fence;
//   - a fenced JSON block that parses as a structured Group B change (see lib/structured-change.js);
//   - a fenced JSON block that parses as a structured no-change block.
// No parser for the no-change block exists in the repo, so per the fallback rule any fenced JSON block counts.
// Pure string analysis: no timers, no model calls, no git. Never throws; non-string input returns false.

const { isStructuredGroupBChange } = require('./lib/structured-change.js');

const DIFF_PATTERNS = [
  /^diff\s+--git\s/m,
  /^--- (?:a\/|\/dev\/null)/m,
  /^\+\+\+ (?:b\/|\/dev\/null)/m,
  /^@@ [^\n]*@@/m,
];

// Captures ```lang\n body ``` blocks. Language tag is optional; only json or untagged blocks are considered.
const FENCE_RE = /```([A-Za-z0-9_-]*)[ \t]*\n([\s\S]*?)```/g;

function hasDiffShape(output) {
  return DIFF_PATTERNS.some((re) => re.test(output));
}

function fencedJsonBodies(output) {
  const bodies = [];
  for (const m of output.matchAll(FENCE_RE)) {
    const lang = (m[1] || '').toLowerCase();
    if (lang !== '' && lang !== 'json') continue;
    const body = m[2].trim();
    if (body[0] === '{' || body[0] === '[') bodies.push(body);
  }
  return bodies;
}

function hasImplementationShape(output) {
  try {
    if (typeof output !== 'string') return false;
    if (hasDiffShape(output)) return true;
    const bodies = fencedJsonBodies(output);
    if (bodies.some((body) => isStructuredGroupBChange(body))) return true;
    // No structured no-change parser exists in the repo: fall back to any fenced JSON block.
    return bodies.length > 0;
  } catch {
    return false;
  }
}

module.exports = { hasImplementationShape };
