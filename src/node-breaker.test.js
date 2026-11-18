'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBreaker, isProviderError, envInt, DEFAULT_FAILS, DEFAULT_MIN } = require('./node-breaker.js');

// ---------- pure helpers ----------

test('isProviderError matches status === 429', () => {
  assert.equal(isProviderError({ status: 429 }), true);
  assert.equal(isProviderError({ status: 500 }), false);
  assert.equal(isProviderError({ status: 429, message: 'ok' }), true);
});

test('isProviderError matches message containing "429"', () => {
  assert.equal(isProviderError({ message: '429 too many requests' }), true);
  assert.equal(isProviderError({ message: 'Rate limit: 429' }), true);
  assert.equal(isProviderError({ message: 'HTTP 429 from provider' }), true);
  assert.equal(isProviderError({ message: 'HTTP 500' }), false);
  assert.equal(isProviderError({ message: '42' }), false);
});

test('isProviderError rejects non-objects, null and missing fields', () => {
  for (const bad of [null, undefined, 0, '', '429', [], true]) {
    assert.equal(isProviderError(bad), false, `expected false for ${JSON.stringify(bad)}`);
  }
  assert.equal(isProviderError({}), false);
  assert.equal(isProviderError({ status: '429' }), false, 'status must be numeric 429');
});

test('envInt returns the default for empty/missing/invalid values', () => {
  const orig = process.env.BREAKER_FAILS;
  delete process.env.BREAKER_FAILS;
  assert.equal(envInt('BREAKER_FAILS', 6), 6);
  process.env.BREAKER_FAILS = '';
  assert.equal(envInt('BREAKER_FAILS', 6), 6);
  process.env.BREAKER_FAILS = 'abc';
  assert.equal(envInt('BREAKER_FAILS', 6), 6);
  process.env.BREAKER_FAILS = '-1';
  assert.equal(envInt('BREAKER_FAILS', 6), 6);
  process.env.BREAKER_FAILS = '3.7';
  assert.equal(envInt('BREAKER_FAILS', 6), 4, 'rounded via Math.round');
  process.env.BREAKER_FAILS = '7';
  assert.equal(envInt('BREAKER_FAILS', 6), 7);
  if (orig === undefined) delete process.env.BREAKER_FAILS;
  else process.env.BREAKER_FAILS = orig;
});

test('DEFAULT_FAILS and DEFAULT_MIN are the documented numbers', () => {
  assert.equal(DEFAULT_FAILS, 6);
  assert.equal(DEFAULT_MIN, 30);
});

// ---------- factory & state machine ----------

let markerDir;
test.beforeEach(() => {
  markerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-breaker-'));
});
test.afterEach(() => {
  fs.rmSync(markerDir, { recursive: true, force: true });
});

test('6 consecutive provider failures pause claiming: CLOSED -> OPEN at threshold', () => {
  const breaker = createBreaker({ failsThreshold: 6, minMinutes: 30 });
  assert.equal(breaker.getState(), 'CLOSED');
  assert.equal(breaker.getFailures(), 0);
  assert.equal(breaker.getPause(), null);

  for (let i = 0; i < 5; i++) {
    const s = breaker.onLaneResult({ status: 429, message: 'rate limited' });
    assert.equal(s, 'CLOSED', `state after fail ${i + 1}`);
    assert.equal(breaker.getFailures(), i + 1);
  }

  const trip = breaker.onLaneResult({ status: 429, message: 'rate limited' });
  assert.equal(trip, 'OPEN');
  assert.equal(breaker.getFailures(), 6);
  const pause = breaker.getPause();
  assert.equal(pause.source, 'breaker');
  assert.ok(Number.isFinite(pause.resetsAt));
});

test('5 failures (below threshold) do NOT pause', () => {
  const breaker = createBreaker({ failsThreshold: 6, minMinutes: 30 });
  for (let i = 0; i < 5; i++) {
    breaker.onLaneResult({ status: 429, message: 'rate limited' });
  }
  assert.equal(breaker.getState(), 'CLOSED');
  assert.equal(breaker.getPause(), null);
  assert.equal(breaker.getFailures(), 5);
});

