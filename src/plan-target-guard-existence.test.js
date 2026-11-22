'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { isDeclaredCreateTarget } = require('./plan-target-guard.js');

const T = 'src/x.js';

test('bare "does not exist on the main branch" is not a create target', () => {
  assert.strictEqual(isDeclaredCreateTarget('`src/x.js` does not exist on the main branch', T, ''), false);
});

test('bare "does not exist in this checkout" is not a create target', () => {
  assert.strictEqual(isDeclaredCreateTarget('`src/x.js` does not exist in this checkout', T, ''), false);
});

test('bold "does **not** exist yet" is a create target', () => {
  assert.strictEqual(isDeclaredCreateTarget('`src/x.js` does **not** exist yet', T, ''), true);
});

test('"does not exist yet, so this plan will create it" is a create target', () => {
  assert.strictEqual(isDeclaredCreateTarget('`src/x.js` does not exist yet, so this plan will create it', T, ''), true);
});

test('"does not yet exist" is a create target', () => {
  assert.strictEqual(isDeclaredCreateTarget('`src/x.js` does not yet exist', T, ''), true);
});
