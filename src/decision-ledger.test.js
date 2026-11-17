'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatRuling } = require('./decision-ledger.js');

test('formats the exact Ruling line', () => {
  assert.equal(
    formatRuling({ what: 'use A', why: 'B is unmaintained', cost: 'rework if A breaks' }),
    'Ruling: use A - B is unmaintained - rework if A breaks',
  );
});

test('trims fields and folds newlines into single spaces', () => {
  assert.equal(
    formatRuling({ what: '  use A\nnow ', why: 'why', cost: 'cost  ' }),
    'Ruling: use A now - why - cost',
  );
});

test('rejects an empty, blank, or missing field', () => {
  const bad = [
    { what: 'a', why: 'b', cost: '' },
    { what: 'a', why: '   ', cost: 'c' },
    { why: 'b', cost: 'c' },
  ];
  for (const input of bad) {
    assert.throws(() => formatRuling(input), /non-empty/);
  }
});
