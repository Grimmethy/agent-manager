'use strict';

// Unit tests for model-profile-registry.js -- same coverage shape as
// task-source-registry.test.js's own register/get/clear tests, since this file mirrors
// that one's design on purpose.
//
// Run: node --test src/model-profile-registry.test.js  (or `npm test`)

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerModelProfile, getModelProfile, clearModelProfileRegistry } = require('./model-profile-registry.js');

test('registerModelProfile stores a profile retrievable by name', () => {
  clearModelProfileRegistry();
  registerModelProfile('review-fast', { backend: 'local', model: 'qwen2.5:3b', numCtx: 8192 });
  const profile = getModelProfile('review-fast');
  assert.equal(profile.name, 'review-fast');
  assert.equal(profile.backend, 'local');
  assert.equal(profile.model, 'qwen2.5:3b');
  assert.equal(profile.numCtx, 8192);
});

test('getModelProfile returns undefined for an unregistered name', () => {
  clearModelProfileRegistry();
  assert.equal(getModelProfile('does-not-exist'), undefined);
});

test('registerModelProfile throws when the same name is registered twice', () => {
  clearModelProfileRegistry();
  registerModelProfile('dup', { backend: 'local', model: 'x' });
  assert.throws(() => registerModelProfile('dup', { backend: 'local', model: 'y' }), /already registered/);
});

test('clearModelProfileRegistry removes every registered profile', () => {
  clearModelProfileRegistry();
  registerModelProfile('a', { backend: 'local', model: 'x' });
  registerModelProfile('b', { backend: 'claude', model: 'sonnet' });
  clearModelProfileRegistry();
  assert.equal(getModelProfile('a'), undefined);
  assert.equal(getModelProfile('b'), undefined);
});

test('registerModelProfile stores arbitrary override fields unchanged (numPredict, temperature, timeoutMs)', () => {
  clearModelProfileRegistry();
  registerModelProfile('custom', {
    backend: 'claude', model: 'claude:opus', numPredict: 2000, temperature: 0.1, timeoutMs: 90000,
  });
  const profile = getModelProfile('custom');
  assert.equal(profile.numPredict, 2000);
  assert.equal(profile.temperature, 0.1);
  assert.equal(profile.timeoutMs, 90000);
});
