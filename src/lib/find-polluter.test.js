'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { findPolluter } = require('./find-polluter.js');

// A fake clone: runSubset dirties it when the subset contains the polluter; resetClone cleans it.
function monotoneClone(polluter) {
  const state = { dirty: false, resets: 0 };
  return {
    state,
    resetClone() { state.dirty = false; state.resets += 1; },
    runSubset(list) { if (list.includes(polluter)) state.dirty = true; },
    isDirty() { return state.dirty; },
  };
}

test('a clean full run returns no polluter', () => {
  const clone = monotoneClone(null);
  const res = findPolluter({ testFiles: ['a.test.js', 'b.test.js'], ...clone });
  assert.equal(res.polluter, null);
  assert.equal(res.inconclusive, false);
  assert.equal(res.probes, 1);
});

test('an empty file list returns no polluter and runs nothing', () => {
  const clone = monotoneClone('x');
  const res = findPolluter({ testFiles: [], ...clone });
  assert.equal(res.polluter, null);
  assert.equal(res.inconclusive, false);
  assert.equal(res.probes, 0);
});

test('a single polluter in the middle is named, with a logarithmic probe count', () => {
  const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const clone = monotoneClone('e');
  const res = findPolluter({ testFiles: files, ...clone });
  assert.equal(res.polluter, 'e');
  assert.equal(res.inconclusive, false);
  // 1 full-run check + ceil(log2(8)) bisect steps + 2 boundary confirmations
  assert.ok(res.probes <= 1 + 3 + 2, `probes=${res.probes}`);
});

test('a polluter at the first and last index are both named', () => {
  assert.equal(findPolluter({ testFiles: ['p', 'a', 'b'], ...monotoneClone('p') }).polluter, 'p');
  assert.equal(findPolluter({ testFiles: ['a', 'b', 'p'], ...monotoneClone('p') }).polluter, 'p');
});

test('resetClone is called before every probe', () => {
  const clone = monotoneClone('c');
  const res = findPolluter({ testFiles: ['a', 'b', 'c', 'd'], ...clone });
  assert.equal(clone.state.resets, res.probes);
});

test('a non-monotone (flaky) clone is inconclusive, never a guessed name', () => {
  // Dirties only on the first run that includes 'p'; every later run is clean.
  let dirtyOnce = true;
  const state = { dirty: false };
  const res = findPolluter({
    testFiles: ['a', 'b', 'c', 'p', 'd'],
    resetClone() { state.dirty = false; },
    runSubset(list) {
      if (list.includes('p') && dirtyOnce) { state.dirty = true; dirtyOnce = false; }
    },
    isDirty() { return state.dirty; },
  });
  assert.equal(res.polluter, null);
  assert.equal(res.inconclusive, true);
});
