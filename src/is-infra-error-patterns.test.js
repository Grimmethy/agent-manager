'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isInfraError } = require('./blocked-task-classifiers.js');

// Positives -- every wording named in the HUB0195 spec must trip isInfraError.
test('isInfraError matches "HTTP 503"', () => {
  assert.equal(isInfraError({ blockedReason: 'request failed: HTTP 503' }), true);
});

test('isInfraError matches "HTTP/1.1 502"', () => {
  assert.equal(isInfraError({ blockedReason: 'request failed: HTTP/1.1 502' }), true);
});

test('isInfraError matches "status 500"', () => {
  assert.equal(isInfraError({ blockedReason: 'response: status 500' }), true);
});

test('isInfraError matches "status: 504"', () => {
  assert.equal(isInfraError({ blockedReason: 'response: status: 504' }), true);
});

test('isInfraError matches "status code 502"', () => {
  assert.equal(isInfraError({ blockedReason: 'response: status code 502' }), true);
});

test('isInfraError matches "Service Unavailable"', () => {
  assert.equal(isInfraError({ blockedReason: 'upstream: Service Unavailable' }), true);
});

test('isInfraError matches "Bad Gateway"', () => {
  assert.equal(isInfraError({ blockedReason: 'upstream: Bad Gateway' }), true);
});

test('isInfraError matches "Gateway Timeout"', () => {
  assert.equal(isInfraError({ blockedReason: 'upstream: Gateway Timeout' }), true);
});

test('isInfraError matches errno signal (ECONNRESET)', () => {
  assert.equal(isInfraError({ blockedReason: 'fetch failed: ECONNRESET' }), true);
});

test('isInfraError matches "apparent infra outage" signal', () => {
  assert.equal(isInfraError({ blockedReason: 'draft call failed on an apparent infra outage' }), true);
});

// Negatives -- bare 5xx numbers in non-HTTP contexts must NOT trip isInfraError.
test('isInfraError rejects "The draft cites src/foo.js:512 which does not exist"', () => {
  assert.equal(isInfraError({ blockedReason: 'The draft cites src/foo.js:512 which does not exist' }), false);
});

test('isInfraError rejects "fact-check: 3 of 540 criteria failed"', () => {
  assert.equal(isInfraError({ blockedReason: 'fact-check: 3 of 540 criteria failed' }), false);
});

test('isInfraError rejects "the draft changes 520 lines but the task asks for one"', () => {
  assert.equal(isInfraError({ blockedReason: 'the draft changes 520 lines but the task asks for one' }), false);
});

test('isInfraError rejects "line 540"', () => {
  assert.equal(isInfraError({ blockedReason: 'error at line 540' }), false);
});

test('isInfraError rejects "src/a.js:599"', () => {
  assert.equal(isInfraError({ blockedReason: 'missing src/a.js:599' }), false);
});

test('isInfraError rejects "512 tests passed"', () => {
  assert.equal(isInfraError({ blockedReason: '512 tests passed' }), false);
});
