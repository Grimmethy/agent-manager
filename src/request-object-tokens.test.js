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

// --- precision: prose/path fragments must not become "named objects" (2026-09-18) ---------
// Real incident: adhoc-brain-dump-bd-1789457287339 (detectTruncatedImplementResponse). Its
// agentic pass correctly concluded the bug was already fixed, and the no-changes gate
// blocked that conclusion because the extractor turned fragments of the request's own prose
// into "objects the request names" that could never appear in the repo.

test('an /api-style path token is not extracted from the middle of a relative file path', () => {
  const t = extractRequestObjectTokens('the heuristic in src/validate-implement-truncation.js misreads prose');
  assert.ok(!t.some((x) => x.startsWith('/')), `unexpected path token in ${JSON.stringify(t)}`);
});

test('an /api-style path token is not extracted from a word/word alternation like JavaScript/Python', () => {
  const t = extractRequestObjectTokens('near-universal in real JavaScript/Python code');
  assert.ok(!t.includes('/Python'), JSON.stringify(t));
});

test('a real leading-slash API path is still extracted', () => {
  assert.ok(extractRequestObjectTokens('POST to /api/task/requeue when it fails').includes('/api/task/requeue'));
  assert.ok(extractRequestObjectTokens('the route (/api/brain-dump/sort) is slow').includes('/api/brain-dump/sort'));
});

test('mismatched quote characters (a backtick closed by a contraction apostrophe) do not pair into a fake phrase', () => {
  // The real shape: a backtick inside a regex literal, then "isn't" a few words later.
  const text = "CODE_MARKERS = /[{}\\[\\]`]/ -- when the response isn't valid JSON (the common shape)";
  const t = extractRequestObjectTokens(text);
  assert.ok(!t.some((x) => /when the response/.test(x)), JSON.stringify(t));
});

test('apostrophes inside contractions never open or close a quoted phrase', () => {
  const text = "the response isn't parsed, but that task itself no-op'd and the function's output is fine";
  const t = extractRequestObjectTokens(text);
  assert.ok(!t.some((x) => /\s/.test(x) && /isn|no-op|but that/.test(x)), JSON.stringify(t));
});

test('genuinely quoted phrases (double quote, single quote, backtick) are still extracted', () => {
  const t = extractRequestObjectTokens('the label "Show archived" and the flag \'dry run\' and `truncated output` matter');
  assert.ok(t.includes('Show archived'), JSON.stringify(t));
  assert.ok(t.includes('dry run'), JSON.stringify(t));
  assert.ok(t.includes('truncated output'), JSON.stringify(t));
});

test('a queue-state path carrying an epoch-ms task id is not a repo object', () => {
  const t = extractRequestObjectTokens('see /done/_archived/2026-09/pipeline-self-audit-truncated-draft-1788034686181 for the earlier attempt');
  assert.ok(!t.some((x) => /\d{12,}/.test(x)), JSON.stringify(t));
});
