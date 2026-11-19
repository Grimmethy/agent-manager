const test = require('node:test');
const assert = require('node:assert');
const { parseSignature } = require('./signature-parse.js');

test('parseSignature splits source and category', () => {
  assert.deepStrictEqual(parseSignature('arch_import::zero_hit'), { source: 'arch_import', category: 'zero_hit' });
});

test('parseSignature splits on the last separator', () => {
  assert.deepStrictEqual(parseSignature('a::b::c'), { source: 'a::b', category: 'c' });
});
