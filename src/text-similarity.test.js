'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeTokens, jaccardSimilarity, distinctivePhrases, sharesDistinctivePhrase } = require('./text-similarity.js');

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

// --- distinctivePhrases / sharesDistinctivePhrase (2026-09-05) ----------------------
// Root-caused live: a real dedup failure in side-finding-sweep.js let ~30 near-duplicate
// findings through because their full-text Jaccard similarity (0.4) sat below the 0.6
// threshold, even though every one was obviously "the same underlying observation,
// differently elaborated" to a human -- each project_search task independently
// paraphrased the same CONTEXT.md passage with a different suggested fix. A shared
// distinctive multi-word phrase from the title is a much more precise signal for exactly
// this failure mode.

test('distinctivePhrases extracts the real, obviously-distinctive phrase from a title', () => {
  const phrases = distinctivePhrases('Duplicate-instance race is still unfixed in code');
  assert.ok(phrases.includes('duplicate-instance race'));
});

test('distinctivePhrases drops phrases with no real content word', () => {
  const phrases = distinctivePhrases('is a of the');
  assert.deepEqual(phrases, []);
});

test('sharesDistinctivePhrase: two independently-worded titles about the same finding share a phrase even though their full bodies score well under the 0.6 Jaccard threshold', () => {
  const a = 'Duplicate-instance race is still unfixed in code';
  const b = 'Duplicate-instance race has no code fix as of 2026-07-19';
  assert.equal(sharesDistinctivePhrase(a, b), true);
  // Confirms the real gap this fixes: whole-text similarity alone would have missed it.
  const bodyA = normalizeTokens(`${a} The CONTEXT.md notes the duplicate-instance bug was root-caused on 2026-07-19 but not yet fixed in code. If a fix hasn't landed since, the queue-watchdog auto-restart path remains a live data-corruption risk.`);
  const bodyB = normalizeTokens(`${b} The CONTEXT.md notes the duplicate-instance root cause (manual restart racing queue-watchdog) was identified on 2026-07-19 but not yet fixed in code. If the fix is still pending, the heartbeat file is a single-writer assumption.`);
  assert.ok(jaccardSimilarity(bodyA, bodyB) < 0.6, 'sanity check: this exact real-world pair genuinely fails the old threshold');
});

test('sharesDistinctivePhrase: two genuinely different findings share no phrase, even when both mention generic shared pipeline vocabulary', () => {
  const a = 'Duplicate-instance race is still unfixed in code';
  const b = 'Stranded-claim detection is a known blind spot with no automated fix';
  assert.equal(sharesDistinctivePhrase(a, b), false);
});

test('sharesDistinctivePhrase returns false (not throws) when either side has no distinctive phrase at all', () => {
  assert.equal(sharesDistinctivePhrase('is a of', 'Duplicate-instance race is still unfixed'), false);
  assert.equal(sharesDistinctivePhrase('', ''), false);
});
