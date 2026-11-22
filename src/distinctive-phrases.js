'use strict';

// Distinctive-phrase extraction, split out of text-similarity.js so phrase extraction
// (what a line is ABOUT) is decoupled from the Jaccard/token-set primitives and from
// side-finding-sweep.js's dedup. text-similarity.js re-exports these names for existing callers.

const STOPWORDS = new Set(('a an the and or of to in for on with is are be it this that '
  + 'add fix agent manager we i need should must task').split(' '));

// Distinctive 2-3 word phrases from text -- what it's actually ABOUT, e.g.
// "duplicate-instance race", "stranded-claim detection". Drops any n-gram without a real
// (>=5-char, non-stopword) content word, so a phrase means something.
//
// By default only the FIRST line of the input is inspected (every current caller slices to
// its own first line anyway). Pass { multiLine: true } to inspect all lines: n-grams are
// then built per line so no phrase spans a newline. The result is capped at 8 phrases.
function distinctivePhrases(text, { multiLine = false } = {}) {
  const raw = String(text || '').toLowerCase();
  const lines = multiLine ? raw.split('\n') : [raw.split('\n')[0]];
  const phrases = new Set();
  for (const line of lines) {
    const words = line.replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(Boolean);
    for (let n = 3; n >= 2; n -= 1) {
      for (let i = 0; i + n <= words.length; i += 1) {
        const gram = words.slice(i, i + n);
        const contentful = gram.filter((w) => w.length >= 5 && !STOPWORDS.has(w));
        if (contentful.length >= 1 && gram.join(' ').length >= 8) phrases.add(gram.join(' '));
      }
    }
  }
  return [...phrases].slice(0, 8);
}

// True when a and b share at least one distinctive phrase. Accepts the same
// { multiLine } option as distinctivePhrases (default: first line only).
function sharesDistinctivePhrase(a, b, options) {
  const phrasesA = distinctivePhrases(a, options);
  if (phrasesA.length === 0) return false;
  const phrasesB = new Set(distinctivePhrases(b, options));
  return phrasesA.some((p) => phrasesB.has(p));
}

module.exports = { distinctivePhrases, sharesDistinctivePhrase, STOPWORDS };
