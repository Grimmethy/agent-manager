'use strict';

const test = require('node:test');
const assert = require('node:assert');
const dp = require('../src/distinctive-phrases.js');
const ts = require('../src/text-similarity.js');

const A = 'duplicate-instance race in the sweep\nsecond stranded-claim detection line';
const B = 'Fix the stranded-claim detection';

test('distinctivePhrases matches values recorded before the refactor (first line only)', () => {
  assert.deepStrictEqual(dp.distinctivePhrases(A), [
    'duplicate-instance race in', 'in the sweep', 'duplicate-instance race', 'the sweep',
  ]);
});

test('sharesDistinctivePhrase defaults to first line only', () => {
  assert.strictEqual(dp.sharesDistinctivePhrase(A, B), false);
});

test('multiLine option inspects all lines', () => {
  assert.ok(dp.distinctivePhrases(A, { multiLine: true }).includes('stranded-claim detection'));
  assert.strictEqual(dp.sharesDistinctivePhrase(A, B, { multiLine: true }), true);
});

test('text-similarity re-exports the same functions and STOPWORDS', () => {
  assert.strictEqual(ts.distinctivePhrases, dp.distinctivePhrases);
  assert.strictEqual(ts.sharesDistinctivePhrase, dp.sharesDistinctivePhrase);
  assert.strictEqual(ts.STOPWORDS, dp.STOPWORDS);
});
