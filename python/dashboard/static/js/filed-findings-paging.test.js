'use strict';

// Unit tests for filed-findings-paging.js footerText() and appendRows(). Pure functions, no DOM, no timers, no network.
//
// Run: node --test python/dashboard/static/js/filed-findings-paging.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { footerText, appendRows } = require('./filed-findings-paging.js');

test('footerText: zero total reads Showing 0 of 0', () => {
  assert.equal(footerText(0, 0), 'Showing 0 of 0');
});

test('footerText: 50 of 50 reads Showing 50 of 50', () => {
  assert.equal(footerText(50, 50), 'Showing 50 of 50');
});

test('footerText: 50 of 158 reads Showing 50 of 158', () => {
  assert.equal(footerText(50, 158), 'Showing 50 of 158');
});

test('appendRows: a row whose id is already rendered is skipped', () => {
  const out = appendRows(new Set(['a', 'b']), [{ id: 'a' }, { id: 'c' }]);
  assert.deepEqual(out.rows, [{ id: 'c' }]);
  assert.deepEqual([...out.renderedIds].sort(), ['a', 'b', 'c']);
});

test('appendRows: a row with a new id is kept', () => {
  const out = appendRows(new Set(['a']), [{ id: 'b' }]);
  assert.deepEqual(out.rows, [{ id: 'b' }]);
  assert.ok(out.renderedIds.has('a'));
  assert.ok(out.renderedIds.has('b'));
});

test('appendRows: a row shifted into the boundary after a deletion is appended exactly once', () => {
  // Page 1 rendered a, b, c. Row a is then deleted server-side, so the next
  // page (offset shifted) overlaps c and brings d into view.
  let state = appendRows(new Set(), [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  assert.equal(state.rows.length, 3);

  const second = appendRows(state.renderedIds, [{ id: 'c' }, { id: 'd' }]);
  assert.deepEqual(second.rows, [{ id: 'd' }]);
  state = second;

  // A later page overlaps d again; d must not be appended a second time.
  const third = appendRows(state.renderedIds, [{ id: 'd' }, { id: 'e' }]);
  assert.deepEqual(third.rows, [{ id: 'e' }]);

  const allAppended = [...appendRows(new Set(), [{ id: 'a' }, { id: 'b' }, { id: 'c' }]).rows,
    ...second.rows, ...third.rows].filter((r) => r.id === 'd');
  assert.equal(allAppended.length, 1);
});
