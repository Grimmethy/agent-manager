'use strict';

// Unit tests for dep-ref.js.
//
// Run: node --test src/dep-ref.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDepRef } = require('./dep-ref.js');

test('bare id resolves to currentProject', () => {
  assert.deepEqual(parseDepRef('x', 'p'), { project: 'p', id: 'x' });
});

test('project:id string splits into project and id', () => {
  assert.deepEqual(parseDepRef('proj:abc', 'p'), { project: 'proj', id: 'abc' });
});

test('string splits on the first colon only', () => {
  assert.deepEqual(parseDepRef('a:b:c', 'p'), { project: 'a', id: 'b:c' });
});

test('object form returns its project and id', () => {
  assert.deepEqual(parseDepRef({ project: 'q', id: 'y' }, 'p'), { project: 'q', id: 'y' });
});

test('empty bare string returns null', () => {
  assert.equal(parseDepRef('', 'p'), null);
});

test('bare id with empty or missing currentProject returns null', () => {
  assert.equal(parseDepRef('x', ''), null);
  assert.equal(parseDepRef('x'), null);
});

test('string with empty project or empty id returns null', () => {
  assert.equal(parseDepRef(':x', 'p'), null);
  assert.equal(parseDepRef('proj:', 'p'), null);
});

test('object with empty id or project returns null', () => {
  assert.equal(parseDepRef({ project: 'p', id: '' }, 'p'), null);
  assert.equal(parseDepRef({ project: '', id: 'x' }, 'p'), null);
});

test('non-string, non-object shapes return null', () => {
  assert.equal(parseDepRef(null, 'p'), null);
  assert.equal(parseDepRef(undefined, 'p'), null);
  assert.equal(parseDepRef(42, 'p'), null);
  assert.equal(parseDepRef(['p', 'x'], 'p'), null);
});
