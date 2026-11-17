'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyApplyFailure,
  APPLY_INFRA_DELAYS_MS,
  applyWithInfraRetry,
} = require('./apply-infra.js');

test('content failures classify as content', () => {
  assert.equal(classifyApplyFailure('git apply: error: patch does not apply'), 'content');
  assert.equal(classifyApplyFailure('CONFLICT (content): Merge conflict in x'), 'content');
  assert.equal(classifyApplyFailure(undefined), 'content');
});

test('infra failures classify as infra', () => {
  assert.equal(classifyApplyFailure('fatal: timed out after 60000ms'), 'infra');
  assert.equal(classifyApplyFailure('Error: ECONNRESET'), 'infra');
});

test('delays are 15s, 45s, 120s totalling 180s', () => {
  assert.deepEqual(APPLY_INFRA_DELAYS_MS, [15000, 45000, 120000]);
  assert.equal(APPLY_INFRA_DELAYS_MS.reduce((a, b) => a + b, 0), 180000);
});

test('infra failure twice then success retries twice', async () => {
  const results = [
    { succeeded: false, reason: 'fatal: timed out after 60000ms' },
    { succeeded: false, reason: 'Error: ECONNRESET' },
    { succeeded: true },
  ];
  const sleeps = [];
  const out = await applyWithInfraRetry(async () => results.shift(), {
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.equal(out.succeeded, true);
  assert.equal(out.infraRetries, 2);
  assert.equal(out.infraExhausted, false);
  assert.deepEqual(sleeps, [15000, 45000]);
});

test('persistent infra failure exhausts retries', async () => {
  let calls = 0;
  const out = await applyWithInfraRetry(async () => {
    calls += 1;
    return { succeeded: false, reason: 'Error: ETIMEDOUT' };
  }, { sleep: async () => {} });
  assert.equal(out.infraExhausted, true);
  assert.equal(out.infraRetries, 3);
  assert.equal(calls, 4);
});

test('content failure makes exactly one call', async () => {
  let calls = 0;
  const out = await applyWithInfraRetry(async () => {
    calls += 1;
    return { succeeded: false, reason: 'git apply: error: patch does not apply' };
  }, { sleep: async () => { throw new Error('should not sleep'); } });
  assert.equal(calls, 1);
  assert.equal(out.infraRetries, 0);
  assert.equal(out.infraExhausted, false);
});
