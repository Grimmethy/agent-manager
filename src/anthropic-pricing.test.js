'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { estimateApiCostUsd, normalizeModelName, defaultClaudeModel } = require('./anthropic-pricing.js');

test('estimateApiCostUsd computes real input+output cost at Sonnet rates ($2/$10 per million)', () => {
  const cost = estimateApiCostUsd({ promptTokens: 1_000_000, completionTokens: 1_000_000, model: 'sonnet' });
  assert.ok(Math.abs(cost - 12) < 1e-9); // $2 input + $10 output
});

test('estimateApiCostUsd computes Opus rates ($5/$25 per million)', () => {
  const cost = estimateApiCostUsd({ promptTokens: 1_000_000, completionTokens: 1_000_000, model: 'opus' });
  assert.ok(Math.abs(cost - 30) < 1e-9);
});

test('estimateApiCostUsd computes Haiku rates ($1/$5 per million)', () => {
  const cost = estimateApiCostUsd({ promptTokens: 1_000_000, completionTokens: 1_000_000, model: 'haiku' });
  assert.ok(Math.abs(cost - 6) < 1e-9);
});

test('estimateApiCostUsd scales proportionally for a realistic small call', () => {
  const cost = estimateApiCostUsd({ promptTokens: 4000, completionTokens: 800, model: 'sonnet' });
  const expected = (4000 / 1_000_000) * 2 + (800 / 1_000_000) * 10;
  assert.ok(Math.abs(cost - expected) < 1e-12);
});

test('estimateApiCostUsd returns 0 (not null/NaN) for zero or missing token counts', () => {
  assert.equal(estimateApiCostUsd({ model: 'sonnet' }), 0);
  assert.equal(estimateApiCostUsd({ promptTokens: 0, completionTokens: 0, model: 'sonnet' }), 0);
});

test('normalizeModelName strips a claude: prefix and matches the bare tier name', () => {
  assert.equal(normalizeModelName('claude:sonnet'), 'sonnet');
  assert.equal(normalizeModelName('claude-opus-4-5'), 'opus');
  assert.equal(normalizeModelName('HAIKU'), 'haiku');
});

test('normalizeModelName falls back to the default Claude model for an unrecognized name -- not a silent $0', () => {
  const prev = process.env.CLAUDE_MODEL;
  delete process.env.CLAUDE_MODEL;
  assert.equal(normalizeModelName('qwen3.8:27b-q4_K_M'), 'sonnet');
  if (prev !== undefined) process.env.CLAUDE_MODEL = prev;
});

test('defaultClaudeModel reflects CLAUDE_MODEL, defaulting to sonnet', () => {
  const prev = process.env.CLAUDE_MODEL;
  delete process.env.CLAUDE_MODEL;
  assert.equal(defaultClaudeModel(), 'sonnet');
  process.env.CLAUDE_MODEL = 'opus';
  assert.equal(defaultClaudeModel(), 'opus');
  if (prev === undefined) delete process.env.CLAUDE_MODEL;
  else process.env.CLAUDE_MODEL = prev;
});

test('estimateApiCostUsd for a local model call (an Ollama result shape, e.g. qwen) prices against the default Claude tier, not $0', () => {
  const prev = process.env.CLAUDE_MODEL;
  delete process.env.CLAUDE_MODEL;
  // Simulates a real Ollama result: model is a local tag, but promptTokens/completionTokens
  // are real (Ollama's own prompt_eval_count/eval_count) -- this is the exact "what would
  // this local call have cost on the API" case the feature exists for.
  const cost = estimateApiCostUsd({ promptTokens: 5000, completionTokens: 1200, model: 'qwen3.8:27b-q4_K_M' });
  assert.ok(cost > 0);
  const expected = (5000 / 1_000_000) * 2 + (1200 / 1_000_000) * 10; // falls back to sonnet rate
  assert.ok(Math.abs(cost - expected) < 1e-12);
  if (prev === undefined) delete process.env.CLAUDE_MODEL;
  else process.env.CLAUDE_MODEL = prev;
});
