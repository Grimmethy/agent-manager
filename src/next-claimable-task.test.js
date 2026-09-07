'use strict';

// Unit tests for next-claimable-task.js -- extracted from local-worker.sh's inline
// claim-ranking `node -e` script (2026-08-22 priority+mtime fix), with the operator
// "assign this task to this worker" pinnedWorker override added on top (2026-09-06,
// Grimmethy: "I need to be able to select the task I want each worker to run... this
// should override the automated system").
//
// Uses real registered task sources ('adhoc': priority 10, reasoningTier 'high';
// 'trouble_log': priority 20, no reasoningTier -> defaults to 'low') rather than mocking
// the registry, since requiring task-sources.js is how the module resolves priority/tier
// anyway (same as local-worker.sh's own removed inline script did).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { pickClaimableTasks, pickNextPendingTask, listAssignableTasks } = require('./next-claimable-task.js');

function setupPending() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'next-claimable-task-test-'));
  const pendingDir = path.join(root, 'queue', 'pending');
  fs.mkdirSync(pendingDir, { recursive: true });
  return pendingDir;
}

function setupQueue() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'next-claimable-task-test-'));
  const queueDir = path.join(root, 'queue');
  fs.mkdirSync(path.join(queueDir, 'pending'), { recursive: true });
  fs.mkdirSync(path.join(queueDir, 'drafting'), { recursive: true });
  return queueDir;
}

function writeDraftingTask(queueDir, lane, id, extra = {}) {
  const laneDir = path.join(queueDir, 'drafting', lane);
  fs.mkdirSync(laneDir, { recursive: true });
  const task = { id, source: 'trouble_log', promptContext: {}, ...extra };
  fs.writeFileSync(path.join(laneDir, `${id}.json`), JSON.stringify(task, null, 2));
  return task;
}

function writeTask(pendingDir, id, extra = {}) {
  const task = { id, source: 'trouble_log', promptContext: {}, ...extra };
  const p = path.join(pendingDir, `${id}.json`);
  fs.writeFileSync(p, JSON.stringify(task, null, 2));
  // Stagger mtimes deterministically -- writing several files in the same tick can land
  // on identical mtimeMs on a fast filesystem, which would make the mtime tie-break
  // assertions flaky.
  const bump = (writeTask._n = (writeTask._n || 0) + 1) * 10;
  const t = new Date(Date.now() - 100000 + bump);
  fs.utimesSync(p, t, t);
  return task;
}

test('with no pins, ranks by resolved source priority ascending, then mtime ascending', () => {
  const pendingDir = setupPending();
  writeTask(pendingDir, 'low-tier-a', { source: 'trouble_log' });     // priority 20
  writeTask(pendingDir, 'high-tier', { source: 'adhoc' });            // priority 10, reasoningTier high -- excluded from a non-reasoning lane
  writeTask(pendingDir, 'low-tier-b', { source: 'trouble_log' });     // priority 20, written after low-tier-a

  const items = pickClaimableTasks(pendingDir, 'worker-1', { isReasoningLane: false });

  assert.deepEqual(items, ['low-tier-a.json', 'low-tier-b.json']);
});

test('a reasoning lane claims only high-tier tasks; a non-reasoning lane skips them', () => {
  const pendingDir = setupPending();
  writeTask(pendingDir, 'reasoning-task', { source: 'adhoc' });
  writeTask(pendingDir, 'ordinary-task', { source: 'trouble_log' });

  const reasoningItems = pickClaimableTasks(pendingDir, 'worker-reasoning', { isReasoningLane: true });
  assert.deepEqual(reasoningItems, ['reasoning-task.json']);

  const ordinaryItems = pickClaimableTasks(pendingDir, 'worker-1', { isReasoningLane: false });
  assert.deepEqual(ordinaryItems, ['ordinary-task.json']);
});

test('a task pinned to this instance wins immediately, skipping tier filter and priority sort', () => {
  const pendingDir = setupPending();
  writeTask(pendingDir, 'high-priority', { source: 'adhoc' });                    // priority 10, but reasoningTier 'high' -- would normally be excluded from worker-1
  writeTask(pendingDir, 'pinned-low-priority', { source: 'trouble_log', pinnedWorker: 'worker-1' }); // priority 20, but pinned to worker-1

  const items = pickClaimableTasks(pendingDir, 'worker-1', { isReasoningLane: false });

  assert.deepEqual(items, ['pinned-low-priority.json']);
});

test('a task pinned to a DIFFERENT instance is excluded from this instance\'s candidates', () => {
  const pendingDir = setupPending();
  writeTask(pendingDir, 'pinned-elsewhere', { source: 'trouble_log', pinnedWorker: 'worker-reasoning' });
  writeTask(pendingDir, 'unpinned', { source: 'trouble_log' });

  const items = pickClaimableTasks(pendingDir, 'worker-1', { isReasoningLane: false });

  assert.deepEqual(items, ['unpinned.json']);

  // ...but the instance it WAS pinned to still sees it, ahead of everything else.
  const itemsForPinnedLane = pickClaimableTasks(pendingDir, 'worker-reasoning', { isReasoningLane: false });
  assert.deepEqual(itemsForPinnedLane, ['pinned-elsewhere.json', 'unpinned.json']);
});

