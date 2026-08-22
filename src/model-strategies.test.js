'use strict';

// Unit tests for model-strategies.js -- the load-bearing guarantee here is backward
// compatibility: an unregistered name (the exact pre-existing LOCAL_AB_MODELS=ornith:9b,
// hermes3:8b bare-tag usage) must resolve to zero overrides, byte-identical to before this
// registry existed.
//
// Run: node --test src/model-strategies.test.js  (or `npm test`)

const test = require('node:test');
const assert = require('node:assert/strict');
const { MODEL_STRATEGIES, resolveStrategy } = require('./model-strategies.js');

test('resolveStrategy returns a registered strategy\'s full entry', () => {
  const result = resolveStrategy('ornith-9b');
  assert.equal(result.model, 'ornith:9b');
  assert.match(result.summary, /baseline/i);
});

test('resolveStrategy treats an unregistered name as a bare model tag with no overrides', () => {
  const result = resolveStrategy('ornith:9b');
  assert.deepEqual(result, { model: 'ornith:9b', summary: null });
});

test('resolveStrategy treats a hypothetical future model tag the same way (backward compatibility)', () => {
  const result = resolveStrategy('some-future-model:70b');
  assert.deepEqual(result, { model: 'some-future-model:70b', summary: null });
});

test('resolveStrategy does not mutate the shared registry entry it returns', () => {
  const result = resolveStrategy('ornith-9b');
  result.model = 'mutated';
  assert.equal(MODEL_STRATEGIES['ornith-9b'].model, 'ornith:9b');
});

test('neither seeded strategy carries temperature/numPredict/think overrides yet (no fabricated tuning data)', () => {
  for (const [name, entry] of Object.entries(MODEL_STRATEGIES)) {
    assert.equal(entry.temperature, undefined, `${name} should not have a fabricated temperature override`);
    assert.equal(entry.numPredict, undefined, `${name} should not have a fabricated numPredict override`);
    assert.equal(entry.think, undefined, `${name} should not have a fabricated think override`);
  }
});

test('hermes3-8b is registered, ready for real overrides once benchmarking data exists', () => {
  const result = resolveStrategy('hermes3-8b');
  assert.equal(result.model, 'hermes3:8b');
  assert.ok(result.summary);
});
