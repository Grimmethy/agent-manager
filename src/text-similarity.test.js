'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeTokens, jaccardSimilarity } = require('./text-similarity.js');

test('normalizeTokens lowercases, strips punctuation, and drops short/stopwords', () => {
  const tokens = normalizeTokens('The Agent Manager should Fix a real BUG in queue-watcher.sh!');
  assert.equal(tokens.has('agent'), false, 'stopword');
  assert.equal(tokens.has('manager'), false, 'stopword');
  assert.equal(tokens.has('fix'), false, 'stopword');
  assert.equal(tokens.has('real'), true);
  assert.equal(tokens.has('bug'), true);
  assert.equal(tokens.has('queue'), true);
  assert.equal(tokens.has('watcher'), true);
  assert.equal(tokens.has('sh'), false, 'length <= 2 is dropped, not just stopwords');
  assert.equal(tokens.has('to'), false, 'stopword');
  assert.equal(tokens.has('a'), false, 'stopword');
});

test('jaccardSimilarity is 0 for disjoint sets and 1 for identical sets', () => {
  assert.equal(jaccardSimilarity(new Set(['a', 'b']), new Set(['c', 'd'])), 0);
  assert.equal(jaccardSimilarity(new Set(['a', 'b']), new Set(['a', 'b'])), 1);
});

test('jaccardSimilarity handles an empty set without throwing', () => {
  assert.equal(jaccardSimilarity(new Set(), new Set(['a'])), 0);
  assert.equal(jaccardSimilarity(new Set(), new Set()), 0);
});

test('jaccardSimilarity: partial overlap lands strictly between 0 and 1', () => {
  const sim = jaccardSimilarity(new Set(['a', 'b', 'c']), new Set(['b', 'c', 'd']));
  assert.equal(sim, 0.5); // intersection {b,c}=2, union {a,b,c,d}=4
});

test('two near-duplicate real-world sentences score high similarity', () => {
  const a = normalizeTokens('The queue-watcher script silently swallows a bwrap sandbox timeout error');
  const b = normalizeTokens('queue-watcher silently swallows the bwrap sandbox timeout');
  assert.ok(jaccardSimilarity(a, b) > 0.6, 'near-identical phrasing should score well above the 0.6 dup threshold');
});

test('two unrelated sentences score low similarity', () => {
  const a = normalizeTokens('The dashboard chat panel truncates long responses silently');
  const b = normalizeTokens('Tesla P40 fan RPM sensor reads zero after a cold boot');
  assert.ok(jaccardSimilarity(a, b) < 0.2, 'genuinely unrelated text should score well below the 0.6 dup threshold');
});
