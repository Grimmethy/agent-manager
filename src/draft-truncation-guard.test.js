'use strict';

// Ported from python/dashboard/test_draft_truncation_guard.py (2026-09-08 -- see
// draft-truncation-guard.js's own header for why that Python port was salvaged rather
// than merged as-is). Same 6 cases, same behavior.

const test = require('node:test');
const assert = require('node:assert/strict');
const { isDraftTruncated } = require('./draft-truncation-guard.js');

test('a well-formed draft with a closed PLAN table and IMPLEMENT content is not truncated', () => {
  const draft = [
    '| Step | Action |',
    '|------|--------|',
    '| 1    | Do A   |',
    '',
    '## IMPLEMENT',
    '',
    'do thing B',
    '',
  ].join('\n');
  assert.equal(isDraftTruncated(draft), false);
});

test('last line is an unclosed table row -> truncated', () => {
  const draft = [
    '| Step | Action |',
    '|------|--------|',
    '| 1    | partial text',
  ].join('\n');
  assert.equal(isDraftTruncated(draft), true);
});

test('IMPLEMENT heading followed by a body line -> not truncated', () => {
  assert.equal(isDraftTruncated('## IMPLEMENT\n\ndo thing A\n'), false);
});

test('IMPLEMENT heading with nothing after it -> truncated', () => {
  assert.equal(isDraftTruncated('## IMPLEMENT\n'), true);
});

test('IMPLEMENT section with an unclosed code fence -> truncated', () => {
  const draft = [
    '## IMPLEMENT',
    '',
    '```',
    'code here',
    '',
  ].join('\n');
  assert.equal(isDraftTruncated(draft), true);
});

test('empty or whitespace-only input -> guard is silent (false)', () => {
  assert.equal(isDraftTruncated(''), false);
  assert.equal(isDraftTruncated('   \n  \n'), false);
});
