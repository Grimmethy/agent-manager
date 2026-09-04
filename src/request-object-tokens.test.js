'use strict';

// extracted from get-grounding-source.js (2026-09-04) -- see that file's own
// 'extractRequestObjectTokens pulls nouns/identifiers/paths...' test for the original,
// still-passing regression fixture. This file covers the module in isolation.

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractRequestObjectTokens, MAX_REQUEST_OBJECT_TOKENS } = require('./request-object-tokens.js');

test('extractRequestObjectTokens pulls quoted phrases, paths, camelCase/snake_case, and content words', () => {
  const toks = extractRequestObjectTokens('Add /api/gallery-meta and wire up renderJobListTab() per "the spec doc".');
  assert.ok(toks.includes('/api/gallery-meta'));
  assert.ok(toks.includes('renderJobListTab'));
  assert.ok(toks.includes('the spec doc'));
});

test('extractRequestObjectTokens drops stopwords and empty input', () => {
  const toks = extractRequestObjectTokens('This should have been about after before these those where selected.');
  assert.equal(toks.length, 0);
  assert.deepEqual(extractRequestObjectTokens(''), []);
  assert.deepEqual(extractRequestObjectTokens(undefined), []);
});

test('extractRequestObjectTokens caps at MAX_REQUEST_OBJECT_TOKENS', () => {
  const alpha = 'abcdefghijklmnopqrstuvwxyz'.split('');
  const words = alpha.slice(0, 20).map((c) => `${c}word${c}${c}${c}`).join(' ');
  assert.equal(extractRequestObjectTokens(words).length, MAX_REQUEST_OBJECT_TOKENS);
});
