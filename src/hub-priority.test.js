'use strict';

// Unit tests for hub-priority.js -- the shared ordering rule the Hub Tasks tab AND the
// worker claim path (nextAdhocTask, next-claimable-task.js) both use, so they can never
// disagree about which hub is "next" (2026-09-09, Grimmethy: "The highest priority hub
// should always be worked on next until it is either ready to merge or gets blocked").

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  UNRANKED_HUB_PRIORITY,
  normalizeHubPriority,
  hubIdForTask,
  readHubOrderKey,
  hubOrderKeyForTask,
  compareHubKeys,
  hubHasUnmergedEarlierSibling,
} = require('./hub-priority.js');

function makePipeline() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-priority-test-'));
  fs.mkdirSync(path.join(dir, 'queue', 'coordinating'), { recursive: true });
  return dir;
}
const writeHub = (dir, hub) =>
  fs.writeFileSync(path.join(dir, 'queue', 'coordinating', `${hub.id}.json`), JSON.stringify(hub));

test('normalizeHubPriority coerces to an integer, or null for anything non-numeric', () => {
  assert.equal(normalizeHubPriority(5), 5);
  assert.equal(normalizeHubPriority('12'), 12);
  assert.equal(normalizeHubPriority(3.9), 3);
  assert.equal(normalizeHubPriority(-2), -2);
  assert.equal(normalizeHubPriority(null), null);
  assert.equal(normalizeHubPriority(undefined), null);
  assert.equal(normalizeHubPriority(''), null);
  assert.equal(normalizeHubPriority('abc'), null);
  assert.equal(normalizeHubPriority(NaN), null);
});

test('hubIdForTask prefers parentHub, then promptContext.decomposedFrom, else null', () => {
  assert.equal(hubIdForTask({ parentHub: 'hub-a', promptContext: { decomposedFrom: 'hub-b' } }), 'hub-a');
  assert.equal(hubIdForTask({ promptContext: { decomposedFrom: 'hub-b' } }), 'hub-b');
  assert.equal(hubIdForTask({ parentHub: '  ' , promptContext: { decomposedFrom: 'hub-b' } }), 'hub-b');
  assert.equal(hubIdForTask({}), null);
  assert.equal(hubIdForTask(null), null);
});

test('readHubOrderKey reads hubPriority + createdAt from a live coordinating record', () => {
  const dir = makePipeline();
  writeHub(dir, { id: 'hub-1', hubPriority: 7, createdAt: '2026-09-09T00:00:00Z' });
  const key = readHubOrderKey(dir, 'hub-1');
  assert.deepEqual(key, { found: true, rank: 7, createdAt: '2026-09-09T00:00:00Z' });
});

test('readHubOrderKey treats a hub with no hubPriority as unranked (rank = UNRANKED_HUB_PRIORITY)', () => {
  const dir = makePipeline();
  writeHub(dir, { id: 'hub-1', createdAt: '2026-09-09T00:00:00Z' });
  const key = readHubOrderKey(dir, 'hub-1');
  assert.equal(key.found, true);
  assert.equal(key.rank, UNRANKED_HUB_PRIORITY);
});

test('readHubOrderKey returns not-found for a hub id with no coordinating record', () => {
  const dir = makePipeline();
  const key = readHubOrderKey(dir, 'hub-long-gone');
  assert.equal(key.found, false);
  assert.equal(key.rank, UNRANKED_HUB_PRIORITY);
  assert.equal(key.createdAt, null);
});

test('readHubOrderKey uses the cache Map instead of re-reading the file', () => {
  const dir = makePipeline();
  writeHub(dir, { id: 'hub-1', hubPriority: 3 });
  const cache = new Map();
  readHubOrderKey(dir, 'hub-1', cache);
  fs.rmSync(path.join(dir, 'queue', 'coordinating', 'hub-1.json'));
  const second = readHubOrderKey(dir, 'hub-1', cache); // file gone, but cache still has it
  assert.equal(second.rank, 3);
});

test('hubOrderKeyForTask flags isHubChild only when a live hub backs the link', () => {
  const dir = makePipeline();
  writeHub(dir, { id: 'hub-live', hubPriority: 2, createdAt: '2026-09-08T00:00:00Z' });

  const live = hubOrderKeyForTask(dir, { parentHub: 'hub-live' });
  assert.deepEqual(live, { isHubChild: true, rank: 2, createdAt: '2026-09-08T00:00:00Z' });

  const orphan = hubOrderKeyForTask(dir, { promptContext: { decomposedFrom: 'hub-gone' } });
  assert.equal(orphan.isHubChild, false);

  const nohub = hubOrderKeyForTask(dir, { id: 'plain-task' });
  assert.equal(nohub.isHubChild, false);
});