test('multiple tasks pinned to the same instance are ordered oldest-first', () => {
  const pendingDir = setupPending();
  writeTask(pendingDir, 'pinned-first', { source: 'trouble_log', pinnedWorker: 'worker-1' });
  writeTask(pendingDir, 'pinned-second', { source: 'trouble_log', pinnedWorker: 'worker-1' });

  const items = pickClaimableTasks(pendingDir, 'worker-1', { isReasoningLane: false });

  assert.deepEqual(items, ['pinned-first.json', 'pinned-second.json']);
});

test('an unresolvable/unregistered source is not dropped -- sorts last with worst-case priority', () => {
  const pendingDir = setupPending();
  writeTask(pendingDir, 'known-source', { source: 'trouble_log' });
  writeTask(pendingDir, 'unknown-source', { source: 'this-source-does-not-exist' });

  const items = pickClaimableTasks(pendingDir, 'worker-1', { isReasoningLane: false });

  assert.deepEqual(items, ['known-source.json', 'unknown-source.json']);
});

test('a corrupt/unparseable task file is not dropped -- still listed, worst-case priority', () => {
  const pendingDir = setupPending();
  writeTask(pendingDir, 'known-source', { source: 'trouble_log' });
  fs.writeFileSync(path.join(pendingDir, 'corrupt.json'), '{not valid json');

  const items = pickClaimableTasks(pendingDir, 'worker-1', { isReasoningLane: false });

  assert.deepEqual(items, ['known-source.json', 'corrupt.json']);
});

test('an empty/missing pending directory returns an empty list, not a throw', () => {
  const pendingDir = setupPending();
  assert.deepEqual(pickClaimableTasks(pendingDir, 'worker-1', { isReasoningLane: false }), []);
  assert.deepEqual(pickClaimableTasks(path.join(pendingDir, 'does-not-exist'), 'worker-1', {}), []);
});

test('pickNextPendingTask returns only the single winner, or null when nothing is claimable', () => {
  const pendingDir = setupPending();
  assert.equal(pickNextPendingTask(pendingDir, 'worker-1', { isReasoningLane: false }), null);

  writeTask(pendingDir, 'only-one', { source: 'trouble_log' });
  assert.equal(pickNextPendingTask(pendingDir, 'worker-1', { isReasoningLane: false }), 'only-one.json');
});

// listAssignableTasks -- the Workers tab assign-task dropdown's real candidate source
// (2026-09-07, Grimmethy: "the only tasks I have access to... are pipeline debrief
// tasks. The task I want, autodecomp, is in drafting. I need access to the full list of
// available jobs, they should however be whats available for that specific worker type").

test('listAssignableTasks includes pending/ candidates, tier-filtered same as pickClaimableTasks', () => {
  const queueDir = setupQueue();
  writeTask(path.join(queueDir, 'pending'), 'ordinary', { source: 'trouble_log', title: 'Ordinary task' });
  writeTask(path.join(queueDir, 'pending'), 'reasoning-only', { source: 'adhoc', title: 'Reasoning task' });

  const items = listAssignableTasks(queueDir, 'worker-1', { isReasoningLane: false });

  assert.deepEqual(items, [{ id: 'ordinary', title: 'Ordinary task', source: 'trouble_log', location: 'pending' }]);
});

test('listAssignableTasks includes tier-matching tasks sitting in OTHER lanes\' drafting/, tagged with their location', () => {
  const queueDir = setupQueue();
  writeDraftingTask(queueDir, 'worker-reasoning-p40', 'stuck-elsewhere', { source: 'adhoc', title: 'Stuck task' });

  const items = listAssignableTasks(queueDir, 'worker-reasoning', { isReasoningLane: true });

  assert.deepEqual(items, [{ id: 'stuck-elsewhere', title: 'Stuck task', source: 'adhoc', location: 'drafting:worker-reasoning-p40' }]);
});

test('listAssignableTasks excludes this instance\'s OWN drafting/ contents -- reassigning to itself is a no-op', () => {
  const queueDir = setupQueue();
  writeDraftingTask(queueDir, 'worker-1', 'already-mine', { source: 'trouble_log' });
  writeDraftingTask(queueDir, 'worker-p40', 'someone-elses', { source: 'trouble_log' });

  const items = listAssignableTasks(queueDir, 'worker-1', { isReasoningLane: false });

  assert.deepEqual(items.map((i) => i.id), ['someone-elses']);
});

test('listAssignableTasks tier-filters drafting-elsewhere candidates the same as pending ones', () => {
  const queueDir = setupQueue();
  writeDraftingTask(queueDir, 'worker-reasoning-p40', 'high-tier-elsewhere', { source: 'adhoc' });

  assert.deepEqual(listAssignableTasks(queueDir, 'worker-1', { isReasoningLane: false }), []);
  assert.deepEqual(
    listAssignableTasks(queueDir, 'worker-reasoning', { isReasoningLane: true }).map((i) => i.id),
    ['high-tier-elsewhere'],
  );
});

test('listAssignableTasks: an empty/missing queue dir returns an empty list, not a throw', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'next-claimable-task-test-'));
  assert.deepEqual(listAssignableTasks(path.join(root, 'queue'), 'worker-1', { isReasoningLane: false }), []);
});
