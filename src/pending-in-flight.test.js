'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { claimablePendingFiles } = require('./pending-in-flight.js');

// Fake reader: each file maps to a task object, a thrown error, or null.
function reader(map) {
  return (file) => {
    const v = map[file];
    if (v instanceof Error) throw v;
    return v;
  };
}

test('grimm counts a file leased to grimm but not an unleased file', () => {
  const map = { own: { leasedTo: 'grimm' }, unleased: {} };
  assert.deepEqual(claimablePendingFiles(['own', 'unleased'], 'grimm', reader(map)), ['own']);
});

test('wok and unset node id count an unleased file but not one leased to grimm', () => {
  const map = { unleased: {}, grimmLeased: { leasedTo: 'grimm' } };
  assert.deepEqual(claimablePendingFiles(['unleased', 'grimmLeased'], 'wok', reader(map)), ['unleased']);
  assert.deepEqual(claimablePendingFiles(['unleased', 'grimmLeased'], '', reader(map)), ['unleased']);
  assert.deepEqual(claimablePendingFiles(['unleased', 'grimmLeased'], null, reader(map)), ['unleased']);
});

test('invalid JSON and JSON null files are still counted', () => {
  const map = { bad: new SyntaxError('Unexpected token'), nul: null };
  assert.deepEqual(claimablePendingFiles(['bad', 'nul'], 'grimm', reader(map)), ['bad', 'nul']);
});

test('null or non-array input returns []', () => {
  assert.deepEqual(claimablePendingFiles(null, 'grimm', reader({})), []);
  assert.deepEqual(claimablePendingFiles(undefined, 'grimm', reader({})), []);
});
