'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Outbox, parseCursor } = require('./outbox.js');

test('replay from cursor, then live; append during replay is ordered, no dupes', () => {
  const ob = new Outbox();
  ob.append('a');
  ob.append('b');
  const got = [];
  ob.subscribe({
    cursor: 1,
    onEvent: (e) => { got.push(e); if (e === 'b') ob.append('c'); },
  });
  ob.append('d');
  assert.deepEqual(got, ['b', 'c', 'd']);
});

test('close delivers the final event last and rejects later appends', () => {
  const ob = new Outbox();
  const got = [];
  ob.subscribe({ cursor: 0, onEvent: (e) => got.push(e) });
  ob.append('x');
  ob.close({ type: 'end' });
  assert.deepEqual(got, ['x', { type: 'end' }]);
  assert.throws(() => ob.append('y'));
});

test('cursor below retained buffer yields gap before replay', () => {
  const ob = new Outbox({ maxEntries: 2 });
  ['a', 'b', 'c', 'd'].forEach((e) => ob.append(e));
  const got = [];
  ob.subscribe({ cursor: 0, onEvent: (e) => got.push(e) });
  assert.deepEqual(got, [{ type: 'gap', lowest: 2 }, 'c', 'd']);
});

test('cursor -1 is tail: no replay, live only', () => {
  const ob = new Outbox();
  ob.append('old');
  const got = [];
  ob.subscribe({ cursor: -1, onEvent: (e) => got.push(e) });
  assert.deepEqual(got, []);
  ob.append('new');
  assert.deepEqual(got, ['new']);
});

test('parseCursor treats invalid values as 0', () => {
  assert.equal(parseCursor(undefined), 0);
  assert.equal(parseCursor('abc'), 0);
  assert.equal(parseCursor('2.5'), 0);
  assert.equal(parseCursor('-5'), 0);
  assert.equal(parseCursor('-1'), -1);
  assert.equal(parseCursor('3'), 3);
});
