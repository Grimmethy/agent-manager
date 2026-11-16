'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatRequestLine } = require('./node-request-log.js');

const AT = '2026-11-15T10:00:00.000Z';
const base = { route: '/claim', at: AT, nodeId: 'a1', status: 200, ms: 12 };
const line = (over) => formatRequestLine({ ...base, ...over });

test('one exact full line for each of the four routes', () => {
  assert.equal(line({ route: '/heartbeat' }), `${AT} /heartbeat node=a1 status=200 ms=12`);
  assert.equal(line({ route: '/claim' }), `${AT} /claim node=a1 status=200 ms=12`);
  assert.equal(line({ route: '/event' }), `${AT} /event node=a1 status=200 ms=12`);
  assert.equal(line({ route: '/release' }), `${AT} /release node=a1 status=200 ms=12`);
});

test('the line has no trailing newline', () => {
  assert.equal(line({}).endsWith('\n'), false);
});

test('a numeric at is converted with toISOString (0 is the epoch)', () => {
  assert.equal(line({ at: 0 }), '1970-01-01T00:00:00.000Z /claim node=a1 status=200 ms=12');
});

test('a bad nodeId prints node=-', () => {
  assert.equal(line({ nodeId: 'Bad_ID' }), `${AT} /claim node=- status=200 ms=12`);
  assert.equal(line({ nodeId: '-leading' }), `${AT} /claim node=- status=200 ms=12`);
  assert.equal(line({ nodeId: 'a'.repeat(32) }), `${AT} /claim node=- status=200 ms=12`);
  assert.equal(line({ nodeId: 7 }), `${AT} /claim node=- status=200 ms=12`);
});

test('a missing nodeId prints node=-', () => {
  const { nodeId, ...rest } = base;
  assert.equal(formatRequestLine(rest), `${AT} /claim node=- status=200 ms=12`);
});

test('ms is rounded with Math.round and negative values print as 0', () => {
  assert.equal(line({ ms: 12.5 }), `${AT} /claim node=a1 status=200 ms=13`);
  assert.equal(line({ ms: 0.4 }), `${AT} /claim node=a1 status=200 ms=0`);
  assert.equal(line({ ms: -3 }), `${AT} /claim node=a1 status=200 ms=0`);
});

test('status 100 and 599 are accepted', () => {
  assert.equal(line({ status: 100 }), `${AT} /claim node=a1 status=100 ms=12`);
  assert.equal(line({ status: 599 }), `${AT} /claim node=a1 status=599 ms=12`);
});

test('status 99, 600 and 200.5 are refused with a RangeError', () => {
  const want = { name: 'RangeError', message: 'status must be an integer from 100 to 599' };
  assert.throws(() => line({ status: 99 }), want);
  assert.throws(() => line({ status: 600 }), want);
  assert.throws(() => line({ status: 200.5 }), want);
});

test('extra properties on the argument are ignored and never printed', () => {
  const got = line({ token: 'secret-token', address: '10.0.0.1' });
  assert.equal(got, `${AT} /claim node=a1 status=200 ms=12`);
  assert.equal(got.includes('secret-token'), false);
  assert.equal(got.includes('10.0.0.1'), false);
});

test('an unknown route throws TypeError(unknown route)', () => {
  assert.throws(() => line({ route: '/status' }), { name: 'TypeError', message: 'unknown route' });
  assert.throws(() => formatRequestLine({}), { name: 'TypeError', message: 'unknown route' });
});

test('a bad at throws TypeError(at must be an ISO string or a number)', () => {
  const want = { name: 'TypeError', message: 'at must be an ISO string or a number' };
  assert.throws(() => line({ at: 'not a date' }), want);
  assert.throws(() => line({ at: NaN }), want);
  assert.throws(() => line({ at: Infinity }), want);
  assert.throws(() => line({ at: true }), want);
  assert.throws(() => line({ at: null }), want);
  assert.throws(() => line({ at: {} }), want);
  assert.throws(() => line({ at: undefined }), want);
});

test('a non-finite ms throws TypeError(ms must be a finite number)', () => {
  const want = { name: 'TypeError', message: 'ms must be a finite number' };
  assert.throws(() => line({ ms: NaN }), want);
  assert.throws(() => line({ ms: Infinity }), want);
  assert.throws(() => line({ ms: '12' }), want);
});
