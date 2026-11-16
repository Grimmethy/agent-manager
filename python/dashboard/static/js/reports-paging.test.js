'use strict';

// Unit tests for reports-paging.js paging helpers. Pure functions, no DOM, timers or filesystem.
//
// Run: node --test python/dashboard/static/js/reports-paging.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { nextOffset, hasMore, appendPage, buildListUrl } = require('./reports-paging.js');

test('nextOffset advances by pageSize', () => {
  assert.equal(nextOffset(0, 50), 50);
  assert.equal(nextOffset(50, 50), 100);
  assert.equal(nextOffset(-5, 50), 50);
});

test('hasMore is true while loaded is below total', () => {
  assert.equal(hasMore(50, 120), true);
  assert.equal(hasMore(0, 1), true);
});

test('hasMore is false when loadedCount equals total', () => {
  assert.equal(hasMore(120, 120), false);
  assert.equal(hasMore(0, 0), false);
  assert.equal(hasMore(NaN, 5), false);
});

test('appendPage appends new items after existing ones', () => {
  const existing = [{ period: '2026-10', filename: 'a.md' }];
  const out = appendPage(existing, [{ period: '2026-10', filename: 'b.md' }]);
  assert.deepEqual(out.map((r) => r.filename), ['a.md', 'b.md']);
});

test('appendPage drops items matching both period and filename; existing wins', () => {
  const existing = [{ period: '2026-10', filename: 'a.md', tag: 'old' }];
  const out = appendPage(existing, [{ period: '2026-10', filename: 'a.md', tag: 'new' }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].tag, 'old');
});

test('appendPage keeps items differing in only period or only filename', () => {
  const existing = [{ period: '2026-10', filename: 'a.md' }];
  const out = appendPage(existing, [
    { period: '2026-09', filename: 'a.md' },
    { period: '2026-10', filename: 'b.md' },
  ]);
  assert.equal(out.length, 3);
});

test('appendPage collapses duplicates within the page and does not mutate existing', () => {
  const existing = [{ period: 'p', filename: 'x' }];
  const out = appendPage(existing, [
    { period: 'p', filename: 'y' },
    { period: 'p', filename: 'y' },
  ]);
  assert.equal(out.length, 2);
  assert.equal(existing.length, 1);
  assert.notStrictEqual(out, existing);
});

test('buildListUrl omits period when none is given', () => {
  const expected = '/api/reports?limit=50&offset=100';
  assert.equal(buildListUrl(50, 100), expected);
  assert.equal(buildListUrl(50, 100, ''), expected);
  assert.equal(buildListUrl(50, 100, undefined), expected);
  assert.ok(!buildListUrl(50, 100).includes('period'));
});

test('buildListUrl includes period when given, encoded', () => {
  assert.equal(buildListUrl(50, 0, '2026-10'), '/api/reports?limit=50&offset=0&period=2026-10');
  assert.ok(buildListUrl(50, 0, 'a b&c').endsWith('&period=a%20b%26c'));
});
