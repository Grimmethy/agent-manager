'use strict';

// Unit tests for budget-monitor.js's estimate logic (Brain Dump #89, 2026-08-18): a real
// "(used/total ##%)" figure needs a real total, and Claude Code under a subscription
// never exposes one -- estimateBudgetCeiling()/estimateTimeToCap() instead learn an
// account-specific ceiling from real past rate-limit hits (every hit is a genuine data
// point: "this many tokens WAS enough to hit the cap"), never inventing a number. These
// tests exercise that logic directly against synthetic entry arrays -- no real transcript
// files or PROJECTS_DIR needed, same isolation reasoning as the rest of this module's
// (thin) surface already gets from its exported pure functions.
//
// Run: node --test budget-monitor.test.js  (or `npm test`)

const test = require('node:test');
const assert = require('node:assert/strict');
const { estimateBudgetCeiling, estimateTimeToCap } = require('./budget-monitor.js');

function usageEntry(ts, tokens) {
  return { _ts: ts, type: 'assistant', message: { usage: { input_tokens: tokens, output_tokens: 0 } } };
}

function rateLimitEntry(ts) {
  return { _ts: ts, error: 'rate_limit', message: { content: [{ text: 'hit' }] } };
}

const HOUR = 60 * 60 * 1000;

test('estimateBudgetCeiling returns null/0 samples when no rate-limit hits are present', () => {
  const entries = [usageEntry(1000, 500), usageEntry(2000, 500)];
  const result = estimateBudgetCeiling(entries);
  assert.deepEqual(result, { ceilingTokens: null, sampleCount: 0, samples: [] });
});

test('estimateBudgetCeiling sums usage strictly within the 5h window ending at a hit, excluding tokens outside it', () => {
  const hitTs = 10 * HOUR;
  const entries = [
    usageEntry(hitTs - 6 * HOUR, 999), // outside the 5h window -- must not count
    usageEntry(hitTs - 4 * HOUR, 100),
    usageEntry(hitTs - 1 * HOUR, 200),
    usageEntry(hitTs + 1 * HOUR, 999), // after the hit -- must not count
    rateLimitEntry(hitTs),
  ];
  const result = estimateBudgetCeiling(entries);
  assert.equal(result.sampleCount, 1);
  assert.equal(result.ceilingTokens, 300);
});

test('estimateBudgetCeiling uses the MAX across multiple real hits, not an average -- each hit is a real upper bound actually reached', () => {
  const entries = [
    usageEntry(1 * HOUR, 100),
    rateLimitEntry(1 * HOUR + 1),
    usageEntry(10 * HOUR, 900),
    rateLimitEntry(10 * HOUR + 1),
  ];
  const result = estimateBudgetCeiling(entries);
  assert.equal(result.sampleCount, 2);
  assert.equal(result.ceilingTokens, 900);
});

test('estimateBudgetCeiling also matches apiErrorStatus 429, the same alternate signal isBudgetHealthy() itself checks', () => {
  const entries = [usageEntry(1 * HOUR, 500), { _ts: 1 * HOUR + 1, apiErrorStatus: 429, message: {} }];
  const result = estimateBudgetCeiling(entries);
  assert.equal(result.ceilingTokens, 500);
});

test('estimateTimeToCap returns null when already at or over the estimated ceiling (no future cap to project)', () => {
  const now = 10 * HOUR;
  const entries = [usageEntry(now - 30 * 60 * 1000, 100)];
  assert.equal(estimateTimeToCap(entries, /* ceiling */ 500, /* used */ 500, now), null);
  assert.equal(estimateTimeToCap(entries, 500, 600, now), null);
});

test('estimateTimeToCap returns null when there is no usage in the last hour -- no rate to project from', () => {
  const now = 10 * HOUR;
  const entries = [usageEntry(now - 3 * HOUR, 100)]; // real usage, but outside the last hour
  assert.equal(estimateTimeToCap(entries, 1000, 100, now), null);
});

test('estimateTimeToCap projects forward using the last-hour token rate as tokens/hour', () => {
  const now = 10 * HOUR;
  // 100 tokens used in the last hour, 400 tokens remaining to the ceiling -> 4 hours out.
  const entries = [usageEntry(now - 30 * 60 * 1000, 100)];
  const result = estimateTimeToCap(entries, /* ceiling */ 1000, /* used */ 600, now);
  assert.ok(result, 'expected a projected timestamp, got null');
  const hoursOut = (new Date(result).getTime() - now) / HOUR;
  assert.ok(Math.abs(hoursOut - 4) < 0.01, `expected ~4 hours out, got ${hoursOut}`);
});

test('estimateTimeToCap ignores usage older than the last hour when computing the rate', () => {
  const now = 10 * HOUR;
  const entries = [
    usageEntry(now - 3 * HOUR, 10000), // old burst, must not inflate the rate
    usageEntry(now - 30 * 60 * 1000, 100), // only this counts
  ];
  const result = estimateTimeToCap(entries, 1000, 600, now);
  const hoursOut = (new Date(result).getTime() - now) / HOUR;
  assert.ok(Math.abs(hoursOut - 4) < 0.01, `expected ~4 hours out (old burst excluded), got ${hoursOut}`);
});
