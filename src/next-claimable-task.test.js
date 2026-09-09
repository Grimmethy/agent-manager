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

const { pickClaimableTasks, pickNextPendingTask, listAssignableTasks, effectivePriority, BOT_ADHOC_PRIORITY_PENALTY } = require('./next-claimable-task.js');
const { resolveSourceName } = require('./task-source-registry.js');

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

// --- effectivePriority (bot-vs-human adhoc split + premiumPriority pin, 2026-09-07) ---

test('effectivePriority: an adhoc task with no humanQueued marker is demoted by BOT_ADHOC_PRIORITY_PENALTY', () => {
  const p = effectivePriority({ source: 'adhoc' }, 10, resolveSourceName);
  assert.equal(p, 10 + BOT_ADHOC_PRIORITY_PENALTY);
});

test('effectivePriority: an adhoc task with humanQueued:true keeps the base source priority', () => {
  const p = effectivePriority({ source: 'adhoc', humanQueued: true }, 10, resolveSourceName);
  assert.equal(p, 10);
});

test('effectivePriority: a non-adhoc source is never touched by the bot-adhoc penalty regardless of humanQueued', () => {
  assert.equal(effectivePriority({ source: 'trouble_log' }, 20, resolveSourceName), 20);
  assert.equal(effectivePriority({ source: 'trouble_log', humanQueued: false }, 20, resolveSourceName), 20);
});

test('effectivePriority: premiumPriority always wins, -Infinity, regardless of source or humanQueued', () => {
  assert.equal(effectivePriority({ source: 'adhoc', premiumPriority: true }, 10, resolveSourceName), -Infinity);
  assert.equal(effectivePriority({ source: 'trouble_log', premiumPriority: true }, 20, resolveSourceName), -Infinity);
});

test('pickClaimableTasks: a derived_task ranks at its own registered priority (48), not adhoc 10 + the bot penalty', () => {
  const pendingDir = setupPending();
  writeTask(pendingDir, 'human-adhoc', { source: 'adhoc', domain: 'adhoc', humanQueued: true });     // 10
  writeTask(pendingDir, 'bot-adhoc', { source: 'adhoc', domain: 'adhoc' });                           // 10 + 30 = 40
  writeTask(pendingDir, 'derived', { source: 'derived_task', domain: 'adhoc',                         // 48 -- its OWN row
    promptContext: { rawText: 'x', derivedFrom: { source: 'pipeline_debrief' } } });

  const items = pickClaimableTasks(pendingDir, 'worker-reasoning', { isReasoningLane: true });

  assert.deepEqual(items, ['human-adhoc.json', 'bot-adhoc.json', 'derived.json']);
});

test('pickClaimableTasks: a human-queued adhoc task is claimed before a bot-originated one of the same source, oldest-bot-first tie-break still applies within each tier', () => {
  const pendingDir = setupPending();
  writeTask(pendingDir, 'bot-adhoc-a', { source: 'adhoc' });                          // no humanQueued -> demoted
  writeTask(pendingDir, 'human-adhoc', { source: 'adhoc', humanQueued: true });       // stays at base priority 10
  writeTask(pendingDir, 'bot-adhoc-b', { source: 'adhoc' });

  const items = pickClaimableTasks(pendingDir, 'worker-reasoning', { isReasoningLane: true });

  assert.deepEqual(items, ['human-adhoc.json', 'bot-adhoc-a.json', 'bot-adhoc-b.json']);
});

test('pickClaimableTasks: premiumPriority puts a task ahead of everything, including a human-queued adhoc task and an unrelated higher-priority source', () => {
  const pendingDir = setupPending();
  writeTask(pendingDir, 'human-adhoc', { source: 'adhoc', humanQueued: true });
  writeTask(pendingDir, 'bot-adhoc', { source: 'adhoc' });
  writeTask(pendingDir, 'premium-low-tier', { source: 'trouble_log', premiumPriority: true }); // priority 20 normally, but pinned to the front

  const items = pickClaimableTasks(pendingDir, 'worker-1', { isReasoningLane: false });

  // worker-1 is not a reasoning lane, so the two adhoc (high-tier) tasks are excluded --
  // only premium-low-tier is a candidate at all, proving the pin doesn't bypass the tier
  // filter (it only affects ORDER among tier-eligible candidates).
  assert.deepEqual(items, ['premium-low-tier.json']);
});