test('compareHubKeys: explicit priority ascending, then createdAt ascending, missing createdAt last', () => {
  const lower = { rank: 1, createdAt: '2026-09-09T00:00:00Z' };
  const higher = { rank: 40, createdAt: '2026-01-01T00:00:00Z' };
  assert.ok(compareHubKeys(lower, higher) < 0, 'rank 1 beats rank 40 regardless of createdAt');

  const older = { rank: UNRANKED_HUB_PRIORITY, createdAt: '2026-08-01T00:00:00Z' };
  const newer = { rank: UNRANKED_HUB_PRIORITY, createdAt: '2026-09-01T00:00:00Z' };
  assert.ok(compareHubKeys(older, newer) < 0, 'same rank -> older hub first (FIFO)');

  const noDate = { rank: UNRANKED_HUB_PRIORITY, createdAt: null };
  assert.ok(compareHubKeys(older, noDate) < 0, 'a hub with a createdAt sorts ahead of one without');
  assert.equal(compareHubKeys(newer, newer), 0);
});

test('an array of hub keys sorts into priority-then-age order', () => {
  const keys = [
    { id: 'd', rank: UNRANKED_HUB_PRIORITY, createdAt: '2026-09-05T00:00:00Z' },
    { id: 'b', rank: 10, createdAt: '2026-09-09T00:00:00Z' },
    { id: 'c', rank: UNRANKED_HUB_PRIORITY, createdAt: '2026-09-01T00:00:00Z' },
    { id: 'a', rank: 5, createdAt: '2026-01-01T00:00:00Z' },
  ];
  keys.sort(compareHubKeys);
  assert.deepEqual(keys.map((k) => k.id), ['a', 'b', 'c', 'd']);
});

// hubHasUnmergedEarlierSibling (2026-09-18, pipeline hardening -- see its own header for
// the real incident: a 3-sub-task hub's LAST sub-task burned 3 real drafting attempts
// while its two earlier siblings sat approved-but-unmerged at pending-merge, because its
// own draft/review ran against a checkout that didn't have their code yet).
test('hubHasUnmergedEarlierSibling: false for a task with no hub link at all', () => {
  const dir = makePipeline();
  assert.equal(hubHasUnmergedEarlierSibling(dir, { id: 'plain-task' }).blocked, false);
});

test('hubHasUnmergedEarlierSibling: false when the hub record cannot be read', () => {
  const dir = makePipeline();
  const task = { id: 'child-1', parentHub: 'hub-does-not-exist' };
  assert.equal(hubHasUnmergedEarlierSibling(dir, task).blocked, false);
});

test('hubHasUnmergedEarlierSibling: false when the task is not listed in its hub\'s subTasks', () => {
  const dir = makePipeline();
  writeHub(dir, { id: 'hub-1', subTasks: [{ id: 'other-child', status: 'in-progress' }] });
  const task = { id: 'child-1', parentHub: 'hub-1' };
  assert.equal(hubHasUnmergedEarlierSibling(dir, task).blocked, false);
});

test('hubHasUnmergedEarlierSibling: false for the FIRST sub-task in hub order (nothing earlier)', () => {
  const dir = makePipeline();
  writeHub(dir, {
    id: 'hub-1',
    subTasks: [
      { id: 'child-0', status: 'in-progress' },
      { id: 'child-1', status: 'pending-merge' },
    ],
  });
  const task = { id: 'child-0', parentHub: 'hub-1' };
  assert.equal(hubHasUnmergedEarlierSibling(dir, task).blocked, false);
});

// Mirrors the real incident exactly: sub-task 2 dependsOn sub-task 0, but sub-task 1
// (undeclared as a dependency) ALSO hadn't merged -- the hub-order check catches it
// regardless of which specific dependsOn edges were declared.
test('hubHasUnmergedEarlierSibling: true when an earlier sibling is pending-merge (the real incident shape)', () => {
  const dir = makePipeline();
  writeHub(dir, {
    id: 'hub-fact-checker',
    subTasks: [
      { id: 'emit-warning-flag-0', status: 'pending-merge' },
      { id: 'guard-review-gate-1', status: 'pending-merge' },
      { id: 'update-fact-checker-tests-2', status: 'in-progress' },
    ],
  });
  const task = { id: 'update-fact-checker-tests-2', parentHub: 'hub-fact-checker' };
  const result = hubHasUnmergedEarlierSibling(dir, task);
  assert.equal(result.blocked, true);
  // Reports the FIRST (lowest-indexed) unmerged sibling, not just "something" is unmerged.
  assert.equal(result.blockingSiblingId, 'emit-warning-flag-0');
  assert.equal(result.blockingSiblingStatus, 'pending-merge');
});

