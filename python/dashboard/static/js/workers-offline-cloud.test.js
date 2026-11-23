// workers-offline-cloud.js: collapseOfflineCloud keeps one offline cloud row visible.
const test = require('node:test');
const assert = require('node:assert');
const { collapseOfflineCloud } = require('./workers-offline-cloud.js');

const w = (n, extra) => ({ instanceId: `worker-${n}`, provider: 'cloud', status: 'offline', ...extra });
const r = (n, extra) => ({ instanceId: `reviewer-${n}`, provider: 'local', status: 'offline', ...extra });

test('non-array input returns empty shown and hidden', () => {
  assert.deepStrictEqual(collapseOfflineCloud(null), { shown: [], hidden: [] });
  assert.deepStrictEqual(collapseOfflineCloud(undefined), { shown: [], hidden: [] });
  assert.deepStrictEqual(collapseOfflineCloud({}), { shown: [], hidden: [] });
});

test('offline cloud worker and its cloud reviewer: worker kept, reviewer hidden', () => {
  const rev = { instanceId: 'reviewer-2', provider: 'cloud', status: 'offline' };
  const wk = w(2);
  const out = collapseOfflineCloud([rev, wk]);
  assert.deepStrictEqual(out.shown, [wk]);
  assert.deepStrictEqual(out.hidden, [rev]);
});

test('several offline cloud workers: lowest numeric id is kept', () => {
  const a = w(10), b = w(2), c = w(3);
  const out = collapseOfflineCloud([a, b, c]);
  assert.deepStrictEqual(out.shown, [b]);
  assert.deepStrictEqual(out.hidden, [a, c]);
});

test('reviewer with no matching cloud worker is not cloud and stays shown', () => {
  const orphan = r(9);
  const out = collapseOfflineCloud([orphan, w(1)]);
  assert.deepStrictEqual(out.shown, [orphan, w(1)]);
  assert.deepStrictEqual(out.hidden, []);
});

test('online cloud rows are never hidden', () => {
  const online1 = w(1, { status: 'online' });
  const online2 = w(2, { status: 'online' });
  const off = w(3);
  const out = collapseOfflineCloud([online1, online2, off]);
  assert.deepStrictEqual(out.shown, [online1, online2, off]);
  assert.deepStrictEqual(out.hidden, []);
});

test('disabled counts as offline', () => {
  const a = w(1, { status: 'disabled' }), b = w(2, { status: 'disabled' });
  const out = collapseOfflineCloud([a, b]);
  assert.deepStrictEqual(out.shown, [a]);
  assert.deepStrictEqual(out.hidden, [b]);
});

test('non-object entries are shown unchanged', () => {
  const out = collapseOfflineCloud([null, 'x', w(1), w(2)]);
  assert.deepStrictEqual(out.shown, [null, 'x', w(1)]);
  assert.deepStrictEqual(out.hidden, [w(2)]);
});

test('input order preserved in shown and hidden', () => {
  const x = w(5);
  const local = { instanceId: 'worker-7', provider: 'local', status: 'offline' };
  const y = r(1);
  const z = w(4);
  const out = collapseOfflineCloud([x, local, y, z]);
  // worker-4 is the kept cloud row (lowest id); worker-5 is hidden.
  assert.deepStrictEqual(out.shown.map((i) => i.instanceId), ['worker-7', 'reviewer-1', 'worker-4']);
  assert.deepStrictEqual(out.hidden.map((i) => i.instanceId), ['worker-5']);
});

test('input array and rows are not mutated', () => {
  const input = [w(3), r(3, { provider: 'cloud' }), w(1, { status: 'online' })];
  const before = JSON.stringify(input);
  collapseOfflineCloud(input);
  assert.strictEqual(JSON.stringify(input), before);
});