test('pickClaimableTasks: premiumPriority sorts ahead of an ordinary same-tier task even when the ordinary task is older', () => {
  const pendingDir = setupPending();
  writeTask(pendingDir, 'ordinary-older', { source: 'trouble_log' });
  writeTask(pendingDir, 'premium-newer', { source: 'trouble_log', premiumPriority: true });

  const items = pickClaimableTasks(pendingDir, 'worker-1', { isReasoningLane: false });

  assert.deepEqual(items, ['premium-newer.json', 'ordinary-older.json']);
});

test('pickClaimableTasks: premiumPriority persists through the ranking even though it is not pinnedWorker -- any lane can claim it', () => {
  const pendingDir = setupPending();
  writeTask(pendingDir, 'premium-unpinned', { source: 'trouble_log', premiumPriority: true });

  const forWorker1 = pickClaimableTasks(pendingDir, 'worker-1', { isReasoningLane: false });
  assert.deepEqual(forWorker1, ['premium-unpinned.json']);
});

test('listAssignableTasks: surfaces premiumPriority on both pending and drafting-elsewhere items', () => {
  const queueDir = setupQueue();
  writeTask(path.join(queueDir, 'pending'), 'premium-pending', { source: 'trouble_log', premiumPriority: true });
  writeDraftingTask(queueDir, 'worker-2', 'premium-drafting', { premiumPriority: true });
  writeDraftingTask(queueDir, 'worker-2', 'ordinary-drafting', {});

  const items = listAssignableTasks(queueDir, 'worker-1', { isReasoningLane: false });
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));

  assert.equal(byId['premium-pending'].premiumPriority, true);
  assert.equal(byId['premium-drafting'].premiumPriority, true);
  assert.equal(byId['ordinary-drafting'].premiumPriority, false);
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

  assert.deepEqual(items, [{ id: 'ordinary', title: 'Ordinary task', source: 'trouble_log', location: 'pending', pinnedTo: null, premiumPriority: false }]);
});

// 2026-09-07, Grimmethy after finding the same task in worker-reasoning's list but not
// worker-reasoning-p40's: "why do the 2 reasoning workers have different lists? they
// really should share the same task list." A pin used to EXCLUDE a still-pending task
// from every sibling lane's browsing list -- right for pickClaimableTasks() (the real
// claim loop, where excluding it stops a race to steal it), wrong for this dashboard-
// facing list, which should show every tier-matching candidate regardless of which lane
// currently has first claim, tagged so the operator can see (and, if they choose,
// override) the existing pin.
test('listAssignableTasks includes a pending task pinned to a SIBLING lane, tagged with pinnedTo instead of hidden', () => {
  const queueDir = setupQueue();
  writeTask(path.join(queueDir, 'pending'), 'pinned-elsewhere', { source: 'adhoc', title: 'Pinned task', pinnedWorker: 'worker-reasoning' });

  const items = listAssignableTasks(queueDir, 'worker-reasoning-p40', { isReasoningLane: true });

  assert.deepEqual(items, [{ id: 'pinned-elsewhere', title: 'Pinned task', source: 'adhoc', location: 'pending', pinnedTo: 'worker-reasoning', premiumPriority: false }]);
});

test('listAssignableTasks does not tag pinnedTo when the task is pinned to the QUERIED instance itself', () => {
  const queueDir = setupQueue();
  writeTask(path.join(queueDir, 'pending'), 'pinned-here', { source: 'adhoc', title: 'Pinned to me', pinnedWorker: 'worker-reasoning' });

  const items = listAssignableTasks(queueDir, 'worker-reasoning', { isReasoningLane: true });

  assert.deepEqual(items, [{ id: 'pinned-here', title: 'Pinned to me', source: 'adhoc', location: 'pending', pinnedTo: null, premiumPriority: false }]);
});

