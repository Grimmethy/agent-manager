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

// Distinctive 2-3 word phrases from a line of text -- what it's actually ABOUT, e.g.
// "duplicate-instance race", "stranded-claim detection". Drops any n-gram without a real
// (>=5-char, non-stopword) content word, so a phrase means something. Extracted
// 2026-09-05 from staleness-audit.js's own task-shaped distinctivePhrases() (which grepped
// a phrase against a named file to detect "already implemented") for a second, different
// use: side-finding-sweep.js's dedup, where two independently-phrased findings about the
// SAME underlying observation can score LOW on whole-text Jaccard (confirmed live: 0.4,
// under the 0.6 threshold, for two obviously-the-same findings whose bodies differed in
// which specific fix each one suggested) while still reliably sharing a distinctive
// phrase from their titles. Jaccard alone is a bag-of-words signal that dilutes on any
// elaboration; a shared multi-word phrase is a much more precise "same topic" signal.
function distinctivePhrases(text) {
  const line = String(text || '').split('\n')[0].toLowerCase();
  const words = line.replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(Boolean);
  const phrases = new Set();
  for (let n = 3; n >= 2; n -= 1) {
    for (let i = 0; i + n <= words.length; i += 1) {
      const gram = words.slice(i, i + n);
      const contentful = gram.filter((w) => w.length >= 5 && !STOPWORDS.has(w));
      if (contentful.length >= 1 && gram.join(' ').length >= 8) phrases.add(gram.join(' '));
    }
  }
  return [...phrases].slice(0, 8);
}

function sharesDistinctivePhrase(a, b) {
  const phrasesA = distinctivePhrases(a);
  if (phrasesA.length === 0) return false;
  const phrasesB = new Set(distinctivePhrases(b));
  return phrasesA.some((p) => phrasesB.has(p));
}

module.exports = { normalizeTokens, jaccardSimilarity, distinctivePhrases, sharesDistinctivePhrase, STOPWORDS };
