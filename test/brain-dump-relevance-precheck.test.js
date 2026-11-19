'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { brainDumpRelevancePrecheck } = require('../src/brain-dump-relevance-precheck.js');

function spy(result = 0) {
  const calls = [];
  const fn = (term) => { calls.push(term); return typeof result === 'function' ? result(term) : result; };
  fn.calls = calls;
  return fn;
}

test('identifier bypass keeps an entry that names a code identifier, without searching', () => {
  const search = spy(0);
  const r = brainDumpRelevancePrecheck('retryWithJitter in `src/local-client.js` ignores the cap', search);
  assert.strictEqual(r.relevant, true);
  assert.strictEqual(r.reason, 'identifier-bypass');
  assert.strictEqual(search.calls.length, 0);
});

test('too-few-terms keeps a short vague entry, without searching', () => {
  const search = spy(0);
  const r = brainDumpRelevancePrecheck('Ollama stalls', search);
  assert.strictEqual(r.relevant, true);
  assert.strictEqual(r.reason, 'too-few-terms');
  assert.strictEqual(search.calls.length, 0);
});

test('a term that matches only a file path counts as a hit', () => {
  const search = spy((term) => (term === 'pipeline' ? 1 : 0));
  const r = brainDumpRelevancePrecheck('orchard harvest pipeline problems', search);
  assert.strictEqual(r.relevant, true);
  assert.strictEqual(r.reason, 'hit');
  assert.ok(r.hitCounts.pipeline > 0);
});

test('zero hits across all terms dismisses with a full audit record', () => {
  const search = spy(0);
  const r = brainDumpRelevancePrecheck('orchard harvest pipeline problems', search);
  assert.strictEqual(r.relevant, false);
  assert.strictEqual(r.reason, 'zero-hits');
  assert.ok(r.checkedTerms.length > 0);
  assert.ok(Object.keys(r.hitCounts).length > 0);
  assert.strictEqual(typeof r.droppedTermCount, 'number');
});

test('cap keeps 12 distinct terms and reports 3 dropped', () => {
  const text = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar';
  const search = spy(0);
  const r = brainDumpRelevancePrecheck(text, search);
  assert.strictEqual(r.checkedTerms.length, 12);
  assert.strictEqual(r.droppedTermCount, 3);
  assert.strictEqual(r.relevant, false);
});

test('a throwing search fails open with search-error', () => {
  const search = () => { throw new Error('boom'); };
  const r = brainDumpRelevancePrecheck('alpha bravo charlie', search);
  assert.strictEqual(r.relevant, true);
  assert.strictEqual(r.reason, 'search-error');
});
