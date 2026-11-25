'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { OUTCOME_ERROR, outcomeError } = require('../src/errors/outcome-error.js');

test('OutputTruncated serializes to { name, data } with empty data', () => {
  const err = outcomeError('OutputTruncated');
  assert.equal(err.name, 'OutputTruncated');
  assert.deepEqual(err.data, {});
  assert.equal(
    JSON.stringify(outcomeError('OutputTruncated')),
    '{"name":"OutputTruncated","data":{}}',
  );
});

test('BackendUnreachable serializes its { backend, message } payload', () => {
  const data = { backend: 'ollama', message: 'connection refused' };
  const err = outcomeError('BackendUnreachable', data);
  assert.equal(err.name, 'BackendUnreachable');
  assert.deepEqual(err.data, data);
  assert.deepEqual(JSON.parse(JSON.stringify(err)), {
    name: 'BackendUnreachable',
    data: { backend: 'ollama', message: 'connection refused' },
  });
});

test('OUTCOME_ERROR registry is frozen and lists the known names', () => {
  assert.equal(Object.isFrozen(OUTCOME_ERROR), true);
  assert.deepEqual(Object.values(OUTCOME_ERROR), ['OutputTruncated', 'BackendUnreachable']);
});

test('outcomeError rejects unknown names', () => {
  assert.throws(() => outcomeError('NoSuchName'), /Unknown outcome error name/);
});
