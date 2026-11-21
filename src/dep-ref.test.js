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

test('bare id with no project returns project: null', () => {
  assert.deepEqual(parseDepRef('HUB0412'), { project: null, id: 'HUB0412' });
});

test('bare id with null currentProject returns project: null', () => {
  assert.deepEqual(parseDepRef('HUB0412', null), { project: null, id: 'HUB0412' });
});

test('bare id with undefined currentProject returns project: null', () => {
  assert.deepEqual(parseDepRef('HUB0412', undefined), { project: null, id: 'HUB0412' });
});

test('project:id string splits into project and id', () => {
  assert.deepEqual(parseDepRef('agent-manager:HUB0412'), { project: 'agent-manager', id: 'HUB0412' });
});

test('string splits on the first colon only', () => {
  assert.deepEqual(parseDepRef('a:b:c'), { project: 'a', id: 'b:c' });
});

test('object form returns its project and id', () => {
  assert.deepEqual(parseDepRef({ project: 'q', id: 'y' }, 'p'), { project: 'q', id: 'y' });
});

test('object form without currentProject returns its project and id', () => {
  assert.deepEqual(parseDepRef({ project: 'q', id: 'y' }), { project: 'q', id: 'y' });
});

test('empty bare string returns null', () => {
  assert.equal(parseDepRef('', 'p'), null);
});

test('bare id with empty or missing currentProject returns project: null', () => {
  assert.deepEqual(parseDepRef('x', ''), { project: null, id: 'x' });
  assert.deepEqual(parseDepRef('x', null), { project: null, id: 'x' });
  assert.deepEqual(parseDepRef('x', undefined), { project: null, id: 'x' });
});

test('string with empty project or empty id throws', () => {
  assert.throws(() => parseDepRef(':x', 'p'), /malformed qualified reference/);
  assert.throws(() => parseDepRef('proj:', 'p'), /malformed qualified reference/);
  assert.throws(() => parseDepRef(':x'), /malformed qualified reference/);
  assert.throws(() => parseDepRef('proj:'), /malformed qualified reference/);
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
