'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeMaxSafeNumCtx,
  resolveNumCtx,
  resolveTimeoutMs,
  MIN_NUM_CTX,
  MIN_TIMEOUT_MS,
  HARD_TIMEOUT_CEILING_MS,
} = require('./gpu-capacity.js');

test('computeMaxSafeNumCtx derives a per-token cost from the live sample and scales up with free VRAM', () => {
  // Matches this session's real 2026-08-20 measurement: 27B q4 model, numCtx=8192,
  // weights ~17047 MiB, total used ~17501 MiB -> overhead ~454 MiB -> ~0.0554 MiB/token.
  const result = computeMaxSafeNumCtx({
    totalVramMiB: 24576, usedVramMiB: 17501, modelWeightMiB: 17047, currentNumCtx: 8192,
  });
  assert.ok(result.maxSafeNumCtx > 8192, 'should find room to grow given ~6.6 GiB free');
  assert.ok(result.miBPerCtxToken > 0);
});

test('computeMaxSafeNumCtx returns null on missing/invalid inputs instead of guessing', () => {
  assert.equal(computeMaxSafeNumCtx({}), null);
  assert.equal(computeMaxSafeNumCtx({ totalVramMiB: 24576, usedVramMiB: 17501, modelWeightMiB: 17047, currentNumCtx: 0 }), null);
});

test('computeMaxSafeNumCtx never recommends shrinking below the current context', () => {
  // GPU nearly full: usable headroom after the safety margin is ~0.
  const result = computeMaxSafeNumCtx({
    totalVramMiB: 20000, usedVramMiB: 19900, modelWeightMiB: 17000, currentNumCtx: 8192,
  });
  assert.equal(result.maxSafeNumCtx, 8192);
});

test('computeMaxSafeNumCtx respects a larger safety margin fraction by leaving more headroom unclaimed', () => {
  const loose = computeMaxSafeNumCtx({ totalVramMiB: 24576, usedVramMiB: 17501, modelWeightMiB: 17047, currentNumCtx: 8192, safetyMarginFraction: 0.05 });
  const tight = computeMaxSafeNumCtx({ totalVramMiB: 24576, usedVramMiB: 17501, modelWeightMiB: 17047, currentNumCtx: 8192, safetyMarginFraction: 0.5 });
  assert.ok(loose.maxSafeNumCtx > tight.maxSafeNumCtx);
});

test('resolveNumCtx buckets a small prompt to the floor instead of always requesting the max', () => {
  const ctx = resolveNumCtx({ estimatedTokens: 300, numPredict: 1200, maxSafeNumCtx: 65536 });
  assert.equal(ctx, MIN_NUM_CTX);
});

test('resolveNumCtx buckets a large harness-grounded prompt up, clamped to what the GPU can afford', () => {
  const ctx = resolveNumCtx({ estimatedTokens: 20000, numPredict: 1200, maxSafeNumCtx: 24000 });
  assert.ok(ctx <= 24000);
  assert.ok(ctx >= 21200);
});

test('resolveNumCtx falls back to a plain power-of-two bucket when no live capacity snapshot exists', () => {
  const ctx = resolveNumCtx({ estimatedTokens: 5000, numPredict: 1200 });
  assert.equal(ctx, 8192);
});

test('resolveTimeoutMs scales down for a cheap short call instead of always returning the same fixed value', () => {
  const cheap = resolveTimeoutMs({ promptTokens: 200, numPredict: 200, tokensPerSecond: 37 });
  const heavy = resolveTimeoutMs({ promptTokens: 6000, numPredict: 1200, tokensPerSecond: 37 });
  assert.ok(cheap < heavy);
  assert.ok(cheap >= MIN_TIMEOUT_MS);
});

test('resolveTimeoutMs never exceeds the caller-supplied ceiling even for a huge workload', () => {
  const ms = resolveTimeoutMs({ promptTokens: 100000, numPredict: 100000, tokensPerSecond: 5, ceilingMs: 240_000 });
  assert.equal(ms, 240_000);
});

test('resolveTimeoutMs never exceeds ollama-http.js\'s documented 5-minute hard ceiling even if a caller passes a higher one', () => {
  const ms = resolveTimeoutMs({ promptTokens: 100000, numPredict: 100000, tokensPerSecond: 5, ceilingMs: 10_000_000 });
  assert.equal(ms, HARD_TIMEOUT_CEILING_MS);
});

test('resolveTimeoutMs falls back to a conservative floor tokens/sec when none is supplied', () => {
  const withMeasured = resolveTimeoutMs({ promptTokens: 1000, numPredict: 1000, tokensPerSecond: 100 });
  const withoutMeasured = resolveTimeoutMs({ promptTokens: 1000, numPredict: 1000, tokensPerSecond: undefined });
  assert.ok(withoutMeasured > withMeasured, 'an unmeasured machine should get a MORE generous timeout, not a tighter one');
});
