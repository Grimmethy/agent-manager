const test = require('node:test');
const assert = require('node:assert');
const { detectReviewerHallucination } = require('./reviewer-hallucination-guard.js');

test('no double-quoted spans returns not hallucinated', () => {
  assert.deepStrictEqual(detectReviewerHallucination('no quotes here', 'anything'), { hallucinated: false, checked: 0, missing: [] });
});

test('spans shorter than 12 characters are ignored', () => {
  const r = detectReviewerHallucination('say "short one" now', 'nothing');
  assert.deepStrictEqual(r, { hallucinated: false, checked: 0, missing: [] });
});

test('span present with different case and whitespace is not missing', () => {
  const r = detectReviewerHallucination('the code has "Foo   Bar Baz Qux" here', 'the code has foo bar baz qux here');
  assert.strictEqual(r.hallucinated, false);
  assert.strictEqual(r.checked, 1);
  assert.deepStrictEqual(r.missing, []);
});

test('span absent from response is reported as missing', () => {
  const r = detectReviewerHallucination('claims "this function is missing" entirely', 'nothing relevant');
  assert.strictEqual(r.hallucinated, true);
  assert.deepStrictEqual(r.missing, ['this function is missing']);
});

test('escaped quote does not end the span early', () => {
  const r = detectReviewerHallucination('see "alpha \\"beta\\" gamma delta" end', 'x');
  assert.strictEqual(r.checked, 1);
});
