'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { outcomeError, OUTCOME_ERROR } = require('./outcome-error.js');

test('OUTCOME_ERROR is frozen and has exactly the two registry values', () => {
  assert.equal(Object.isFrozen(OUTCOME_ERROR), true);
  assert.deepEqual(Object.values(OUTCOME_ERROR).sort(), ['BackendUnreachable', 'OutputTruncated']);
});

test('OutputTruncated toJSON has the { name, data } shape with empty data', () => {
  const err = outcomeError('OutputTruncated');
  assert.deepEqual(err.toJSON(), { name: 'OutputTruncated', data: {} });
});

test('BackendUnreachable keeps its name, data, and JSON shape', () => {
  const data = { backend: 'b', message: 'm' };
  const err = outcomeError('BackendUnreachable', data);
  assert.equal(err.name, 'BackendUnreachable');
  assert.deepEqual(err.data, data);
  assert.deepEqual(err.toJSON(), { name: 'BackendUnreachable', data });
});

test('JSON.stringify of the error yields the { name, data } shape', () => {
  const err = outcomeError('BackendUnreachable', { backend: 'b', message: 'm' });
  assert.deepEqual(JSON.parse(JSON.stringify(err)), {
    name: 'BackendUnreachable',
    data: { backend: 'b', message: 'm' },
  });
});

test('outcome errors are instanceof Error', () => {
  assert.equal(outcomeError('OutputTruncated') instanceof Error, true);
});
