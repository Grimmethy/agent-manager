'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { checkCitedPaths } = require('./candidate-path-grounding.js');

const REPO = path.resolve(__dirname, '..');

test('checkCitedPaths: all cited paths exist -> nothing fabricated', () => {
  const { fabricated } = checkCitedPaths('Files: package.json', REPO);
  assert.deepEqual(fabricated, []);
});

test('checkCitedPaths: one nonexistent relative path is returned', () => {
  const { fabricated } = checkCitedPaths('Files: package.json, src/does-not-exist.js', REPO);
  assert.deepEqual(fabricated.map((f) => f.claimedPath), ['src/does-not-exist.js']);
});

test('checkCitedPaths: absolute path is returned as missing', () => {
  const abs = '/no-such-dir-xyz/does-not-exist.js';
  const { fabricated } = checkCitedPaths(`Files: ${abs}`, REPO);
  assert.deepEqual(fabricated.map((f) => f.claimedPath), [abs]);
});
