'use strict';

// hub-merge-integrity.js: a piece marked merged must have its commit on the landed set or a live branch.
// Run: node --test src/hub-merge-integrity.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { canMarkMerged, checkHub } = require('./hub-merge-integrity.js');

test('a merged piece with no landed commit and no live branch is refused', () => {
  const piece = { id: 'P1', state: 'merged', commit: 'c-missing' };
  assert.equal(canMarkMerged(piece, new Set(['c-other']), false), false);
});

test('a merged piece whose commit is in landedSet is accepted', () => {
  const piece = { id: 'P2', state: 'merged', commit: 'c-landed' };
  assert.equal(canMarkMerged(piece, new Set(['c-landed']), false), true);
});

test('a merged piece with a live branch alone is accepted', () => {
  const piece = { id: 'P3', state: 'merged', commit: 'c-not-landed' };
  assert.equal(canMarkMerged(piece, new Set(), true), true);
});

test('checkHub returns exactly the unlanded piece id, regardless of piece order', () => {
  const landed = new Set(['c-landed']);
  const noBranch = () => false;
  const landedPiece = { id: 'A', state: 'merged', commit: 'c-landed' };
  const unlandedPiece = { id: 'B', state: 'merged', commit: 'c-unlanded' };
  assert.deepStrictEqual(checkHub([landedPiece, unlandedPiece], landed, noBranch), ['B']);
  assert.deepStrictEqual(checkHub([unlandedPiece, landedPiece], landed, noBranch), ['B']);
});
