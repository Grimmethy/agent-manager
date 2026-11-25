'use strict';

// Unit tests for staleCodeState (src/stale-code.js), the single place the 24-hour
// stale-code threshold lives. Inputs are fixed ISO 8601 literals and offsets are
// derived arithmetically from a fixed base, so results never depend on the wall clock.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { staleCodeState } = require('../src/stale-code.js');

const PRIMARY_DATE = '2026-11-01T00:00:00Z';
const PRIMARY_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OLDER_SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HOUR_MS = 60 * 60 * 1000;

function dateBefore(iso, ms) {
  return new Date(Date.parse(iso) - ms).toISOString();
}

test('same sha returns current', () => {
  assert.equal(
    staleCodeState({ nodeSha: PRIMARY_SHA, nodeDate: PRIMARY_DATE, primarySha: PRIMARY_SHA, primaryDate: PRIMARY_DATE }),
    'current',
  );
});

test('older sha within 24 hours returns current', () => {
  assert.equal(
    staleCodeState({
      nodeSha: OLDER_SHA,
      nodeDate: dateBefore(PRIMARY_DATE, 1 * HOUR_MS),
      primarySha: PRIMARY_SHA,
      primaryDate: PRIMARY_DATE,
    }),
    'current',
  );
});

test('older sha beyond 24 hours returns stale', () => {
  assert.equal(
    staleCodeState({
      nodeSha: OLDER_SHA,
      nodeDate: dateBefore(PRIMARY_DATE, 25 * HOUR_MS),
      primarySha: PRIMARY_SHA,
      primaryDate: PRIMARY_DATE,
    }),
    'stale',
  );
});

test('missing nodeSha returns unknown', () => {
  assert.equal(
    staleCodeState({ nodeSha: '', nodeDate: PRIMARY_DATE, primarySha: PRIMARY_SHA, primaryDate: PRIMARY_DATE }),
    'unknown',
  );
});

test('missing nodeDate returns unknown', () => {
  assert.equal(
    staleCodeState({ nodeSha: OLDER_SHA, nodeDate: '', primarySha: PRIMARY_SHA, primaryDate: PRIMARY_DATE }),
    'unknown',
  );
});

test('missing primarySha returns unknown', () => {
  assert.equal(
    staleCodeState({ nodeSha: OLDER_SHA, nodeDate: PRIMARY_DATE, primarySha: '', primaryDate: PRIMARY_DATE }),
    'unknown',
  );
});

test('missing primaryDate returns unknown', () => {
  assert.equal(
    staleCodeState({ nodeSha: OLDER_SHA, nodeDate: PRIMARY_DATE, primarySha: PRIMARY_SHA, primaryDate: '' }),
    'unknown',
  );
});
