const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('./hub-retire-project.js');

const ok = async () => ({ close: true });

test('same hubId under two repoRoots gets distinct keys and both retire', async () => {
  const hubs = [{ hubId: 'H1', repoRoot: '/a' }, { hubId: 'H1', repoRoot: '/b' }];
  assert.notEqual(m.keyFor('/a', 'H1'), m.keyFor('/b', 'H1'));
  const res = await m.runBatch(hubs, ok);
  assert.equal(res.archived.length, 2);
  assert.equal(res.left.length, 0);
});

test('child with a different repoRoot is not linked and stays top-level', () => {
  const hubs = [{ hubId: 'C', repoRoot: '/b', parentHub: 'P' }, { hubId: 'P', repoRoot: '/a' }];
  const order = m.nestedRetireOrder(hubs);
  assert.equal(order.length, hubs.length);
  assert.deepEqual(order.map((h) => h.hubId), ['C', 'P']);
});

test('refusal stops the batch and reports the rest as not attempted', async () => {
  const hubs = [{ hubId: 'A', repoRoot: '/r' }, { hubId: 'B', repoRoot: '/r' }, { hubId: 'C', repoRoot: '/r' }];
  let calls = 0;
  const fn = async (h) => {
    calls += 1;
    return h.hubId === 'B' ? { close: false, message: 'nope' } : { close: true };
  };
  const res = await m.runBatch(hubs, fn);
  assert.deepEqual(res.archived.map((h) => h.hubId), ['A']);
  assert.equal(res.left[0].hubId, 'B');
  assert.equal(res.left[0].attempted, true);
  assert.equal(res.left[0].reason, 'nope');
  assert.equal(res.left[1].hubId, 'C');
  assert.equal(res.left[1].attempted, false);
  assert.equal(res.notAttempted, 1);
  assert.equal(calls, 2);
});

test('thrown error is treated as a refusal and the batch stops', async () => {
  const hubs = [{ hubId: 'A', repoRoot: '/r' }, { hubId: 'B', repoRoot: '/r' }];
  const fn = async () => { throw new Error('boom'); };
  const res = await m.runBatch(hubs, fn);
  assert.equal(res.archived.length, 0);
  assert.equal(res.left[0].attempted, true);
  assert.equal(res.left[0].reason, 'boom');
  assert.equal(res.left[1].attempted, false);
});

test('same-root child sorts before its parent', () => {
  const hubs = [{ hubId: 'P', repoRoot: '/a' }, { hubId: 'C', repoRoot: '/a', parentHub: 'P' }];
  assert.deepEqual(m.nestedRetireOrder(hubs).map((h) => h.hubId), ['C', 'P']);
});

test('retireUrl encodes the repo root', () => {
  assert.equal(m.retireUrl('a&b#c'), '?project=a%26b%23c');
});

test('archived plus left always equals input length', async () => {
  const inputs = [
    [],
    [{ hubId: 'X', repoRoot: '/r' }],
    [{ hubId: 'X', repoRoot: '/r' }, { hubId: 'Y', repoRoot: '/s' }, { hubId: 'Z', repoRoot: '/r' }]
  ];
  for (const hubs of inputs) {
    const res = await m.runBatch(hubs, async () => ({ close: false, message: 'no' }));
    assert.equal(res.archived.length + res.left.length, hubs.length);
  }
});
