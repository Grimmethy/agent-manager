'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeNodes, formatSummary } = require('./node-status.js');

const MIN = 60 * 1000;
const NOW = Date.parse('2026-01-01T00:00:00.000Z');
const at = (ms) => new Date(NOW + ms).toISOString();
const node = (id, extra = {}) => ({ id, status: 'up', load: 0.5, freeRamGb: 8, ...extra });
const lease = (nodeId, state, expiresAt = at(10 * MIN)) => ({ taskId: 't', nodeId, state, expiresAt });
const HEADER = 'id status load freeRamGb lent returned expired merged nextExpiryMin';

test('counts per state, one row per node in input order', () => {
  const leases = [
    lease('a', 'lent'),
    lease('a', 'lent'),
    lease('a', 'returned'),
    lease('a', 'merged'),
    lease('a', 'merged'),
    lease('b', 'returned'),
  ];
  const rows = summarizeNodes([node('a'), node('b')], leases, NOW);
  assert.deepEqual(rows, [
    { id: 'a', status: 'up', load: 0.5, freeRamGb: 8, lentNow: 2, returned: 1, expired: 0, merged: 2, nextExpiryMin: 10 },
    { id: 'b', status: 'up', load: 0.5, freeRamGb: 8, lentNow: 0, returned: 1, expired: 0, merged: 0, nextExpiryMin: null },
  ]);
});

test('a lent lease whose expiresAt is not after now counts as expired by the clock', () => {
  const leases = [lease('a', 'lent', at(0)), lease('a', 'lent', at(-1000))];
  const [row] = summarizeNodes([node('a')], leases, NOW);
  assert.equal(row.expired, 2);
  assert.equal(row.lentNow, 0);
  assert.equal(row.nextExpiryMin, null);
});

test('nextExpiryMin rounds up: 59 s left is 1, 61 s left is 2, and the soonest live lease wins', () => {
  const one = summarizeNodes([node('a')], [lease('a', 'lent', at(59 * 1000))], NOW);
  assert.equal(one[0].nextExpiryMin, 1);
  const two = summarizeNodes([node('a')], [lease('a', 'lent', at(61 * 1000))], NOW);
  assert.equal(two[0].nextExpiryMin, 2);
  const soon = summarizeNodes([node('a')], [lease('a', 'lent', at(5 * MIN)), lease('a', 'lent', at(3 * MIN))], NOW);
  assert.equal(soon[0].nextExpiryMin, 3);
});

test('a node with no live lent lease has nextExpiryMin null', () => {
  const rows = summarizeNodes([node('a')], [lease('a', 'returned'), lease('a', 'merged')], NOW);
  assert.equal(rows[0].nextExpiryMin, null);
});

test('a lease whose nodeId matches no node is ignored', () => {
  const leases = [lease('ghost', 'lent'), lease('ghost', 'returned'), lease('ghost', 'lent', at(0))];
  const rows = summarizeNodes([node('a')], leases, NOW);
  assert.deepEqual(rows, [{ id: 'a', status: 'up', load: 0.5, freeRamGb: 8, lentNow: 0, returned: 0, expired: 0, merged: 0, nextExpiryMin: null }]);
});

test('a lent lease with an unparsable expiresAt counts as expired and never throws', () => {
  const rows = summarizeNodes([node('a')], [lease('a', 'lent', 'not-a-date')], NOW);
  assert.equal(rows[0].expired, 1);
  assert.equal(rows[0].lentNow, 0);
  assert.equal(rows[0].nextExpiryMin, null);
});

test('a non-array nodes throws TypeError("nodes must be an array")', () => {
  assert.throws(() => summarizeNodes({}, [], NOW), { name: 'TypeError', message: 'nodes must be an array' });
});

test('a non-array leases throws TypeError("leases must be an array")', () => {
  assert.throws(() => summarizeNodes([], 'none', NOW), { name: 'TypeError', message: 'leases must be an array' });
});

test('a non-finite now throws TypeError("now must be a finite number")', () => {
  for (const bad of [NaN, Infinity, '5', undefined]) {
    assert.throws(() => summarizeNodes([], [], bad), { name: 'TypeError', message: 'now must be a finite number' });
  }
});

test('formatSummary prints a null field as -', () => {
  const text = formatSummary([{ id: 'a', status: 'stale', load: null, freeRamGb: null, lentNow: 0, returned: 0, expired: 0, merged: 0, nextExpiryMin: null }]);
  assert.equal(text, `${HEADER}\na stale - - 0 0 0 0 -`);
});

test('formatSummary of an empty array is the header line only', () => {
  assert.equal(formatSummary([]), HEADER);
});

test("two state 'expired' rows plus a lent row already past expiresAt gives expired 3", () => {
  const leases = [lease('a', 'expired'), lease('a', 'expired'), lease('a', 'lent', at(-MIN))];
  const [row] = summarizeNodes([node('a')], leases, NOW);
  assert.equal(row.expired, 3);
  assert.equal(row.lentNow, 0);
  assert.equal(row.nextExpiryMin, null);
});

test("a state 'expired' row with a FUTURE expiresAt counts as expired, not lentNow, and leaves nextExpiryMin null", () => {
  const [row] = summarizeNodes([node('a')], [lease('a', 'expired', at(10 * MIN))], NOW);
  assert.equal(row.expired, 1);
  assert.equal(row.lentNow, 0);
  assert.equal(row.nextExpiryMin, null);
});

test("a state 'expired' row for an unknown nodeId is ignored", () => {
  const rows = summarizeNodes([node('a')], [lease('ghost', 'expired')], NOW);
  assert.deepEqual(rows, [{ id: 'a', status: 'up', load: 0.5, freeRamGb: 8, lentNow: 0, returned: 0, expired: 0, merged: 0, nextExpiryMin: null }]);
});
