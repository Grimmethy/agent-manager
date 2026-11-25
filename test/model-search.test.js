'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeModelSearch,
  compactModelSearch,
  matchesModelSearch,
} = require('../src/lib/model-search.js');

const TAG = 'qwen2.5-coder:7b-instruct';

test('normalizeModelSearch lowercases and collapses punctuation to single spaces', () => {
  assert.equal(normalizeModelSearch('Qwen2.5-Coder:7B-Instruct'), 'qwen2 5 coder 7b instruct');
});

test('compactModelSearch removes all spaces from the normalized form', () => {
  assert.equal(compactModelSearch('qwen2.5 coder'), 'qwen25coder');
});

test('spaced, hyphenated, and compacted queries each match the same tag', () => {
  assert.equal(matchesModelSearch('qwen2.5 coder', [TAG]), true);
  assert.equal(matchesModelSearch('qwen2.5-coder', [TAG]), true);
  assert.equal(matchesModelSearch('qwen25coder', [TAG]), true);
});

test('matches when any one of several candidate values matches', () => {
  assert.equal(matchesModelSearch('coder', ['llama3', 'qwen2.5-coder']), true);
});

test('empty query matches everything', () => {
  assert.equal(matchesModelSearch('', [TAG]), true);
  assert.equal(matchesModelSearch('   ', [TAG]), true);
});

test('non-matching query returns false', () => {
  assert.equal(matchesModelSearch('mistral', [TAG]), false);
  assert.equal(matchesModelSearch('qwen3', [TAG]), false);
});

test('Unicode letters and digits are preserved', () => {
  assert.equal(normalizeModelSearch('Modèle-日本語 v2'), 'modèle 日本語 v2');
  assert.equal(matchesModelSearch('modèle', ['Modèle-日本語']), true);
  assert.equal(matchesModelSearch('日本語', ['Modèle-日本語']), true);
});