test('hubHasUnmergedEarlierSibling: false once every earlier sibling has actually reached merged', () => {
  const dir = makePipeline();
  writeHub(dir, {
    id: 'hub-1',
    subTasks: [
      { id: 'child-0', status: 'merged' },
      { id: 'child-1', status: 'merged' },
      { id: 'child-2', status: 'in-progress' },
    ],
  });
  const task = { id: 'child-2', parentHub: 'hub-1' };
  assert.equal(hubHasUnmergedEarlierSibling(dir, task).blocked, false);
});

test('hubHasUnmergedEarlierSibling: "abandoned" and "gone" earlier siblings do not block -- nothing left to wait for', () => {
  const dir = makePipeline();
  writeHub(dir, {
    id: 'hub-1',
    subTasks: [
      { id: 'child-0', status: 'abandoned' },
      { id: 'child-1', status: 'gone' },
      { id: 'child-2', status: 'in-progress' },
    ],
  });
  const task = { id: 'child-2', parentHub: 'hub-1' };
  assert.equal(hubHasUnmergedEarlierSibling(dir, task).blocked, false);
});

// Confirmed live via a real dry run against the live queue before this shipped: 8 real
// tasks across 5 hubs would have been held FOREVER without this -- each earlier sibling
// had already resolved as 'noop' (or similar), a status that never produces a branch to
// merge, so waiting for it to specifically reach 'merged' would never happen.
test('hubHasUnmergedEarlierSibling: every non-pending-merge terminal disposition is treated as resolved, not just merged/abandoned', () => {
  const dir = makePipeline();
  for (const status of ['applied-direct', 'filed', 'dismissed', 'noop', 'superseded']) {
    writeHub(dir, {
      id: `hub-${status}`,
      subTasks: [
        { id: 'child-0', status },
        { id: 'child-1', status: 'in-progress' },
      ],
    });
    const task = { id: 'child-1', parentHub: `hub-${status}` };
    assert.equal(hubHasUnmergedEarlierSibling(dir, task).blocked, false, `status '${status}' must count as resolved`);
  }
});

test('hubHasUnmergedEarlierSibling: "pending-merge" is the one terminal status that still blocks -- real code exists and genuinely has not landed', () => {
  const dir = makePipeline();
  writeHub(dir, {
    id: 'hub-1',
    subTasks: [
      { id: 'child-0', status: 'pending-merge' },
      { id: 'child-1', status: 'in-progress' },
    ],
  });
  const task = { id: 'child-1', parentHub: 'hub-1' };
  const result = hubHasUnmergedEarlierSibling(dir, task);
  assert.equal(result.blocked, true);
  assert.equal(result.blockingSiblingStatus, 'pending-merge');
});

test('hubHasUnmergedEarlierSibling: a "blocked" earlier sibling still blocks the later one', () => {
  const dir = makePipeline();
  writeHub(dir, {
    id: 'hub-1',
    subTasks: [
      { id: 'child-0', status: 'blocked' },
      { id: 'child-1', status: 'in-progress' },
    ],
  });
  const task = { id: 'child-1', parentHub: 'hub-1' };
  const result = hubHasUnmergedEarlierSibling(dir, task);
  assert.equal(result.blocked, true);
  assert.equal(result.blockingSiblingId, 'child-0');
});

test('hubHasUnmergedEarlierSibling: resolves the hub via promptContext.decomposedFrom when parentHub is absent', () => {
  const dir = makePipeline();
  writeHub(dir, {
    id: 'hub-1',
    subTasks: [
      { id: 'child-0', status: 'pending-merge' },
      { id: 'child-1', status: 'in-progress' },
    ],
  });
  const task = { id: 'child-1', promptContext: { decomposedFrom: 'hub-1' } };
  assert.equal(hubHasUnmergedEarlierSibling(dir, task).blocked, true);
});