test('a foreign pause is not overwritten', () => {
  const breaker = createBreaker({ failsThreshold: 6, minMinutes: 30 });
  const now = Date.now();
  breaker.pause('external', now + 60_000);
  assert.equal(breaker.getState(), 'OPEN');
  const pause = breaker.getPause();
  assert.equal(pause.source, 'external');
  const probe = breaker.probeAt(now);
  assert.equal(typeof probe, 'string');
  breaker.clearPause();
  assert.equal(breaker.getState(), 'CLOSED');
  assert.equal(breaker.getPause(), null);
});

test('a foreign pause is not overwritten by a later pause from a different source', () => {
  const breaker = createBreaker({ failsThreshold: 6, minMinutes: 30 });
  const now = Date.now();
  breaker.pause('source-A', now + 60_000);
  assert.equal(breaker.getPause().source, 'source-A');
  // Try to extend with a different source -- should be ignored
  breaker.pause('source-B', now + 120_000);
  assert.equal(breaker.getPause().source, 'source-A', 'foreign pause not overwritten');
  assert.equal(breaker.getPause().resetsAt, now + 60_000, 'original resetsAt preserved');
});

test('the same source can extend its own pause forward', () => {
  const breaker = createBreaker({ failsThreshold: 6, minMinutes: 30 });
  const now = Date.now();
  breaker.pause('source-A', now + 60_000);
  breaker.pause('source-A', now + 120_000);
  assert.equal(breaker.getPause().resetsAt, now + 120_000, 'extended forward');
});

test('a same-source pause cannot shorten an existing pause', () => {
  const breaker = createBreaker({ failsThreshold: 6, minMinutes: 30 });
  const now = Date.now();
  breaker.pause('source-A', now + 120_000);
  breaker.pause('source-A', now + 60_000);
  assert.equal(breaker.getPause().resetsAt, now + 120_000, 'original preserved');
});

test('a success resets the failure count but leaves state OPEN until probe/clear', () => {
  const breaker = createBreaker({ failsThreshold: 6, minMinutes: 30 });
  for (let i = 0; i < 6; i++) {
    breaker.onLaneResult({ status: 429, message: 'rate limited' });
  }
  assert.equal(breaker.getState(), 'OPEN');
  assert.equal(breaker.getFailures(), 6);

  const afterSuccess = breaker.onLaneResult({ status: 200, message: 'ok' });
  assert.equal(afterSuccess, 'OPEN', 'state stays OPEN after a single success');
  assert.equal(breaker.getFailures(), 0, 'failure count resets to 0');
  assert.notEqual(breaker.getPause(), null, 'pause info still present');

  // clearPause() closes the breaker
  breaker.clearPause();
  assert.equal(breaker.getState(), 'CLOSED');
  assert.equal(breaker.getFailures(), 0);
  assert.equal(breaker.getPause(), null);
});

test('a non-provider error resets the failure count without tripping', () => {
  const breaker = createBreaker({ failsThreshold: 6, minMinutes: 30 });
  for (let i = 0; i < 5; i++) {
    breaker.onLaneResult({ status: 429, message: 'rate limited' });
  }
  assert.equal(breaker.getFailures(), 5);

  // HTTP 500 -- not a provider error, resets the counter
  const after500 = breaker.onLaneResult({ status: 500, message: 'HTTP 500 Internal Server Error' });
  assert.equal(after500, 'CLOSED');
  assert.equal(breaker.getFailures(), 0);

  // 5 more 429s should NOT trip (threshold is 6)
  for (let i = 0; i < 5; i++) {
    breaker.onLaneResult({ status: 429, message: 'rate limited' });
  }
  assert.equal(breaker.getState(), 'CLOSED');
  assert.equal(breaker.getFailures(), 5);
});

