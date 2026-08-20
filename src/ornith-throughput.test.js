'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { recordSample, getTokensPerSecond, DEFAULT_TPS } = require('./ornith-throughput.js');

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
