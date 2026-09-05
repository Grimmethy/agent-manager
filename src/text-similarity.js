'use strict';

// Shared, cheap, deterministic (no LLM call) text-similarity primitives -- token-set
// normalization + Jaccard overlap. Extracted 2026-09-05 from staleness-audit.js's own
// normalizeTaskTokens/jaccard (which compared two TASK objects) so a second consumer
// (side-finding-sweep.js, comparing raw finding text against other raw finding text)
// doesn't need a third near-duplicate copy of the same ~15 lines. staleness-audit.js's
// own task-shaped wrapper stays there -- this module only ever sees plain strings.

const STOPWORDS = new Set(('a an the and or of to in for on with is are be it this that '
  + 'add fix agent manager we i need should must task').split(' '));

// Lowercases, strips non-alphanumerics, drops words of length <=2 and the stopword set,
// returns a Set of the remaining tokens.
function normalizeTokens(text) {
  const lower = String(text || '').toLowerCase();
  return new Set(
    lower.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

function jaccardSimilarity(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

module.exports = { normalizeTokens, jaccardSimilarity, STOPWORDS };
