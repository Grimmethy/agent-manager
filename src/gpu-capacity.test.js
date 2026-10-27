'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeMaxSafeNumCtx,
  resolveNumCtx,
  resolveTimeoutMs,
  MIN_NUM_CTX,
  PINNED_NUM_CTX,
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

// 2026-08-23 regression: resolveNumCtx() used to bucket UP per call based on that call's
// own prompt size (a 300-token prompt got MIN_NUM_CTX, a 20000-token one got a much
// bigger bucket) -- confirmed live that this was the direct cause of a severe hang: any
// request whose num_ctx exceeds whatever Ollama currently has resident hangs
// indefinitely rather than reloading cleanly. Fixed by pinning num_ctx to ONE stable
// value regardless of prompt size, so it stops varying call to call. See
// resolveNumCtx()'s own comment for the full incident.
test('resolveNumCtx returns the SAME pinned value for a small prompt as for a large one -- it no longer varies by prompt size', () => {
  const small = resolveNumCtx({ estimatedTokens: 300, numPredict: 1200, maxSafeNumCtx: 65536 });
  const large = resolveNumCtx({ estimatedTokens: 20000, numPredict: 1200, maxSafeNumCtx: 65536 });
  assert.equal(small, PINNED_NUM_CTX);
  assert.equal(large, PINNED_NUM_CTX);
});

test('resolveNumCtx clamps DOWN to maxSafeNumCtx on a box where the pinned value genuinely is not affordable', () => {
  const ctx = resolveNumCtx({ estimatedTokens: 20000, numPredict: 1200, maxSafeNumCtx: 10000 });
  assert.equal(ctx, 10000);
});

test('resolveNumCtx never clamps below MIN_NUM_CTX even if maxSafeNumCtx is reported smaller still', () => {
  const ctx = resolveNumCtx({ estimatedTokens: 300, numPredict: 100, maxSafeNumCtx: 512 });
  assert.equal(ctx, MIN_NUM_CTX);
});

test('resolveNumCtx falls back to the pinned value when no live capacity snapshot exists', () => {
  const ctx = resolveNumCtx({ estimatedTokens: 5000, numPredict: 1200 });
  assert.equal(ctx, PINNED_NUM_CTX);
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

// 2026-09-11, root-caused live ("p40 is entirely blocked by ollama timeouts"): the P40
// VM's Ollama endpoint is ~3.5x slower than the local RTX 3090 this 300s hard ceiling was
// calibrated to -- a 2800-token plan-pass generation alone needs ~301s at the P40's real
// ~9.3 tok/s, already past 300s before this function's own safety margin, so every real
// P40 call hit OLLAMA_TIMEOUT. hardCeilingMs is a deliberate, explicitly-named escape
// hatch (local-client.js's one caller that passes it) -- the test just above still holds
// for every caller that DOESN'T pass it, which is every other caller in this codebase.
test('resolveTimeoutMs honors an explicit hardCeilingMs override past the documented 300s ceiling -- the deliberate P40 exception', () => {
  const ms = resolveTimeoutMs({ promptTokens: 4000, numPredict: 2800, tokensPerSecond: 9.3, ceilingMs: 900_000, hardCeilingMs: 900_000 });
  assert.ok(ms > HARD_TIMEOUT_CEILING_MS, `a real P40-shaped call should get more than the 300s hard ceiling, got ${ms}`);
  assert.ok(ms <= 900_000, `still bounded by the explicit override, got ${ms}`);
});

test('resolveTimeoutMs defaults hardCeilingMs to the standard 300s ceiling when omitted -- every existing caller is unaffected', () => {
  const ms = resolveTimeoutMs({ promptTokens: 100000, numPredict: 100000, tokensPerSecond: 5, ceilingMs: 10_000_000 });
  assert.equal(ms, HARD_TIMEOUT_CEILING_MS);
});

test('resolveTimeoutMs falls back to a conservative floor tokens/sec when none is supplied', () => {
  const withMeasured = resolveTimeoutMs({ promptTokens: 1000, numPredict: 1000, tokensPerSecond: 100 });
  const withoutMeasured = resolveTimeoutMs({ promptTokens: 1000, numPredict: 1000, tokensPerSecond: undefined });
  assert.ok(withoutMeasured > withMeasured, 'an unmeasured machine should get a MORE generous timeout, not a tighter one');
});

test('one context for every call: the extended tier is folded into PINNED_NUM_CTX, and it is the raised (2026-09-20) 49152', () => {
  const { EXTENDED_NUM_CTX } = require('./gpu-capacity.js');
  assert.equal(PINNED_NUM_CTX, 49152);
  assert.equal(EXTENDED_NUM_CTX, PINNED_NUM_CTX);
});

// Per-lane pinned context (2026-10-17): a lane's registry numCtx reaches the lane process as AGENT_MANAGER_LANE_NUM_CTX.
test('laneNumCtx: a whole number >= MIN_NUM_CTX wins; unset, junk, fractions and too-small values are ignored (default pin kept)', () => {
  const { laneNumCtx, MIN_NUM_CTX, DEFAULT_PINNED_NUM_CTX } = require('./gpu-capacity.js');
  assert.equal(laneNumCtx({ AGENT_MANAGER_LANE_NUM_CTX: '16384' }), 16384);
  assert.equal(laneNumCtx({ AGENT_MANAGER_LANE_NUM_CTX: String(MIN_NUM_CTX) }), MIN_NUM_CTX);
  for (const bad of [undefined, '', 'abc', '16384.5', '1024', '-5', '0']) {
    assert.equal(laneNumCtx({ AGENT_MANAGER_LANE_NUM_CTX: bad }), null, `ignored: ${bad}`);
  }
  assert.equal(DEFAULT_PINNED_NUM_CTX, 49152, 'the 24 GB cards keep their pin');
});

test('PINNED_NUM_CTX is the lane override in a lane process and 49152 everywhere else; resolveNumCtx honors it', () => {
  const { execFileSync } = require('node:child_process');
  const probe = "const g=require('./src/gpu-capacity.js'); console.log(JSON.stringify({pin:g.PINNED_NUM_CTX, resolved:g.resolveNumCtx({estimatedTokens:100,numPredict:100,maxSafeNumCtx:0}), clamped:g.resolveNumCtx({estimatedTokens:1,numPredict:1,maxSafeNumCtx:4096})}))";
  const run = (extra) => JSON.parse(execFileSync(process.execPath, ['-e', probe], { cwd: require('node:path').join(__dirname, '..'), encoding: 'utf8', env: { ...process.env, AGENT_MANAGER_LANE_NUM_CTX: '', ...extra } }));
  assert.deepEqual(run({}), { pin: 49152, resolved: 49152, clamped: 4096 });
  assert.deepEqual(run({ AGENT_MANAGER_LANE_NUM_CTX: '16384' }), { pin: 16384, resolved: 16384, clamped: 4096 });
});

test('laneNumBatch reads AGENT_MANAGER_LANE_NUM_BATCH, whole numbers 32..8192 only', () => {
  const { laneNumBatch } = require('./gpu-capacity.js');
  assert.equal(laneNumBatch({ AGENT_MANAGER_LANE_NUM_BATCH: '1024' }), 1024);
  for (const bad of [undefined, '', 'x', '16', '9000', '1.5']) assert.equal(laneNumBatch({ AGENT_MANAGER_LANE_NUM_BATCH: bad }), null);
});
