'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { applySlotReleases } = require('./node-slot-release.js');

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const MIN = 60 * 60000;

function lease(minsAgo, state = 'lent') {
  return { taskId: 't', nodeId: 'n1', state, leasedAt: new Date(NOW - minsAgo * 60000).toISOString() };
}
function rec(id, extra = {}) {
  return { id, leasedTo: 'n1', ...extra };
}

test('unclaimed record past the threshold is released with reason', () => {
  const out = applySlotReleases([rec('a')], NOW, { leases: { a: lease(90) } });
  assert.strictEqual(out.released.length, 1);
  assert.strictEqual(out.released[0].reason, 'unclaimed-on-node');
  assert.strictEqual(out.released[0].taskId, 'a');
  assert.strictEqual(out.released[0].nodeId, 'n1');
});

test('unclaimed record younger than the threshold is kept', () => {
  const out = applySlotReleases([rec('a')], NOW, { leases: { a: lease(10) } });
  assert.strictEqual(out.released.length, 0);
  assert.strictEqual(out.kept.length, 1);
});

test('exactly at the threshold is kept', () => {
  const out = applySlotReleases([rec('a')], NOW, { leases: { a: lease(60) } });
  assert.strictEqual(out.released.length, 0);
});

test('claimed record is kept', () => {
  const out = applySlotReleases([rec('a', { claimedAt: 'x' })], NOW, { leases: { a: lease(300) } });
  assert.strictEqual(out.released.length, 0);
});

test('drafting record is never released', () => {
  const out = applySlotReleases([rec('a', { drafting: true }), rec('b', { status: 'drafting' })], NOW,
    { leases: { a: lease(300), b: lease(300) } });
  assert.strictEqual(out.released.length, 0);
});

test('heartbeat record is never released', () => {
  const out = applySlotReleases([rec('a', { heartbeat: { pid: 1 } })], NOW, { leases: { a: lease(300) } });
  assert.strictEqual(out.released.length, 0);
});

test('record with no lease row cannot be aged and is kept', () => {
  const out = applySlotReleases([rec('a')], NOW, { leases: {} });
  assert.strictEqual(out.released.length, 0);
});

test('returned lease is not released', () => {
  const out = applySlotReleases([rec('a')], NOW, { leases: { a: lease(300, 'returned') } });
  assert.strictEqual(out.released.length, 0);
});

test('malformed rows are skipped', () => {
  const out = applySlotReleases([null, 5, { leasedTo: 'n1' }, rec('a')], NOW, { leases: { a: lease(300) } });
  assert.strictEqual(out.released.length, 1);
});

test('bad top-level arguments throw TypeError', () => {
  assert.throws(() => applySlotReleases({}, NOW, {}), TypeError);
  assert.throws(() => applySlotReleases([], NaN, {}), TypeError);
});

test('custom threshold overrides the default', () => {
  const opts = { leases: { a: lease(90) }, unclaimedMin: 120 };
  assert.strictEqual(applySlotReleases([rec('a')], NOW, opts).released.length, 0);
  const env = { leases: { a: lease(90) }, env: { AGENT_MANAGER_NODE_UNCLAIMED_MIN: '30' } };
  assert.strictEqual(applySlotReleases([rec('a')], NOW, env).released.length, 1);
});

test('input is not mutated', () => {
  const records = [rec('a')];
  const snapshot = JSON.stringify(records);
  applySlotReleases(records, NOW, { leases: { a: lease(300) } });
  assert.strictEqual(JSON.stringify(records), snapshot);
});
