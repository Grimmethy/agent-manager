'use strict';

// Unit tests for model-strategies.js -- the load-bearing guarantee here is backward
// compatibility: an unregistered name (a bare LOCAL_AB_MODELS=<tag>,<tag> usage) must
// resolve to zero overrides, byte-identical to before this registry existed.
//
// Run: node --test src/model-strategies.test.js  (or `npm test`)

const test = require('node:test');
const assert = require('node:assert/strict');
const { MODEL_STRATEGIES, resolveStrategy } = require('./model-strategies.js');

test('resolveStrategy returns a registered strategy\'s full entry', () => {
  const result = resolveStrategy('qwen3-27b-q4');
  assert.equal(result.model, 'qwen3.8:27b-q4_K_M');
  assert.match(result.summary, /baseline/i);
});

test('resolveStrategy treats an unregistered name as a bare model tag with no overrides', () => {
  const result = resolveStrategy('qwen3.8:27b-q4_K_M');
  assert.deepEqual(result, { model: 'qwen3.8:27b-q4_K_M', summary: null });
});

test('resolveStrategy treats a hypothetical future model tag the same way (backward compatibility)', () => {
  const result = resolveStrategy('some-future-model:70b');
  assert.deepEqual(result, { model: 'some-future-model:70b', summary: null });
});

test('resolveStrategy does not mutate the shared registry entry it returns', () => {
  const result = resolveStrategy('qwen3-27b-q4');
  result.model = 'mutated';
  assert.equal(MODEL_STRATEGIES['qwen3-27b-q4'].model, 'qwen3.8:27b-q4_K_M');
});

test('neither seeded strategy carries temperature/numPredict/think overrides yet (no fabricated tuning data)', () => {
  for (const [name, entry] of Object.entries(MODEL_STRATEGIES)) {
    assert.equal(entry.temperature, undefined, `${name} should not have a fabricated temperature override`);
    assert.equal(entry.numPredict, undefined, `${name} should not have a fabricated numPredict override`);
    assert.equal(entry.think, undefined, `${name} should not have a fabricated think override`);
  }
});

test('qwen3-27b-q8 is registered, ready for real overrides once benchmarking data exists', () => {
  const result = resolveStrategy('qwen3-27b-q8');
  assert.equal(result.model, 'qwen3.8:27b-q8_0');
  assert.ok(result.summary);
});
