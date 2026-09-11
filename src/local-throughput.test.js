'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { recordSample, getTokensPerSecond, DEFAULT_TPS } = require('./local-throughput.js');

function tempInstancesDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ornith-throughput-test-'));
}

test('getTokensPerSecond returns the conservative floor when no sample has ever been recorded', () => {
  const dir = tempInstancesDir();
  assert.equal(getTokensPerSecond(dir), DEFAULT_TPS);
});

test('getTokensPerSecond returns the floor for a missing instancesDir instead of throwing', () => {
  assert.equal(getTokensPerSecond(null), DEFAULT_TPS);
  assert.equal(getTokensPerSecond(undefined), DEFAULT_TPS);
});

test('recordSample then getTokensPerSecond reflects a real measured rate', () => {
  const dir = tempInstancesDir();
  // 376 tokens in 10s of eval_duration -> 37.6 tok/s, matching this session's real observed rate.
  recordSample(dir, { evalCount: 376, evalDurationNs: 10_000_000_000 });
  const tps = getTokensPerSecond(dir);
  assert.ok(Math.abs(tps - 37.6) < 0.01);
});

test('recordSample blends a new sample with the prior EMA instead of only ever using the latest one', () => {
  const dir = tempInstancesDir();
  recordSample(dir, { evalCount: 400, evalDurationNs: 10_000_000_000 }); // 40 tok/s
  const first = getTokensPerSecond(dir);
  recordSample(dir, { evalCount: 200, evalDurationNs: 10_000_000_000 }); // 20 tok/s -- a genuine slowdown
  const second = getTokensPerSecond(dir);
  assert.ok(second < first, 'a slower sample should pull the average down');
  assert.ok(second > 20, 'one slow sample should not overwrite the whole history');
});

test('recordSample ignores a zero/garbage sample instead of corrupting the stored average', () => {
  const dir = tempInstancesDir();
  recordSample(dir, { evalCount: 400, evalDurationNs: 10_000_000_000 }); // 40 tok/s, real
  recordSample(dir, { evalCount: 0, evalDurationNs: 0 });
  recordSample(dir, { evalCount: 400, evalDurationNs: 0 }); // divide-by-zero shaped
  assert.equal(getTokensPerSecond(dir), 40);
});

test('recordSample on an unwritable dir does not throw', () => {
  assert.doesNotThrow(() => recordSample('/nonexistent/deeply/nested/path', { evalCount: 100, evalDurationNs: 1_000_000_000 }));
});

// 2026-09-11, root-caused live ("p40 is entirely blocked by ollama timeouts"): one
// shared file mixed samples from the local RTX 3090 (~35 tok/s) and the P40 VM's own,
// much slower Ollama instance (~9.3 tok/s) into a single EMA -- the P40's real speed
// never surfaced because the local GPU's samples, from far more frequent local-worker
// calls, dominated. Every P40 call's timeout was then calibrated to the fast GPU's
// throughput, causing 100% of real worker-p40/worker-reasoning-p40 calls to hit
// OLLAMA_TIMEOUT. Keying by endpoint isolates the two.
test('recordSample/getTokensPerSecond are isolated per endpoint -- a fast local GPU sample never pollutes a slow P40 endpoint\'s estimate, or vice versa', () => {
  const dir = tempInstancesDir();
  recordSample(dir, { evalCount: 3500, evalDurationNs: 10_000_000_000, endpoint: 'http://localhost:11434' }); // 350 tok/s, fast local GPU
  recordSample(dir, { evalCount: 93, evalDurationNs: 10_000_000_000, endpoint: 'http://192.168.122.29:11434' }); // 9.3 tok/s, the P40

  const localTps = getTokensPerSecond(dir, 'http://localhost:11434');
  const p40Tps = getTokensPerSecond(dir, 'http://192.168.122.29:11434');
  assert.ok(Math.abs(localTps - 350) < 0.01, `local endpoint should read its own fast rate, got ${localTps}`);
  assert.ok(Math.abs(p40Tps - 9.3) < 0.01, `P40 endpoint should read its own slow rate, unpolluted by the local GPU, got ${p40Tps}`);
});

test('getTokensPerSecond with no endpoint argument keeps today\'s unkeyed behavior (backward compatible)', () => {
  const dir = tempInstancesDir();
  recordSample(dir, { evalCount: 400, evalDurationNs: 10_000_000_000 }); // no endpoint -- the original shared-file shape
  assert.equal(getTokensPerSecond(dir), 40);
});
