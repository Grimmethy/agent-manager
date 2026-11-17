'use strict';

// Tests for src/lib/infra-refusal-streak.js. Pure helpers only: no network, no model host.

const test = require('node:test');
const assert = require('node:assert/strict');
const { isConnectionRefused, createRefusalStreak } = require('./infra-refusal-streak.js');

const REFUSED = { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:80' };
const OTHER = { code: 'ETIMEDOUT', message: 'timed out' };

test('isConnectionRefused detects refusals by code, cause.code, and message', () => {
  assert.equal(isConnectionRefused({ code: 'ECONNREFUSED' }), true);
  assert.equal(isConnectionRefused({ cause: { code: 'ECONNREFUSED' } }), true);
  assert.equal(isConnectionRefused({ message: 'connect ECONNREFUSED 127.0.0.1:80' }), true);
});

test('isConnectionRefused rejects other errors', () => {
  assert.equal(isConnectionRefused({ code: 'ETIMEDOUT' }), false);
  assert.equal(isConnectionRefused(null), false);
  assert.equal(isConnectionRefused({}), false);
});

test('default streak gives up on the third consecutive refusal', () => {
  const s = createRefusalStreak();
  assert.deepEqual(s.record(REFUSED), { refused: true, giveUp: false });
  assert.deepEqual(s.record(REFUSED), { refused: true, giveUp: false });
  assert.deepEqual(s.record(REFUSED), { refused: true, giveUp: true });
});

test('a non-refusal resets the streak and returns the exact non-refusal shape', () => {
  const s = createRefusalStreak();
  s.record(REFUSED);
  s.record(REFUSED);
  assert.deepEqual(s.record(OTHER), { refused: false, giveUp: false });
  assert.deepEqual(s.record(REFUSED), { refused: true, giveUp: false });
  assert.deepEqual(s.record(REFUSED), { refused: true, giveUp: false });
  assert.deepEqual(s.record(REFUSED), { refused: true, giveUp: true });
});

test('reset clears the count', () => {
  const s = createRefusalStreak();
  s.record(REFUSED);
  s.record(REFUSED);
  s.reset();
  assert.deepEqual(s.record(REFUSED), { refused: true, giveUp: false });
});

test('maxRefusals 0 gives up on the first refusal', () => {
  const s = createRefusalStreak({ maxRefusals: 0 });
  assert.deepEqual(s.record(REFUSED), { refused: true, giveUp: true });
});