test('message text "429" triggers provider error classification', () => {
  const breaker = createBreaker({ failsThreshold: 2, minMinutes: 30 });
  // First failure with 429 in message
  breaker.onLaneResult({ message: 'Rate limit: 429 too many requests' });
  assert.equal(breaker.getFailures(), 1);
  // Second failure with 429 in message -- should trip
  breaker.onLaneResult({ message: '429 status from gateway' });
  assert.equal(breaker.getState(), 'OPEN');
  assert.equal(breaker.getFailures(), 2);
});

test('message text "HTTP 500" does NOT trigger provider error classification', () => {
  const breaker = createBreaker({ failsThreshold: 2, minMinutes: 30 });
  breaker.onLaneResult({ status: 500, message: 'HTTP 500 Internal Server Error' });
  assert.equal(breaker.getFailures(), 0, 'HTTP 500 resets count');
  assert.equal(breaker.getState(), 'CLOSED');
});

test('probeAt returns the earlier of resetsAt and now + minMinutes', () => {
  const breaker = createBreaker({ failsThreshold: 6, minMinutes: 30 });
  const now = Date.UTC(2026, 10, 11, 18, 0, 0);
  // Trip with a far-future resetsAt
  breaker.pause('breaker', now + 5 * 60_000); // 5 min from now
  const probe1 = breaker.probeAt(now);
  assert.equal(probe1, new Date(now + 5 * 60_000).toISOString(), 'uses resetsAt when earlier');

  // Trip with a near-future resetsAt
  breaker.clearPause();
  breaker.pause('breaker', now + 60 * 60_000); // 60 min from now
  const probe2 = breaker.probeAt(now);
  const minMs = 30 * 60 * 1000;
  assert.equal(probe2, new Date(now + minMs).toISOString(), 'uses now + minMinutes when earlier');
});

test('probeAt returns null when not paused', () => {
  const breaker = createBreaker({ failsThreshold: 6, minMinutes: 30 });
  assert.equal(breaker.probeAt(Date.now()), null);
});

test('probeAt returns null for a cleared pause', () => {
  const breaker = createBreaker({ failsThreshold: 6, minMinutes: 30 });
  const now = Date.now();
  breaker.pause('breaker', now + 60_000);
  assert.notEqual(breaker.probeAt(now), null);
  breaker.clearPause();
  assert.equal(breaker.probeAt(now), null);
});

test('onLaneResult with null/undefined/non-object returns state unchanged', () => {
  const breaker = createBreaker({ failsThreshold: 6, minMinutes: 30 });
  assert.equal(breaker.onLaneResult(null), 'CLOSED');
  assert.equal(breaker.onLaneResult(undefined), 'CLOSED');
  assert.equal(breaker.onLaneResult(429), 'CLOSED');
  assert.equal(breaker.onLaneResult('429'), 'CLOSED');
  assert.equal(breaker.getFailures(), 0);
});

test('pause with invalid source or resetsAt is a no-op', () => {
  const breaker = createBreaker({ failsThreshold: 6, minMinutes: 30 });
  breaker.pause('', Date.now() + 60_000);
  assert.equal(breaker.getPause(), null);
  breaker.pause(null, Date.now() + 60_000);
  assert.equal(breaker.getPause(), null);
  breaker.pause('x', 'not-a-number');
  assert.equal(breaker.getPause(), null);
  breaker.pause('x', NaN);
  assert.equal(breaker.getPause(), null);
});

test('createBreaker honors opts over env defaults', () => {
  const orig = process.env.AGENT_MANAGER_NODE_BREAKER_FAILS;
  process.env.AGENT_MANAGER_NODE_BREAKER_FAILS = '99';
  const breaker = createBreaker({ failsThreshold: 3, minMinutes: 5 });
  assert.equal(breaker.getFailures(), 0);
  // Trip at 3
  for (let i = 0; i < 3; i++) {
    breaker.onLaneResult({ status: 429 });
  }
  assert.equal(breaker.getState(), 'OPEN');
  if (orig === undefined) delete process.env.AGENT_MANAGER_NODE_BREAKER_FAILS;
  else process.env.AGENT_MANAGER_NODE_BREAKER_FAILS = orig;
});
