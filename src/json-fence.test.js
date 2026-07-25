'use strict';

// Unit tests for json-fence.js -- shared by apply-group-a.js and apply-group-b.js to
// tolerate Ornith drafts that don't come back as bare JSON.
//
// Run: node --test src/json-fence.test.js (or `npm test`, see package.json)

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseJsonMaybeFenced, extractBalancedJson } = require('./json-fence.js');

test('parses bare JSON with no fence and no prose', () => {
  assert.deepEqual(parseJsonMaybeFenced('{"mode":"edit","file":"a.js"}'), { mode: 'edit', file: 'a.js' });
});

test('parses a markdown-fenced object', () => {
  const text = '```json\n{"mode":"edit","file":"a.js"}\n```';
  assert.deepEqual(parseJsonMaybeFenced(text), { mode: 'edit', file: 'a.js' });
});

test('parses a fenced object with trailing prose after the closing fence', () => {
  const text = '```json\n{"mode":"edit","file":"a.js"}\n```\n\nNOTE: applied as requested.';
  assert.deepEqual(parseJsonMaybeFenced(text), { mode: 'edit', file: 'a.js' });
});

test('recovers JSON preceded by prose with NO code fence (the 2026-07-25 live failure)', () => {
  const text = 'Let me examine the file first.\n\n{"mode":"edit","file":"a.js","find":"x","replace":"y"}';
  assert.deepEqual(parseJsonMaybeFenced(text), { mode: 'edit', file: 'a.js', find: 'x', replace: 'y' });
});

test('recovers a JSON array preceded by prose with no fence', () => {
  const text = 'Sure, here is the change:\n[{"mode":"create","file":"a.js","content":"x"}]';
  assert.deepEqual(parseJsonMaybeFenced(text), [{ mode: 'create', file: 'a.js', content: 'x' }]);
});

test('recovers JSON followed by trailing prose with no fence', () => {
  const text = '{"mode":"delete","file":"a.js"}\n\nLet me know if you need anything else!';
  assert.deepEqual(parseJsonMaybeFenced(text), { mode: 'delete', file: 'a.js' });
});

test('does not get confused by braces/brackets inside string values', () => {
  const text = 'Here you go:\n{"mode":"edit","file":"a.js","find":"if (x) { return [1]; }","replace":"y"}';
  const parsed = parseJsonMaybeFenced(text);
  assert.equal(parsed.find, 'if (x) { return [1]; }');
});

test('does not get confused by escaped quotes inside string values', () => {
  const text = 'prose\n{"mode":"edit","file":"a.js","find":"say \\"hi\\"","replace":"y"}';
  const parsed = parseJsonMaybeFenced(text);
  assert.equal(parsed.find, 'say "hi"');
});

test('throws the original error, not a confusing secondary one, when nothing is recoverable', () => {
  assert.throws(() => parseJsonMaybeFenced('I cannot verify this draft against the provided inputs.'), /Unexpected token/);
});

test('throws on truncated (unbalanced) JSON rather than returning a partial parse', () => {
  const text = 'prose\n{"mode":"edit","file":"a.js","find":"x"';
  assert.throws(() => parseJsonMaybeFenced(text));
});

test('extractBalancedJson returns null when no bracket is present at all', () => {
  assert.equal(extractBalancedJson('just plain prose, no JSON here'), null);
});
