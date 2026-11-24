'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { describeFailure } = require('./describe-failure.js');

test('plain object with a message yields that message, never [object Object]', () => {
  const out = describeFailure({ message: 'boom' });
  assert.equal(out, 'boom');
  assert.ok(!out.includes('[object Object]'));
});

test('Error yields name: message plus the first stack line', () => {
  const err = new TypeError('bad input');
  const out = describeFailure(err);
  const lines = out.split('\n');
  assert.equal(lines[0], 'TypeError: bad input');
  assert.equal(lines.length, 2);
  assert.ok(lines[1].length > 0);
  assert.ok(!out.includes('[object Object]'));
});

test('string passes through unchanged', () => {
  assert.equal(describeFailure('plain text'), 'plain text');
});

test('object field precedence: message > error > failure > output > name', () => {
  assert.equal(describeFailure({ message: 'm', error: 'e', failure: 'f', output: 'o', name: 'n' }), 'm');
  assert.equal(describeFailure({ error: 'e', failure: 'f', output: 'o', name: 'n' }), 'e');
  assert.equal(describeFailure({ failure: 'f', output: 'o', name: 'n' }), 'f');
  assert.equal(describeFailure({ output: 'o', name: 'n' }), 'o');
  assert.equal(describeFailure({ name: 'n' }), 'n');
});

test('empty fields are skipped in favor of later usable fields', () => {
  assert.equal(describeFailure({ message: '  ', error: 'e' }), 'e');
});

test('circular object does not throw and returns the fallback token', () => {
  const obj = { a: 1 };
  obj.self = obj;
  let out;
  assert.doesNotThrow(() => { out = describeFailure(obj); });
  assert.equal(out, '<unprintable>');
});

test('non-object primitives are JSON-encoded, never String()-coerced', () => {
  assert.equal(describeFailure(42), '42');
  assert.equal(describeFailure(null), 'null');
  assert.equal(describeFailure(undefined), '<unprintable>');
});
