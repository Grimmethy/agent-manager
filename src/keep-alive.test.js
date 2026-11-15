'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { NEVER_EXPIRE, parseKeepAliveMs, resolveKeepAlive } = require('./keep-alive.js');

test('default is the never-expire duration when nothing is supplied', () => {
  assert.equal(resolveKeepAlive(undefined, undefined), NEVER_EXPIRE);
  assert.equal(resolveKeepAlive('', null), NEVER_EXPIRE);
});
test('a value at least as long as 8760h is kept, the first supplied candidate wins', () => {
  assert.equal(resolveKeepAlive('8760h'), '8760h');
  assert.equal(resolveKeepAlive('9000h', '1m'), '9000h');
});
test('shorter, zero and unparseable values are ignored', () => {
  const warn = console.warn; const seen = []; console.warn = (m) => seen.push(m);
  try {
    for (const v of ['30m', '5m', '0', 0, '10s', 'banana', '1h30m']) assert.equal(resolveKeepAlive(v), NEVER_EXPIRE, String(v));
  } finally { console.warn = warn; }
  assert.equal(seen.length, 7);
});
test('negative one in either form means forever and normalises to the working string', () => {
  assert.equal(resolveKeepAlive(-1), NEVER_EXPIRE);
  assert.equal(resolveKeepAlive('-1'), NEVER_EXPIRE);
});
test('parseKeepAliveMs handles compound Go durations', () => {
  assert.equal(parseKeepAliveMs('1h30m'), 5400000);
  assert.equal(parseKeepAliveMs('90s'), 90000);
  assert.equal(parseKeepAliveMs('x'), null);
});
