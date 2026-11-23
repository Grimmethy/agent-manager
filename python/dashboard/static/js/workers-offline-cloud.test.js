// workers-offline-cloud.js: collapseOfflineCloud keeps one offline cloud row visible.
// Run: node --test python/dashboard/static/js/workers-offline-cloud.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { collapseOfflineCloud } = require('./workers-offline-cloud.js');

const w = (n, extra) => ({ instanceId: `worker-${n}`, provider: 'cloud', status: 'offline', ...extra });
const r = (n, extra) => ({ instanceId: `reviewer-${n}`, provider: 'local', status: 'offline', ...extra });

test('no cloud rows: all shown, none hidden', () => {
  const input = [
    { instanceId: 'worker-1', provider: 'local', status: 'online' },
    { instanceId: 'reviewer-1', provider: 'local', status: 'working' },
  ];
  const out = collapseOfflineCloud(input);
  assert.deepStrictEqual(out.shown, input);
  assert.deepStrictEqual(out.hidden, []);
});

test('ten offline cloud workers: keep worker-1, hide worker-2..10', () => {
  const input = Array.from({ length: 10 }, (_, i) => w(i + 1));
  const out = collapseOfflineCloud(input);
  assert.deepStrictEqual(out.shown, [w(1)]);
  assert.deepStrictEqual(out.hidden.map((i) => i.instanceId), ['worker-2', 'worker-3', 'worker-4', 'worker-5', 'worker-6', 'worker-7', 'worker-8', 'worker-9', 'worker-10']);
  // Contract: worker-cloud10 hidden after worker-cloud9
  const hiddenIds = out.hidden.map((i) => i.instanceId);
  assert.ok(hiddenIds.indexOf('worker-10') > hiddenIds.indexOf('worker-9'));
});

test('working, idle, stale, error cloud rows stay shown', () => {
  const working = w(1, { status: 'working' });
  const idle = w(2, { status: 'idle' });
  const stale = w(3, { status: 'stale' });
  const error = w(4, { status: 'error' });
  const offline = w(5);
  const out = collapseOfflineCloud([working, idle, stale, error, offline]);
  assert.deepStrictEqual(out.shown, [working, idle, stale, error, offline]);
  assert.deepStrictEqual(out.hidden, []);
});

test('offline cloud worker and its cloud reviewer: worker kept, reviewer hidden', () => {
  const rev = { instanceId: 'reviewer-2', provider: 'cloud', status: 'offline' };
  const wk = w(2);
  const out = collapseOfflineCloud([rev, wk]);
  assert.deepStrictEqual(out.shown, [wk]);
  assert.deepStrictEqual(out.hidden, [rev]);
});

test('local offline worker and reviewer rows are never hidden', () => {
  const localWorker = { instanceId: 'worker-1', provider: 'local', status: 'offline' };
  const localReviewer = { instanceId: 'reviewer-1', provider: 'local', status: 'offline' };
  const out = collapseOfflineCloud([localWorker, localReviewer]);
  assert.deepStrictEqual(out.shown, [localWorker, localReviewer]);
  assert.deepStrictEqual(out.hidden, []);
});

test('non-array input returns {shown: [], hidden: []}', () => {
  assert.deepStrictEqual(collapseOfflineCloud(null), { shown: [], hidden: [] });
  assert.deepStrictEqual(collapseOfflineCloud(undefined), { shown: [], hidden: [] });
  assert.deepStrictEqual(collapseOfflineCloud({}), { shown: [], hidden: [] });
  assert.deepStrictEqual(collapseOfflineCloud('string'), { shown: [], hidden: [] });
  assert.deepStrictEqual(collapseOfflineCloud(42), { shown: [], hidden: [] });
});

test('input array and rows are not mutated', () => {
  const input = [w(3), { instanceId: 'reviewer-3', provider: 'cloud', status: 'offline' }, w(1, { status: 'online' })];
  const before = JSON.stringify(input);
  collapseOfflineCloud(input);
  assert.strictEqual(JSON.stringify(input), before);
});
