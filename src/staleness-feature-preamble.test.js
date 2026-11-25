'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { stripFeaturePreamble, siblingsShareFeatureOrChain } = require('./staleness-feature-preamble.js');

test('strip drops a leading feature preamble paragraph', () => {
  assert.equal(stripFeaturePreamble('This piece is part of HUB1.\n\nDo the thing.'), 'Do the thing.');
});

test('strip leaves text without a preamble unchanged', () => {
  assert.equal(stripFeaturePreamble('Do the thing.'), 'Do the thing.');
});

test('shared decomposedFrom makes siblings', () => {
  assert.equal(siblingsShareFeatureOrChain({ id: 'a-1', promptContext: { decomposedFrom: 'X' } }, { id: 'b-1', promptContext: { decomposedFrom: 'X' } }), true);
});

test('shared HUBn id prefix makes siblings', () => {
  assert.equal(siblingsShareFeatureOrChain({ id: 'HUB0498-01-x' }, { id: 'HUB0498-02-y' }), true);
});

test('shared stacked.branch makes siblings', () => {
  assert.equal(siblingsShareFeatureOrChain({ id: 'a', stacked: { branch: 'agent/x' } }, { id: 'b', stacked: { branch: 'agent/x' } }), true);
});

test('subTasks listing makes a chain', () => {
  assert.equal(siblingsShareFeatureOrChain({ id: 'p', subTasks: ['c'] }, { id: 'c' }), true);
});

test('no shared signal means not siblings', () => {
  assert.equal(siblingsShareFeatureOrChain({ id: 'adhoc-a' }, { id: 'adhoc-b' }), false);
});

test('empty fields never match', () => {
  assert.equal(siblingsShareFeatureOrChain({ id: 'adhoc-a', parentHub: '' }, { id: 'adhoc-b', parentHub: '' }), false);
});