// PropertyForager function-length-fix-ac-2 (2026-09-20): piece 1 of a stacked chain reached `pending-merge` on the shared branch, its
// `dependsOn` was satisfied by the stacked exemption, and this net still held piece 2 -- waiting for a human to merge a half-built branch.
// A stacked child's draft and review read the shared branch tip, so an earlier sibling pending-merge ON THAT BRANCH is already visible.
function stackedHub(dir, { p1Status = 'pending-merge', p1Stacked = { branch: 'agent/decompose-hub-x', seq: 1, total: 2 }, writeP1 = true } = {}) {
  fs.mkdirSync(path.join(dir, 'queue', 'done'), { recursive: true });
  writeHub(dir, { id: 'hub-x', subTasks: [{ id: 'p1', status: p1Status }, { id: 'p2', status: 'in-progress' }] });
  if (writeP1) fs.writeFileSync(path.join(dir, 'queue', 'done', 'p1.json'), JSON.stringify({ id: 'p1', terminalDisposition: 'pending-merge', ...(p1Stacked ? { stacked: p1Stacked } : {}) }));
}
const p2 = (stacked) => ({ id: 'p2', promptContext: { decomposedFrom: 'hub-x' }, ...(stacked ? { stacked } : {}) });
const SAME = { branch: 'agent/decompose-hub-x', seq: 2, total: 2 };

test('hubHasUnmergedEarlierSibling: a STACKED child is not held by an earlier sibling that is pending-merge on the SAME branch', () => {
  const dir = makePipeline();
  stackedHub(dir);
  assert.deepEqual(hubHasUnmergedEarlierSibling(dir, p2(SAME)), { blocked: false });
});

test('hubHasUnmergedEarlierSibling: the #340 shape still holds -- a NON-stacked child waits for a pending-merge sibling', () => {
  const dir = makePipeline();
  stackedHub(dir);
  const r = hubHasUnmergedEarlierSibling(dir, p2(null));
  assert.equal(r.blocked, true);
  assert.equal(r.blockingSiblingId, 'p1');
  assert.equal(r.blockingSiblingStatus, 'pending-merge');
});

test('hubHasUnmergedEarlierSibling: a stacked child on a DIFFERENT branch than its pending-merge sibling still waits', () => {
  const dir = makePipeline();
  stackedHub(dir);
  assert.equal(hubHasUnmergedEarlierSibling(dir, p2({ branch: 'agent/decompose-some-other-hub', seq: 2, total: 2 })).blocked, true);
});

test('hubHasUnmergedEarlierSibling: the exemption is ONLY for pending-merge -- a stacked child still waits for a sibling that has not finished', () => {
  for (const status of ['in-progress', 'blocked', 'needs-clarification']) {
    const dir = makePipeline();
    stackedHub(dir, { p1Status: status });
    assert.equal(hubHasUnmergedEarlierSibling(dir, p2(SAME)).blocked, true, status);
  }
});

test('hubHasUnmergedEarlierSibling: a pending-merge sibling that is NOT stacked (or whose record is missing) still holds a stacked child', () => {
  const noStack = makePipeline();
  stackedHub(noStack, { p1Stacked: null });
  assert.equal(hubHasUnmergedEarlierSibling(noStack, p2(SAME)).blocked, true);
  const missing = makePipeline();
  stackedHub(missing, { writeP1: false });
  assert.equal(hubHasUnmergedEarlierSibling(missing, p2(SAME)).blocked, true);
});

test('hubHasUnmergedEarlierSibling: in a 3-piece chain, a stacked piece 3 is released only when BOTH earlier pieces are pending-merge on its branch', () => {
  const dir = makePipeline();
  fs.mkdirSync(path.join(dir, 'queue', 'done'), { recursive: true });
  writeHub(dir, { id: 'hub-x', subTasks: [{ id: 'p1', status: 'pending-merge' }, { id: 'p2', status: 'in-progress' }, { id: 'p3', status: 'in-progress' }] });
  const branch = 'agent/decompose-hub-x';
  fs.writeFileSync(path.join(dir, 'queue', 'done', 'p1.json'), JSON.stringify({ id: 'p1', stacked: { branch, seq: 1, total: 3 } }));
  const p3 = { id: 'p3', promptContext: { decomposedFrom: 'hub-x' }, stacked: { branch, seq: 3, total: 3 } };
  assert.equal(hubHasUnmergedEarlierSibling(dir, p3).blockingSiblingId, 'p2', 'p2 has not finished yet');
  writeHub(dir, { id: 'hub-x', subTasks: [{ id: 'p1', status: 'pending-merge' }, { id: 'p2', status: 'pending-merge' }, { id: 'p3', status: 'in-progress' }] });
  fs.writeFileSync(path.join(dir, 'queue', 'done', 'p2.json'), JSON.stringify({ id: 'p2', stacked: { branch, seq: 2, total: 3 } }));
  assert.equal(hubHasUnmergedEarlierSibling(dir, p3).blocked, false);
});
