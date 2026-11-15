'use strict';
// Run: node --test src/script-handler-registry.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { registerScriptHandler, getScriptHandler, _resetForTests } = require('./script-handler-registry.js');

test.beforeEach(() => _resetForTests());

test('a registered handler is returned for its source and only that source', () => {
  const fn = async () => ({ outcome: 'ok', summary: 's' });
  registerScriptHandler('tuning_experiment', fn);
  assert.equal(getScriptHandler('tuning_experiment'), fn);
  assert.equal(getScriptHandler('other_source'), undefined);
});

test('a source name that is an Object.prototype key has no handler (constructor, toString, __proto__)', () => {
  for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) assert.equal(getScriptHandler(name), undefined, name);
});

test('registering the same source twice throws and keeps the first handler', () => {
  const first = async () => ({});
  registerScriptHandler('a', first);
  assert.throws(() => registerScriptHandler('a', async () => ({})), /Script handler for "a" is already registered/);
  assert.equal(getScriptHandler('a'), first);
});

test('a non-function handler and an empty or non-string name are refused with TypeError', () => {
  assert.throws(() => registerScriptHandler('a', 'nope'), TypeError);
  assert.throws(() => registerScriptHandler('a', null), TypeError);
  for (const bad of ['', '   ', undefined, 5]) assert.throws(() => registerScriptHandler(bad, async () => ({})), TypeError);
  assert.equal(getScriptHandler('a'), undefined);
});

test('_resetForTests empties the registry', () => {
  registerScriptHandler('a', async () => ({}));
  _resetForTests();
  assert.equal(getScriptHandler('a'), undefined);
  registerScriptHandler('a', async () => ({}));
});