test('listAssignableTasks includes tier-matching tasks sitting in OTHER lanes\' drafting/, tagged with their location', () => {
  const queueDir = setupQueue();
  writeDraftingTask(queueDir, 'worker-reasoning-p40', 'stuck-elsewhere', { source: 'adhoc', title: 'Stuck task' });

  const items = listAssignableTasks(queueDir, 'worker-reasoning', { isReasoningLane: true });

  assert.deepEqual(items, [{ id: 'stuck-elsewhere', title: 'Stuck task', source: 'adhoc', location: 'drafting:worker-reasoning-p40', premiumPriority: false }]);
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

// queue/adhoc/ (2026-09-08, Grimmethy: "I also can't see the target when I try to select
// it in the workers task select field" -- root-caused live: this function never scanned
// adhoc/ at all, only pending/ and other lanes' drafting/, even though adhoc/ is the
// single highest-volume holding pen in the whole pipeline and nextAdhocTask() reads a
// candidate from it on demand rather than ever writing a file into pending/ first).
function writeAdhocTask(queueDir, id, extra = {}) {
  const adhocDir = path.join(queueDir, 'adhoc');
  fs.mkdirSync(adhocDir, { recursive: true });
  const task = { id, source: 'manual', promptContext: {}, ...extra };
  fs.writeFileSync(path.join(adhocDir, `${id}.json`), JSON.stringify(task, null, 2));
  return task;
}

test('listAssignableTasks includes queue/adhoc/ candidates, tagged with location:adhoc', () => {
  const queueDir = setupQueue();
  writeAdhocTask(queueDir, 'adhoc-decompose-child', { title: 'A stacked file-decompose move child', atomic: true });

  const items = listAssignableTasks(queueDir, 'worker-reasoning', { isReasoningLane: true });

  assert.deepEqual(items, [{ id: 'adhoc-decompose-child', title: 'A stacked file-decompose move child', source: 'manual', location: 'adhoc', pinnedTo: null, premiumPriority: false }]);
});

test('listAssignableTasks tier-filters adhoc/ candidates the same as pending/drafting ones', () => {
  const queueDir = setupQueue();
  writeAdhocTask(queueDir, 'adhoc-high-tier', {});

  assert.deepEqual(listAssignableTasks(queueDir, 'worker-1', { isReasoningLane: false }), []);
  assert.deepEqual(
    listAssignableTasks(queueDir, 'worker-reasoning', { isReasoningLane: true }).map((i) => i.id),
    ['adhoc-high-tier'],
  );
});

test('listAssignableTasks tags an adhoc/ task pinned to a SIBLING lane with pinnedTo, same as pending', () => {
  const queueDir = setupQueue();
  writeAdhocTask(queueDir, 'adhoc-pinned-elsewhere', { pinnedWorker: 'worker-reasoning' });

  const items = listAssignableTasks(queueDir, 'worker-reasoning-p40', { isReasoningLane: true });

  assert.deepEqual(items, [{ id: 'adhoc-pinned-elsewhere', title: null, source: 'manual', location: 'adhoc', pinnedTo: 'worker-reasoning', premiumPriority: false }]);
});

test('listAssignableTasks sorts premiumPriority adhoc/ candidates ahead of ordinary ones', () => {
  const queueDir = setupQueue();
  writeAdhocTask(queueDir, 'adhoc-ordinary', {});
  writeAdhocTask(queueDir, 'adhoc-premium', { premiumPriority: true });

  const items = listAssignableTasks(queueDir, 'worker-reasoning', { isReasoningLane: true });

  assert.deepEqual(items.map((i) => i.id), ['adhoc-premium', 'adhoc-ordinary']);
});

test('listAssignableTasks: an empty/missing queue dir returns an empty list, not a throw', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'next-claimable-task-test-'));
  assert.deepEqual(listAssignableTasks(path.join(root, 'queue'), 'worker-1', { isReasoningLane: false }), []);
});
