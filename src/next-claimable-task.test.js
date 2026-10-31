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
const { spawnSync: spawnSyncTop } = require('child_process');

const { pickClaimableTasks, pickNextPendingTask, listAssignableTasks, effectivePriority, BOT_ADHOC_PRIORITY_PENALTY } = require('./next-claimable-task.js');
const { resolveSourceName } = require('./task-source-registry.js');

// The claim path reads its task files through the RAM cache (queue-cache.js). Keep this file's cache files out of the real /dev/shm location.
const CACHE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'next-claimable-task-cache-'));
process.env.AGENT_MANAGER_QUEUE_CACHE_DIR = CACHE_ROOT;
process.on('exit', () => { try { fs.rmSync(CACHE_ROOT, { recursive: true, force: true }); } catch (_) { /* best-effort */ } });

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
  writeTask(pendingDir, 'bot-adhoc', { source: 'adhoc' });            // base priority 10 + the bot-adhoc penalty (30) = 40
  writeTask(pendingDir, 'low-tier-b', { source: 'trouble_log' });     // priority 20, written after low-tier-a

  const items = pickClaimableTasks(pendingDir, 'worker-1');

  assert.deepEqual(items, ['low-tier-a.json', 'low-tier-b.json', 'bot-adhoc.json']);
});

test('every lane sees every task, in the same priority order (no lane/tier split)', () => {
  const pendingDir = setupPending();
  writeTask(pendingDir, 'adhoc-task', { source: 'adhoc', humanQueued: true }); // priority 10
  writeTask(pendingDir, 'ordinary-task', { source: 'trouble_log' });           // priority 20

  const a = pickClaimableTasks(pendingDir, 'worker-3090');
  const b = pickClaimableTasks(pendingDir, 'worker-p40');
  assert.deepEqual(a, ['adhoc-task.json', 'ordinary-task.json']);
  assert.deepEqual(b, a);
});

// Lane task-class allowlist (lanes.js taskClasses, 2026-10-17): a small GPU lane is only offered the sources it is configured for.
const RESTRICTED_LANES = [
  { id: 'worker-3090', gpu: '3090', env: {}, local: true, preempt: 'always', taskClasses: null },
  { id: 'worker-rx580', gpu: 'rx580', env: { OLLAMA_URL: 'http://g:11434' }, local: false, preempt: 'never', taskClasses: ['trouble_log'] },
];

test('a lane with a taskClasses allowlist is only offered tasks of those sources; an unrestricted lane still sees everything', () => {
  const pendingDir = setupPending();
  writeTask(pendingDir, 'adhoc-task', { source: 'adhoc', humanQueued: true }); // priority 10, NOT in the rx580 allowlist
  writeTask(pendingDir, 'small-task', { source: 'trouble_log' });              // priority 20, in the allowlist

  assert.deepEqual(pickClaimableTasks(pendingDir, 'worker-rx580', { lanes: RESTRICTED_LANES }), ['small-task.json']);
  assert.deepEqual(pickClaimableTasks(pendingDir, 'worker-3090', { lanes: RESTRICTED_LANES }), ['adhoc-task.json', 'small-task.json']);
});

test('a restricted lane with nothing allowlisted pending claims nothing (it never falls back to the rest of the queue)', () => {
  const pendingDir = setupPending();
  writeTask(pendingDir, 'adhoc-task', { source: 'adhoc', humanQueued: true });
  assert.deepEqual(pickClaimableTasks(pendingDir, 'worker-rx580', { lanes: RESTRICTED_LANES }), []);
});

test('an operator pin to a restricted lane bypasses its allowlist (explicit human choice still wins)', () => {
  const pendingDir = setupPending();
  writeTask(pendingDir, 'pinned-adhoc', { source: 'adhoc', humanQueued: true, pinnedWorker: 'worker-rx580' });
  writeTask(pendingDir, 'small-task', { source: 'trouble_log' });
  assert.deepEqual(pickClaimableTasks(pendingDir, 'worker-rx580', { lanes: RESTRICTED_LANES }), ['pinned-adhoc.json', 'small-task.json']);
  assert.deepEqual(pickClaimableTasks(pendingDir, 'worker-3090', { lanes: RESTRICTED_LANES }), ['small-task.json'], 'pinned elsewhere: not a candidate here');
});

test('an instance that is not a lane (reviewer, watchdog) is never restricted by lane allowlists', () => {
  const pendingDir = setupPending();
  writeTask(pendingDir, 'adhoc-task', { source: 'adhoc', humanQueued: true });
  writeTask(pendingDir, 'small-task', { source: 'trouble_log' });
  assert.deepEqual(pickClaimableTasks(pendingDir, 'reviewer', { lanes: LANES }), ['adhoc-task.json', 'small-task.json']);
});

// Hub priority (2026-09-09): within one source-priority band, a live hub's children are
// ordered by their owning hub's key (explicit hubPriority asc, then hub createdAt asc),
// so this path can't disagree with nextAdhocTask() about which hub is worked next.
test('within a source-priority band, the higher-priority hub\'s child sorts first (then hub createdAt)', () => {
  const pendingDir = setupPending();
  const coordDir = path.join(pendingDir, '..', 'coordinating');
  fs.mkdirSync(coordDir, { recursive: true });
  fs.writeFileSync(path.join(coordDir, 'hub-low.json'),
    JSON.stringify({ id: 'hub-low', status: 'coordinating', hubPriority: 1, createdAt: '2026-09-09T00:00:00Z' }));
  fs.writeFileSync(path.join(coordDir, 'hub-high.json'),
    JSON.stringify({ id: 'hub-high', status: 'coordinating', hubPriority: 50, createdAt: '2026-09-01T00:00:00Z' }));
  fs.writeFileSync(path.join(coordDir, 'hub-unranked-older.json'),
    JSON.stringify({ id: 'hub-unranked-older', status: 'coordinating', createdAt: '2026-08-01T00:00:00Z' }));

  // All 'adhoc' (priority 10, reasoningTier high). Written oldest-first by mtime; the
  // hub-key ordering must override that.
  writeTask(pendingDir, 'child-of-hub-high', { source: 'adhoc', parentHub: 'hub-high' });
  writeTask(pendingDir, 'child-of-unranked', { source: 'adhoc', parentHub: 'hub-unranked-older' });
  writeTask(pendingDir, 'child-of-hub-low', { source: 'adhoc', parentHub: 'hub-low' });

  const items = pickClaimableTasks(pendingDir, 'worker-reasoning');
  assert.deepEqual(items, ['child-of-hub-low.json', 'child-of-hub-high.json', 'child-of-unranked.json']);
});

test('a hub child sorts ahead of an unrelated task at the same source priority; a non-hub task keeps its place otherwise', () => {
  const pendingDir = setupPending();
  const coordDir = path.join(pendingDir, '..', 'coordinating');
  fs.mkdirSync(coordDir, { recursive: true });
  fs.writeFileSync(path.join(coordDir, 'hub-x.json'),
    JSON.stringify({ id: 'hub-x', status: 'coordinating', createdAt: '2026-09-01T00:00:00Z' }));

  writeTask(pendingDir, 'plain-adhoc', { source: 'adhoc' });               // no hub
  writeTask(pendingDir, 'hub-child', { source: 'adhoc', parentHub: 'hub-x' });

  const items = pickClaimableTasks(pendingDir, 'worker-reasoning');
  assert.deepEqual(items, ['hub-child.json', 'plain-adhoc.json']);
});

// S1 of the hub-tasks extraction (2026-09-23): this path resolves the SAME hubOrder hook
// from the task's registered source that nextAdhocTask() does (task-sources.js), rather
// than calling hub-priority.js directly -- proves the two claim paths can't drift apart
// even when a registration overrides the default, which is the "the two must never
// disagree" invariant this file's own header already documents for the tier split.
test('a hubOrder override on the adhoc registration is honored here too, not just by nextAdhocTask', () => {
  const pendingDir = setupPending();
  const coordDir = path.join(pendingDir, '..', 'coordinating');
  fs.mkdirSync(coordDir, { recursive: true });
  fs.writeFileSync(path.join(coordDir, 'hub-x.json'),
    JSON.stringify({ id: 'hub-x', status: 'coordinating', createdAt: '2026-09-01T00:00:00Z' }));

  writeTask(pendingDir, 'plain-adhoc', { source: 'adhoc' });
  writeTask(pendingDir, 'hub-child', { source: 'adhoc', parentHub: 'hub-x' });

  const { updateTaskSource, getRegisteredSource } = require('./task-source-registry.js');
  const original = getRegisteredSource('adhoc').hubOrder;
  updateTaskSource('adhoc', {
    hubOrder: { orderCandidate: () => ({ isHubWork: false, hubKey: { isHubChild: false } }), compareKeys: () => 0, siblingHolds: () => false },
  });
  try {
    const items = pickClaimableTasks(pendingDir, 'worker-reasoning');
    assert.deepEqual(items, ['plain-adhoc.json', 'hub-child.json'], 'with hub prioritization disabled by the override, plain mtime FIFO must decide instead');
  } finally {
    updateTaskSource('adhoc', { hubOrder: original }); // restore -- this registry is shared across every test in this file
  }
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

  const items = pickClaimableTasks(pendingDir, 'worker-reasoning');

  assert.deepEqual(items, ['human-adhoc.json', 'bot-adhoc.json', 'derived.json']);
});

test('pickClaimableTasks: a human-queued adhoc task is claimed before a bot-originated one of the same source, oldest-bot-first tie-break still applies within each tier', () => {
  const pendingDir = setupPending();
  writeTask(pendingDir, 'bot-adhoc-a', { source: 'adhoc' });                          // no humanQueued -> demoted
  writeTask(pendingDir, 'human-adhoc', { source: 'adhoc', humanQueued: true });       // stays at base priority 10
  writeTask(pendingDir, 'bot-adhoc-b', { source: 'adhoc' });

  const items = pickClaimableTasks(pendingDir, 'worker-reasoning');

  assert.deepEqual(items, ['human-adhoc.json', 'bot-adhoc-a.json', 'bot-adhoc-b.json']);
});

test('pickClaimableTasks: premiumPriority puts a task ahead of everything, including a human-queued adhoc task and an unrelated higher-priority source', () => {
  const pendingDir = setupPending();
  writeTask(pendingDir, 'human-adhoc', { source: 'adhoc', humanQueued: true });
  writeTask(pendingDir, 'bot-adhoc', { source: 'adhoc' });
  writeTask(pendingDir, 'premium-low-tier', { source: 'trouble_log', premiumPriority: true }); // priority 20 normally, but pinned to the front

  const items = pickClaimableTasks(pendingDir, 'worker-1');

  // premium first, then human adhoc (10), then bot adhoc (10 + penalty).
  assert.deepEqual(items, ['premium-low-tier.json', 'human-adhoc.json', 'bot-adhoc.json']);
});

test('pickClaimableTasks: premiumPriority sorts ahead of an ordinary same-tier task even when the ordinary task is older', () => {
  const pendingDir = setupPending();
  writeTask(pendingDir, 'ordinary-older', { source: 'trouble_log' });
  writeTask(pendingDir, 'premium-newer', { source: 'trouble_log', premiumPriority: true });

  const items = pickClaimableTasks(pendingDir, 'worker-1');

  assert.deepEqual(items, ['premium-newer.json', 'ordinary-older.json']);
});

test('pickClaimableTasks: premiumPriority persists through the ranking even though it is not pinnedWorker -- any lane can claim it', () => {
  const pendingDir = setupPending();
  writeTask(pendingDir, 'premium-unpinned', { source: 'trouble_log', premiumPriority: true });

  const forWorker1 = pickClaimableTasks(pendingDir, 'worker-1');
  assert.deepEqual(forWorker1, ['premium-unpinned.json']);
});

test('listAssignableTasks: surfaces premiumPriority on both pending and drafting-elsewhere items', () => {
  const queueDir = setupQueue();
  writeTask(path.join(queueDir, 'pending'), 'premium-pending', { source: 'trouble_log', premiumPriority: true });
  writeDraftingTask(queueDir, 'worker-2', 'premium-drafting', { premiumPriority: true });
  writeDraftingTask(queueDir, 'worker-2', 'ordinary-drafting', {});

  const items = listAssignableTasks(queueDir, 'worker-1');
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));

  assert.equal(byId['premium-pending'].premiumPriority, true);
  assert.equal(byId['premium-drafting'].premiumPriority, true);
  assert.equal(byId['ordinary-drafting'].premiumPriority, false);
});

test('a task pinned to this instance wins immediately, skipping the priority sort', () => {
  const pendingDir = setupPending();
  writeTask(pendingDir, 'high-priority', { source: 'adhoc', humanQueued: true });  // priority 10, would normally outrank the pinned task
  writeTask(pendingDir, 'pinned-low-priority', { source: 'trouble_log', pinnedWorker: 'worker-1' }); // priority 20, but pinned to worker-1

  const items = pickClaimableTasks(pendingDir, 'worker-1');

  assert.deepEqual(items, ['pinned-low-priority.json', 'high-priority.json']);
});

test('a task pinned to a DIFFERENT instance is excluded from this instance\'s candidates', () => {
  const pendingDir = setupPending();
  writeTask(pendingDir, 'pinned-elsewhere', { source: 'trouble_log', pinnedWorker: 'worker-reasoning' });
  writeTask(pendingDir, 'unpinned', { source: 'trouble_log' });

  const items = pickClaimableTasks(pendingDir, 'worker-1');

  assert.deepEqual(items, ['unpinned.json']);

  // ...but the instance it WAS pinned to still sees it, ahead of everything else.
  const itemsForPinnedLane = pickClaimableTasks(pendingDir, 'worker-reasoning');
  assert.deepEqual(itemsForPinnedLane, ['pinned-elsewhere.json', 'unpinned.json']);
});

test('multiple tasks pinned to the same instance are ordered oldest-first', () => {
  const pendingDir = setupPending();
  writeTask(pendingDir, 'pinned-first', { source: 'trouble_log', pinnedWorker: 'worker-1' });
  writeTask(pendingDir, 'pinned-second', { source: 'trouble_log', pinnedWorker: 'worker-1' });

  const items = pickClaimableTasks(pendingDir, 'worker-1');

  assert.deepEqual(items, ['pinned-first.json', 'pinned-second.json']);
});

test('an unresolvable/unregistered source is not dropped -- sorts last with worst-case priority', () => {
  const pendingDir = setupPending();
  writeTask(pendingDir, 'known-source', { source: 'trouble_log' });
  writeTask(pendingDir, 'unknown-source', { source: 'this-source-does-not-exist' });

  const items = pickClaimableTasks(pendingDir, 'worker-1');

  assert.deepEqual(items, ['known-source.json', 'unknown-source.json']);
});

test('a corrupt/unparseable task file is not dropped -- still listed, worst-case priority', () => {
  const pendingDir = setupPending();
  writeTask(pendingDir, 'known-source', { source: 'trouble_log' });
  fs.writeFileSync(path.join(pendingDir, 'corrupt.json'), '{not valid json');

  const items = pickClaimableTasks(pendingDir, 'worker-1');

  assert.deepEqual(items, ['known-source.json', 'corrupt.json']);
});

test('an empty/missing pending directory returns an empty list, not a throw', () => {
  const pendingDir = setupPending();
  assert.deepEqual(pickClaimableTasks(pendingDir, 'worker-1'), []);
  assert.deepEqual(pickClaimableTasks(path.join(pendingDir, 'does-not-exist'), 'worker-1', {}), []);
});

test('pickNextPendingTask returns only the single winner, or null when nothing is claimable', () => {
  const pendingDir = setupPending();
  assert.equal(pickNextPendingTask(pendingDir, 'worker-1'), null);

  writeTask(pendingDir, 'only-one', { source: 'trouble_log' });
  assert.equal(pickNextPendingTask(pendingDir, 'worker-1'), 'only-one.json');
});

// listAssignableTasks -- the Workers tab assign-task dropdown's real candidate source
// (2026-09-07, Grimmethy: "the only tasks I have access to... are pipeline debrief
// tasks. The task I want, autodecomp, is in drafting. I need access to the full list of
// available jobs, they should however be whats available for that specific worker type").

test('listAssignableTasks includes every pending/ candidate (no tier filter)', () => {
  const queueDir = setupQueue();
  writeTask(path.join(queueDir, 'pending'), 'ordinary', { source: 'trouble_log', title: 'Ordinary task' });
  writeTask(path.join(queueDir, 'pending'), 'reasoning-only', { source: 'adhoc', title: 'Reasoning task' });

  const items = listAssignableTasks(queueDir, 'worker-1');

  assert.deepEqual(items.map((i) => i.id).sort(), ['ordinary', 'reasoning-only']);
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

  const items = listAssignableTasks(queueDir, 'worker-reasoning-p40');

  assert.deepEqual(items, [{ id: 'pinned-elsewhere', title: 'Pinned task', source: 'adhoc', location: 'pending', pinnedTo: 'worker-reasoning', premiumPriority: false }]);
});

test('listAssignableTasks does not tag pinnedTo when the task is pinned to the QUERIED instance itself', () => {
  const queueDir = setupQueue();
  writeTask(path.join(queueDir, 'pending'), 'pinned-here', { source: 'adhoc', title: 'Pinned to me', pinnedWorker: 'worker-reasoning' });

  const items = listAssignableTasks(queueDir, 'worker-reasoning');

  assert.deepEqual(items, [{ id: 'pinned-here', title: 'Pinned to me', source: 'adhoc', location: 'pending', pinnedTo: null, premiumPriority: false }]);
});

test('listAssignableTasks includes tier-matching tasks sitting in OTHER lanes\' drafting/, tagged with their location', () => {
  const queueDir = setupQueue();
  writeDraftingTask(queueDir, 'worker-reasoning-p40', 'stuck-elsewhere', { source: 'adhoc', title: 'Stuck task' });

  const items = listAssignableTasks(queueDir, 'worker-reasoning');

  assert.deepEqual(items, [{ id: 'stuck-elsewhere', title: 'Stuck task', source: 'adhoc', location: 'drafting:worker-reasoning-p40', premiumPriority: false }]);
});

test('listAssignableTasks excludes this instance\'s OWN drafting/ contents -- reassigning to itself is a no-op', () => {
  const queueDir = setupQueue();
  writeDraftingTask(queueDir, 'worker-1', 'already-mine', { source: 'trouble_log' });
  writeDraftingTask(queueDir, 'worker-p40', 'someone-elses', { source: 'trouble_log' });

  const items = listAssignableTasks(queueDir, 'worker-1');

  assert.deepEqual(items.map((i) => i.id), ['someone-elses']);
});

test('listAssignableTasks shows another lane\'s drafting task to every OTHER lane, never to its own', () => {
  const queueDir = setupQueue();
  writeDraftingTask(queueDir, 'worker-p40', 'elsewhere', { source: 'adhoc' });

  assert.deepEqual(listAssignableTasks(queueDir, 'worker-3090').map((i) => i.id), ['elsewhere']);
  assert.deepEqual(listAssignableTasks(queueDir, 'worker-p40'), []);
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

  const items = listAssignableTasks(queueDir, 'worker-reasoning');

  assert.deepEqual(items, [{ id: 'adhoc-decompose-child', title: 'A stacked file-decompose move child', source: 'manual', location: 'adhoc', pinnedTo: null, premiumPriority: false }]);
});

test('listAssignableTasks lists queue/adhoc/ candidates for every lane', () => {
  const queueDir = setupQueue();
  writeAdhocTask(queueDir, 'adhoc-task', {});

  assert.deepEqual(listAssignableTasks(queueDir, 'worker-3090').map((i) => i.id), ['adhoc-task']);
  assert.deepEqual(listAssignableTasks(queueDir, 'worker-p40').map((i) => i.id), ['adhoc-task']);
});

test('listAssignableTasks tags an adhoc/ task pinned to a SIBLING lane with pinnedTo, same as pending', () => {
  const queueDir = setupQueue();
  writeAdhocTask(queueDir, 'adhoc-pinned-elsewhere', { pinnedWorker: 'worker-reasoning' });

  const items = listAssignableTasks(queueDir, 'worker-reasoning-p40');

  assert.deepEqual(items, [{ id: 'adhoc-pinned-elsewhere', title: null, source: 'manual', location: 'adhoc', pinnedTo: 'worker-reasoning', premiumPriority: false }]);
});

test('listAssignableTasks sorts premiumPriority adhoc/ candidates ahead of ordinary ones', () => {
  const queueDir = setupQueue();
  writeAdhocTask(queueDir, 'adhoc-ordinary', {});
  writeAdhocTask(queueDir, 'adhoc-premium', { premiumPriority: true });

  const items = listAssignableTasks(queueDir, 'worker-reasoning');

  assert.deepEqual(items.map((i) => i.id), ['adhoc-premium', 'adhoc-ordinary']);
});

test('listAssignableTasks: an empty/missing queue dir returns an empty list, not a throw', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'next-claimable-task-test-'));
  assert.deepEqual(listAssignableTasks(path.join(root, 'queue'), 'worker-1'), []);
});

// Regression (2026-09-19, PF-Client-Portal): the real claim path is this file run as a CLI
// (local-worker.sh). It only loaded core sources, so every plugin-registered source (the
// hygiene family) had no registry entry -> priority Infinity -> ranked AFTER brain_dump_sort
// (70). Run the CLI in a subprocess with a throwaway plugin manifest registering a
// priority-5 source, and assert it ranks first.
test('CLI claim order loads plugin-registered sources (plugin priority beats brain_dump_sort)', () => {
  const { spawnSync } = require('child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-plugin-test-'));
  const pendingDir = path.join(root, 'queue', 'pending');
  fs.mkdirSync(pendingDir, { recursive: true });
  const write = (name, source) => fs.writeFileSync(path.join(pendingDir, name), JSON.stringify({ id: name, source, domain: 'default', title: name }));
  write('a-sort.json', 'brain_dump_sort');
  write('z-plugin.json', 'fake_plugin_source');

  const registry = path.join(__dirname, 'task-source-registry.js');
  const registerJs = path.join(root, 'register.js');
  fs.writeFileSync(registerJs, `require(${JSON.stringify(registry)}).registerTaskSource('fake_plugin_source', { priority: 5, next: () => null });\n`);
  const manifest = path.join(root, 'plugins.json');
  fs.writeFileSync(manifest, JSON.stringify([{ name: 'fake', registerPath: registerJs, enabled: true }]));

  const res = spawnSync('node', [path.join(__dirname, 'next-claimable-task.js'), pendingDir, 'worker-1', 'false'], {
    env: { ...process.env, AGENT_MANAGER_PLUGINS_MANIFEST: manifest, AGENT_MANAGER_REPO_ROOT: root, AGENT_MANAGER_PIPELINE_DIR: root },
    encoding: 'utf8',
    timeout: 20000,
  });
  const order = res.stdout.split('\n').filter(Boolean);
  assert.deepEqual(order, ['z-plugin.json', 'a-sort.json'], res.stderr);
});

// --- lane preference (2026-09-20): a lone task goes to the host GPU lane, not the P40 -----------------------------------
const { preferredLaneIsIdle, lanePreferenceGraceMs } = require('./next-claimable-task.js');
const LANES = [{ id: 'worker-3090' }, { id: 'worker-p40' }];

function writeHeartbeat(pendingDir, lane, status, ageMs = 0, now = Date.now()) {
  const dir = path.join(pendingDir, '..', '..', 'instances');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${lane}.json`), JSON.stringify({ instanceId: lane, status, lastHeartbeat: new Date(now - ageMs).toISOString() }));
}

// A task that just arrived (mtime = now), so it is inside the grace window.
function writeFreshTask(pendingDir, id, extra = {}) {
  const p = path.join(pendingDir, `${id}.json`);
  fs.writeFileSync(p, JSON.stringify({ id, source: 'trouble_log', promptContext: {}, ...extra }));
  return p;
}

test('lane preference: the P40 leaves a lone fresh task for an idle 3090; the 3090 itself still takes it', () => {
  const pendingDir = setupPending();
  writeFreshTask(pendingDir, 'only-one');
  writeHeartbeat(pendingDir, 'worker-3090', 'idle');
  assert.deepEqual(pickClaimableTasks(pendingDir, 'worker-p40', { lanes: LANES }), []);
  assert.deepEqual(pickClaimableTasks(pendingDir, 'worker-3090', { lanes: LANES }), ['only-one.json']);
});

test('lane preference: with two tasks the P40 still gets the second one immediately (only the top task is held)', () => {
  const pendingDir = setupPending();
  writeFreshTask(pendingDir, 'a', { source: 'trouble_log' });
  writeFreshTask(pendingDir, 'b', { source: 'unused_export' });
  writeHeartbeat(pendingDir, 'worker-3090', 'idle');
  const p40 = pickClaimableTasks(pendingDir, 'worker-p40', { lanes: LANES });
  const g3090 = pickClaimableTasks(pendingDir, 'worker-3090', { lanes: LANES });
  assert.equal(p40.length, 1);
  assert.notEqual(p40[0], g3090[0], 'the P40 must not take the task the 3090 will take');
});

test('lane preference: the hold is time-boxed -- a task older than the grace period goes to the P40 even if the 3090 looks idle', () => {
  const pendingDir = setupPending();
  const p = writeFreshTask(pendingDir, 'stranded');
  const old = new Date(Date.now() - 3 * 60 * 1000);
  fs.utimesSync(p, old, old);
  writeHeartbeat(pendingDir, 'worker-3090', 'idle');
  assert.deepEqual(pickClaimableTasks(pendingDir, 'worker-p40', { lanes: LANES }), ['stranded.json']);
});

test('lane preference: nothing is held when the 3090 is busy, its heartbeat is stale or missing, or the feature is off', () => {
  const pendingDir = setupPending();
  writeFreshTask(pendingDir, 'only-one');
  writeHeartbeat(pendingDir, 'worker-3090', 'working');
  assert.deepEqual(pickClaimableTasks(pendingDir, 'worker-p40', { lanes: LANES }), ['only-one.json'], 'busy');
  writeHeartbeat(pendingDir, 'worker-3090', 'idle', 5 * 60 * 1000);
  assert.deepEqual(pickClaimableTasks(pendingDir, 'worker-p40', { lanes: LANES }), ['only-one.json'], 'stale heartbeat (worker down)');
  fs.rmSync(path.join(pendingDir, '..', '..', 'instances'), { recursive: true });
  assert.deepEqual(pickClaimableTasks(pendingDir, 'worker-p40', { lanes: LANES }), ['only-one.json'], 'no heartbeat');
  writeHeartbeat(pendingDir, 'worker-3090', 'idle');
  assert.deepEqual(pickClaimableTasks(pendingDir, 'worker-p40', { lanes: LANES, graceMs: 0 }), ['only-one.json'], 'switched off');
});

test('lane preference: a task pinned to the P40 is never held, and a single-lane setup is unaffected', () => {
  const pendingDir = setupPending();
  writeFreshTask(pendingDir, 'pinned', { pinnedWorker: 'worker-p40' });
  writeHeartbeat(pendingDir, 'worker-3090', 'idle');
  assert.deepEqual(pickClaimableTasks(pendingDir, 'worker-p40', { lanes: LANES }), ['pinned.json']);
  const other = setupPending();
  writeFreshTask(other, 'x');
  writeHeartbeat(other, 'worker-3090', 'idle');
  assert.deepEqual(pickClaimableTasks(other, 'worker-3090', { lanes: [{ id: 'worker-3090' }] }), ['x.json']);
});

test('preferredLaneIsIdle / lanePreferenceGraceMs: the primitives', () => {
  const pendingDir = setupPending();
  const instancesDir = path.join(pendingDir, '..', '..', 'instances');
  writeHeartbeat(pendingDir, 'worker-3090', 'idle');
  assert.equal(preferredLaneIsIdle({ instanceId: 'worker-p40', instancesDir, lanes: LANES }), true);
  assert.equal(preferredLaneIsIdle({ instanceId: 'worker-3090', instancesDir, lanes: LANES }), false, 'the preferred lane never defers to itself');
  assert.equal(preferredLaneIsIdle({ instanceId: 'worker-1', instancesDir, lanes: LANES }), false, 'not a known lane');
  assert.equal(lanePreferenceGraceMs({}), 120000);
  assert.equal(lanePreferenceGraceMs({ AGENT_MANAGER_LANE_PREFERENCE_GRACE_SECS: '0' }), 0);
  assert.equal(lanePreferenceGraceMs({ AGENT_MANAGER_LANE_PREFERENCE_GRACE_SECS: '30' }), 30000);
});

// --- hub claim tier (2026-09-30, Grimmethy: hub sub-tasks below premiumPriority but ahead of ordinary work) ---

const { HUB_TIER_PRIORITY } = require('./hub-priority.js');
const { rankPriorityOfTask } = require('./next-claimable-task.js');

function writeHubRecord(pendingDir, hub) {
  const coordDir = path.join(pendingDir, '..', 'coordinating');
  fs.mkdirSync(coordDir, { recursive: true });
  fs.writeFileSync(path.join(coordDir, `${hub.id}.json`), JSON.stringify({ status: 'coordinating', ...hub }));
}

test('hub tier: a live-hub child is claimed ahead of a better-priority ordinary task (trouble_log 20 vs bot adhoc 40)', () => {
  const pendingDir = setupPending();
  writeHubRecord(pendingDir, { id: 'hub-x', createdAt: '2026-09-01T00:00:00Z' });
  writeTask(pendingDir, 'hygiene', { source: 'trouble_log' });
  writeTask(pendingDir, 'hub-child', { source: 'adhoc', parentHub: 'hub-x' });

  assert.deepEqual(pickClaimableTasks(pendingDir, 'worker-1', { graceMs: 0 }), ['hub-child.json', 'hygiene.json']);
});

test('hub tier: premiumPriority still outranks a hub child, and a non-hub bot adhoc keeps its old rank behind hygiene', () => {
  const pendingDir = setupPending();
  writeHubRecord(pendingDir, { id: 'hub-x', createdAt: '2026-09-01T00:00:00Z' });
  writeTask(pendingDir, 'plain-bot-adhoc', { source: 'adhoc' });
  writeTask(pendingDir, 'hub-child', { source: 'adhoc', parentHub: 'hub-x' });
  writeTask(pendingDir, 'premium', { source: 'trouble_log', premiumPriority: true });
  writeTask(pendingDir, 'hygiene', { source: 'trouble_log' });

  assert.deepEqual(pickClaimableTasks(pendingDir, 'worker-1', { graceMs: 0 }),
    ['premium.json', 'hub-child.json', 'hygiene.json', 'plain-bot-adhoc.json']);
});

test('hub tier: within the tier, hubPriority ascending then hub createdAt then mtime decide', () => {
  const pendingDir = setupPending();
  writeHubRecord(pendingDir, { id: 'hub-late', hubPriority: 5, createdAt: '2026-09-09T00:00:00Z' });
  writeHubRecord(pendingDir, { id: 'hub-early-unranked', createdAt: '2026-08-01T00:00:00Z' });
  writeHubRecord(pendingDir, { id: 'hub-first', hubPriority: 1, createdAt: '2026-09-20T00:00:00Z' });
  writeTask(pendingDir, 'c-unranked', { source: 'adhoc', parentHub: 'hub-early-unranked' });
  writeTask(pendingDir, 'c-late', { source: 'adhoc', parentHub: 'hub-late' });
  writeTask(pendingDir, 'c-first-b', { source: 'adhoc', parentHub: 'hub-first' });
  writeTask(pendingDir, 'c-first-a', { source: 'adhoc', parentHub: 'hub-first' }); // written after c-first-b -> FIFO within the hub
  writeTask(pendingDir, 'hygiene', { source: 'trouble_log' });

  assert.deepEqual(pickClaimableTasks(pendingDir, 'worker-1', { graceMs: 0 }),
    ['c-first-b.json', 'c-first-a.json', 'c-late.json', 'c-unranked.json', 'hygiene.json']);
});

test('hub tier: a derived_task hub child gets the tier (before the derived 48 early return); a non-hub derived task stays 48', () => {
  const pendingDir = setupPending();
  writeHubRecord(pendingDir, { id: 'hub-x', createdAt: '2026-09-01T00:00:00Z' });
  writeTask(pendingDir, 'hygiene', { source: 'trouble_log' });
  writeTask(pendingDir, 'derived-plain', { source: 'derived_task', domain: 'adhoc', promptContext: { rawText: 'x' } });
  writeTask(pendingDir, 'derived-hub-child', { source: 'derived_task', domain: 'adhoc', parentHub: 'hub-x', promptContext: { rawText: 'x' } });

  assert.deepEqual(pickClaimableTasks(pendingDir, 'worker-1', { graceMs: 0 }),
    ['derived-hub-child.json', 'hygiene.json', 'derived-plain.json']);
});

test('hub tier: an atomic decompose child is in the tier even when its hub record is missing; a child of a completed hub is not', () => {
  const pendingDir = setupPending();
  writeTask(pendingDir, 'hygiene', { source: 'trouble_log' });
  writeTask(pendingDir, 'orphaned-hub-child', { source: 'adhoc', parentHub: 'hub-gone' });
  writeTask(pendingDir, 'atomic-child', { source: 'adhoc', atomic: true });

  assert.deepEqual(pickClaimableTasks(pendingDir, 'worker-1', { graceMs: 0 }),
    ['atomic-child.json', 'hygiene.json', 'orphaned-hub-child.json']);
});

test('hub tier: rankPriorityOfTask and effectivePriority', () => {
  assert.equal(effectivePriority({ source: 'adhoc' }, 10, resolveSourceName), 10 + BOT_ADHOC_PRIORITY_PENALTY, '3-arg form is unchanged');
  assert.equal(effectivePriority({ source: 'adhoc' }, 10, resolveSourceName, true), HUB_TIER_PRIORITY);
  assert.equal(effectivePriority({ source: 'adhoc', premiumPriority: true }, 10, resolveSourceName, true), -Infinity, 'premium beats the tier');
  assert.equal(rankPriorityOfTask({ source: 'adhoc' }, { hubTier: true }), HUB_TIER_PRIORITY);
  assert.equal(rankPriorityOfTask({ source: 'derived_task', domain: 'adhoc' }, { hubTier: true }), HUB_TIER_PRIORITY);
  assert.equal(rankPriorityOfTask({ source: 'derived_task', domain: 'adhoc', premiumPriority: true }, { hubTier: true }), -Infinity);
  assert.equal(rankPriorityOfTask({ source: 'trouble_log' }, { hubTier: false }), 20);
  const pendingDir = setupPending();
  writeHubRecord(pendingDir, { id: 'hub-x', createdAt: '2026-09-01T00:00:00Z' });
  assert.equal(rankPriorityOfTask({ source: 'adhoc', parentHub: 'hub-x' }, { pipelineDir: path.join(pendingDir, '..', '..') }), HUB_TIER_PRIORITY,
    'with no explicit hubTier the tier is derived from the live coordinating/ record (the generation throttle path)');
});

test('hub tier audit: one line when the tier outranks a better-natural-priority task, none otherwise, stdout list unchanged, no repeat lines', () => {
  const pendingDir = setupPending();
  const instancesDir = path.join(pendingDir, '..', '..', 'instances');
  const auditFile = path.join(instancesDir, 'hub-tier-audit.log');
  writeHubRecord(pendingDir, { id: 'hub-x', hubPriority: 3, createdAt: '2026-09-01T00:00:00Z' });
  writeTask(pendingDir, 'hub-child', { source: 'adhoc', parentHub: 'hub-x' });

  pickClaimableTasks(pendingDir, 'worker-1', { graceMs: 0, instancesDir });
  assert.equal(fs.existsSync(auditFile), false, 'nothing was displaced -> no audit line');

  writeTask(pendingDir, 'hygiene', { source: 'trouble_log' });
  const first = pickClaimableTasks(pendingDir, 'worker-1', { graceMs: 0, instancesDir });
  pickClaimableTasks(pendingDir, 'worker-2', { graceMs: 0, instancesDir });
  assert.deepEqual(first, ['hub-child.json', 'hygiene.json'], 'the returned list is still names only');
  const lines = fs.readFileSync(auditFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 1, 'an identical re-evaluation must not append a second line');
  assert.equal(lines[0].taskId, 'hub-child');
  assert.equal(lines[0].hubId, 'hub-x');
  assert.equal(lines[0].hubRank, 3);
  assert.equal(lines[0].displacedTaskId, 'hygiene');
  assert.equal(lines[0].displacedRank, 20);
  assert.equal(lines[0].naturalRank, 10 + BOT_ADHOC_PRIORITY_PENALTY);
});

test('hub tier: a hubOrder override that reports no hub work disables the tier (the override is honored)', () => {
  const pendingDir = setupPending();
  writeHubRecord(pendingDir, { id: 'hub-x', createdAt: '2026-09-01T00:00:00Z' });
  writeTask(pendingDir, 'hygiene', { source: 'trouble_log' });
  writeTask(pendingDir, 'hub-child', { source: 'adhoc', parentHub: 'hub-x' });
  const { updateTaskSource, getRegisteredSource } = require('./task-source-registry.js');
  const original = getRegisteredSource('adhoc').hubOrder;
  updateTaskSource('adhoc', {
    hubOrder: { orderCandidate: () => ({ isHubWork: false, hubKey: { isHubChild: false } }), compareKeys: () => 0, siblingHolds: () => false },
  });
  try {
    assert.deepEqual(pickClaimableTasks(pendingDir, 'worker-1', { graceMs: 0 }), ['hygiene.json', 'hub-child.json']);
  } finally {
    updateTaskSource('adhoc', { hubOrder: original });
  }
});

test('hub tier: listAssignableTasks orders adhoc/ rows premium, then hub tier, then the rest, without adding fields to the rows', () => {
  const queueDir = setupQueue();
  const adhocDir = path.join(queueDir, 'adhoc');
  fs.mkdirSync(adhocDir, { recursive: true });
  writeHubRecord(path.join(queueDir, 'pending'), { id: 'hub-x', createdAt: '2026-09-01T00:00:00Z' });
  writeTask(adhocDir, 'a-plain', { source: 'adhoc' });
  writeTask(adhocDir, 'z-hub-child', { source: 'adhoc', parentHub: 'hub-x' });
  writeTask(adhocDir, 'm-premium', { source: 'adhoc', premiumPriority: true });

  const rows = listAssignableTasks(queueDir, 'worker-1').filter((r) => r.location === 'adhoc');
  assert.deepEqual(rows.map((r) => r.id), ['m-premium', 'z-hub-child', 'a-plain']);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['id', 'location', 'pinnedTo', 'premiumPriority', 'source', 'title']);
});


// --- Premium rotation + lane avoidance (2026-10-15, premium-rotation.js) ------------------------------------------------------------
const FRESH_BLOCKED = () => new Date(Date.now() - 10 * 60_000).toISOString();
const twiceBlocked = () => [{ outcome: 'blocked', finishedAt: FRESH_BLOCKED() }, { outcome: 'blocked', finishedAt: FRESH_BLOCKED() }];

test('premium rotation: fresh premium ranks before a twice-blocked premium, which still ranks before ordinary work', () => {
  const pendingDir = setupPending();
  writeTask(pendingDir, 'a-demoted-premium', { source: 'adhoc', humanQueued: true, premiumPriority: true, draftAttempts: twiceBlocked() });
  writeTask(pendingDir, 'b-ordinary', { source: 'adhoc', humanQueued: true });
  writeTask(pendingDir, 'c-fresh-premium', { source: 'adhoc', humanQueued: true, premiumPriority: true });
  assert.deepEqual(pickClaimableTasks(pendingDir, 'worker-3090', { lanes: [{ id: 'worker-3090' }], graceMs: 0 }),
    ['c-fresh-premium.json', 'a-demoted-premium.json', 'b-ordinary.json']);
});

test('premium rotation: the off switch restores the old order (the older premium task stays first)', () => {
  const pendingDir = setupPending();
  writeTask(pendingDir, 'a-demoted-premium', { source: 'adhoc', humanQueued: true, premiumPriority: true, draftAttempts: twiceBlocked() });
  writeTask(pendingDir, 'c-fresh-premium', { source: 'adhoc', humanQueued: true, premiumPriority: true });
  const prev = process.env.AGENT_MANAGER_PREMIUM_ROTATION;
  process.env.AGENT_MANAGER_PREMIUM_ROTATION = 'off';
  try {
    assert.deepEqual(pickClaimableTasks(pendingDir, 'worker-3090', { lanes: [{ id: 'worker-3090' }], graceMs: 0 }),
      ['a-demoted-premium.json', 'c-fresh-premium.json']);
  } finally {
    if (prev === undefined) delete process.env.AGENT_MANAGER_PREMIUM_ROTATION; else process.env.AGENT_MANAGER_PREMIUM_ROTATION = prev;
  }
});

test('premium rotation: rankPriorityOfTask is unchanged for a demoted premium task (the generation throttle keeps its meaning)', () => {
  const { rankPriorityOfTask } = require('./next-claimable-task.js');
  assert.equal(rankPriorityOfTask({ id: 'x', source: 'adhoc', premiumPriority: true, draftAttempts: twiceBlocked() }, { hubTier: false }), -Infinity);
});

test('lane avoidance: a task that degenerated on worker-p40 is skipped by worker-p40 while worker-3090 exists, claimable by worker-3090', () => {
  const pendingDir = setupPending();
  writeTask(pendingDir, 'a-avoided', { source: 'adhoc', humanQueued: true, premiumPriority: true, avoidLanes: ['worker-p40'] });
  writeTask(pendingDir, 'b-other', { source: 'adhoc', humanQueued: true });
  const lanes = [{ id: 'worker-3090' }, { id: 'worker-p40' }];
  assert.deepEqual(pickClaimableTasks(pendingDir, 'worker-p40', { lanes, graceMs: 0 }), ['b-other.json']);
  assert.deepEqual(pickClaimableTasks(pendingDir, 'worker-3090', { lanes, graceMs: 0 }), ['a-avoided.json', 'b-other.json']);
});

test('lane avoidance: still claimable when worker-p40 is the only lane, or when pinned to it, or with the off switch', () => {
  const pendingDir = setupPending();
  writeTask(pendingDir, 'a-avoided', { source: 'adhoc', humanQueued: true, avoidLanes: ['worker-p40'] });
  assert.deepEqual(pickClaimableTasks(pendingDir, 'worker-p40', { lanes: [{ id: 'worker-p40' }], graceMs: 0 }), ['a-avoided.json']);
  const pinnedDir = setupPending();
  writeTask(pinnedDir, 'a-pinned', { source: 'adhoc', humanQueued: true, avoidLanes: ['worker-p40'], pinnedWorker: 'worker-p40' });
  assert.deepEqual(pickClaimableTasks(pinnedDir, 'worker-p40', { lanes: [{ id: 'worker-3090' }, { id: 'worker-p40' }], graceMs: 0 }), ['a-pinned.json']);
  const prev = process.env.AGENT_MANAGER_LANE_AVOIDANCE;
  process.env.AGENT_MANAGER_LANE_AVOIDANCE = 'off';
  try {
    assert.deepEqual(pickClaimableTasks(pendingDir, 'worker-p40', { lanes: [{ id: 'worker-3090' }, { id: 'worker-p40' }], graceMs: 0 }), ['a-avoided.json']);
  } finally {
    if (prev === undefined) delete process.env.AGENT_MANAGER_LANE_AVOIDANCE; else process.env.AGENT_MANAGER_LANE_AVOIDANCE = prev;
  }
});

// Capability routing (src/capability-routing.js): a bigger lane leaves a task to a proven smaller lane.
const TIERED_LANES = [
  { id: 'worker-3090', gpu: '3090', env: {}, local: true, preempt: 'always', taskClasses: null, model: 'big:27b', tier: 27, reserve: 'auto' },
  { id: 'worker-rx580', gpu: 'rx580', env: { OLLAMA_URL: 'http://g:11434' }, local: false, preempt: 'never', taskClasses: null, model: 'small:8b', tier: 8, reserve: 'auto' },
];
const PROVEN = [{ source: 'trouble_log', model: 'small:8b', tier: 8, n: 12, ok: 12, okRate: 1, lower: 0.76 }];

function withRouting(mode, fn, probeFraction = '0') {
  const prev = process.env.AGENT_MANAGER_CAPABILITY_ROUTING;
  const prevProbe = process.env.AGENT_MANAGER_PROBE_FRACTION;
  process.env.AGENT_MANAGER_CAPABILITY_ROUTING = mode;
  process.env.AGENT_MANAGER_PROBE_FRACTION = probeFraction;
  try { fn(); } finally {
    if (prev === undefined) delete process.env.AGENT_MANAGER_CAPABILITY_ROUTING; else process.env.AGENT_MANAGER_CAPABILITY_ROUTING = prev;
    if (prevProbe === undefined) delete process.env.AGENT_MANAGER_PROBE_FRACTION; else process.env.AGENT_MANAGER_PROBE_FRACTION = prevProbe;
  }
}

function routingOpts(extra = {}) {
  return { lanes: TIERED_LANES, graceMs: 0, scorecard: PROVEN, laneAlive: () => true, instancesDir: fs.mkdtempSync(path.join(os.tmpdir(), 'routing-inst-')), ...extra };
}

test('capability routing (enforce): the big lane skips a source a live smaller lane has proven, the small lane still takes it', () => {
  withRouting('enforce', () => {
    const pendingDir = setupPending();
    writeTask(pendingDir, 'small-task', { source: 'trouble_log' });
    writeTask(pendingDir, 'adhoc-task', { source: 'adhoc', humanQueued: true });
    assert.deepEqual(pickClaimableTasks(pendingDir, 'worker-3090', routingOpts()), ['adhoc-task.json']);
    assert.deepEqual(pickClaimableTasks(pendingDir, 'worker-rx580', routingOpts()), ['adhoc-task.json', 'small-task.json']);
  });
});

test('capability routing: shadow mode (the default) changes nothing but writes an audit line once', () => {
  withRouting('shadow', () => {
    const pendingDir = setupPending();
    writeTask(pendingDir, 'small-task', { source: 'trouble_log' });
    const opts = routingOpts();
    assert.deepEqual(pickClaimableTasks(pendingDir, 'worker-3090', opts), ['small-task.json']);
    pickClaimableTasks(pendingDir, 'worker-3090', opts);
    const log = fs.readFileSync(path.join(pendingDir, '..', '..', 'instances', 'pipeline-history.log'), 'utf8').trim().split('\n');
    assert.equal(log.length, 1);
    const entry = JSON.parse(log[0]);
    assert.equal(entry.type, 'reservation');
    assert.equal(entry.action, 'would-hold');
    assert.equal(entry.holder, 'worker-rx580');
  });
});

test('capability routing (enforce): no hold when the small lane is dead, the grace expired, the source is unproven, or the task is human-queued/escalated', () => {
  withRouting('enforce', () => {
    const pendingDir = setupPending();
    writeTask(pendingDir, 'small-task', { source: 'trouble_log' });
    assert.deepEqual(pickClaimableTasks(pendingDir, 'worker-3090', routingOpts({ laneAlive: () => false })), ['small-task.json']);
    assert.deepEqual(pickClaimableTasks(pendingDir, 'worker-3090', routingOpts({ now: Date.now() + 10 * 60 * 1000 })), ['small-task.json']);
    assert.deepEqual(pickClaimableTasks(pendingDir, 'worker-3090', routingOpts({ scorecard: [] })), ['small-task.json']);
    const humanDir = setupPending();
    writeTask(humanDir, 'human-task', { source: 'trouble_log', humanQueued: true });
    assert.deepEqual(pickClaimableTasks(humanDir, 'worker-3090', routingOpts()), ['human-task.json']);
    const escalated = setupPending();
    writeTask(escalated, 'esc-task', { source: 'trouble_log', avoidLanes: ['worker-rx580'] });
    assert.deepEqual(pickClaimableTasks(escalated, 'worker-3090', routingOpts()), ['esc-task.json']);
  });
});

test('capability routing: off switch and untiered lanes behave exactly as before', () => {
  withRouting('off', () => {
    const pendingDir = setupPending();
    writeTask(pendingDir, 'small-task', { source: 'trouble_log' });
    assert.deepEqual(pickClaimableTasks(pendingDir, 'worker-3090', routingOpts()), ['small-task.json']);
  });
  withRouting('enforce', () => {
    const pendingDir = setupPending();
    writeTask(pendingDir, 'small-task', { source: 'trouble_log' });
    const untiered = TIERED_LANES.map((l) => ({ ...l, tier: null }));
    assert.deepEqual(pickClaimableTasks(pendingDir, 'worker-3090', routingOpts({ lanes: untiered })), ['small-task.json']);
  });
});

test('probing (enforce, fraction 1): a restricted small lane is offered ONE unproven off-allowlist task per call; the big lane holds probe tasks for an idle small lane', () => {
  const RESTRICTED = TIERED_LANES.map((l) => (l.id === 'worker-rx580' ? { ...l, taskClasses: ['adhoc'] } : l));
  withRouting('enforce', () => {
    const pendingDir = setupPending();
    writeTask(pendingDir, 'probe-a', { source: 'trouble_log' });
    writeTask(pendingDir, 'probe-b', { source: 'trouble_log' });
    writeTask(pendingDir, 'adhoc-task', { source: 'adhoc', humanQueued: true });
    const small = pickClaimableTasks(pendingDir, 'worker-rx580', routingOpts({ lanes: RESTRICTED, scorecard: [] }));
    assert.equal(small.filter((n) => n.startsWith('probe-')).length, 1, 'exactly one probe');
    const bigWhenIdle = pickClaimableTasks(pendingDir, 'worker-3090', routingOpts({ lanes: RESTRICTED, scorecard: [], laneIdle: () => true }));
    assert.deepEqual(bigWhenIdle, ['adhoc-task.json'], 'big lane leaves probe tasks to the idle small lane');
    const bigWhenBusy = pickClaimableTasks(pendingDir, 'worker-3090', routingOpts({ lanes: RESTRICTED, scorecard: [], laneIdle: () => false }));
    assert.equal(bigWhenBusy.length, 3, 'a busy small lane holds nothing');
  }, '1');
});

test('probing: shadow mode and fraction 0 change nothing; paused/ineligible tasks are never probed', () => {
  const RESTRICTED = TIERED_LANES.map((l) => (l.id === 'worker-rx580' ? { ...l, taskClasses: ['adhoc'] } : l));
  withRouting('shadow', () => {
    const pendingDir = setupPending();
    writeTask(pendingDir, 'probe-a', { source: 'trouble_log' });
    assert.deepEqual(pickClaimableTasks(pendingDir, 'worker-rx580', routingOpts({ lanes: RESTRICTED, scorecard: [] })), []);
    const log = fs.readFileSync(path.join(pendingDir, '..', '..', 'instances', 'pipeline-history.log'), 'utf8');
    assert.match(log, /"action":"would-probe"/);
  }, '1');
  withRouting('enforce', () => {
    const pendingDir = setupPending();
    writeTask(pendingDir, 'probe-a', { source: 'trouble_log' });
    assert.deepEqual(pickClaimableTasks(pendingDir, 'worker-rx580', routingOpts({ lanes: RESTRICTED, scorecard: [] })), [], 'fraction 0 = never');
  }, '0');
  withRouting('enforce', () => {
    const pendingDir = setupPending();
    writeTask(pendingDir, 'probe-a', { source: 'trouble_log' });
    const paused = [{ source: 'trouble_log', model: 'small:8b', tier: 8, n: 3, ok: 0, okRate: 0, lower: 0, failStreak: 3 }];
    assert.deepEqual(pickClaimableTasks(pendingDir, 'worker-rx580', routingOpts({ lanes: RESTRICTED, scorecard: paused })), []);
    writeTask(pendingDir, 'human-a', { source: 'trouble_log', humanQueued: true });
    assert.deepEqual(pickClaimableTasks(pendingDir, 'worker-rx580', routingOpts({ lanes: RESTRICTED, scorecard: [] })), ['probe-a.json']);
  }, '1');
});

// --- Lane avoidance must never strand a task (2026-10-17) ---------------------------------------------------------------------------------------------------
// Fields copied from the stranded record (queue/pending/adhoc-initiative-record-design-doc-extend-..., premium): avoidLanes held the biggest lane AND the P40, and the
// only other lane (rx580) has a taskClasses allowlist, so pickClaimableTasks offered it on NO lane.
const STRANDED_RECORD = '{"id": "adhoc-initiative-record-design-doc-extend-the-merged-doc-with-the-missing-sections-docs-only-one-file-1792157631660", "domain": "adhoc", "source": "manual", "humanQueued": true, "premiumPriority": true, "avoidLanes": ["worker-3090", "worker-p40"]}';
const STRANDED_LANES = [
  { id: 'worker-3090', model: 'qwen3.8:27b-q4_K_M', tier: 27, taskClasses: null },
  { id: 'worker-rx580', model: 'qwen3-vl:8b-instruct', tier: 8, taskClasses: ['brain_dump_sort'] },
];

test('lane avoidance never strands: the stranded premium record is claimable on the biggest lane even though it names it', () => {
  const pendingDir = setupPending();
  const rec = JSON.parse(STRANDED_RECORD);
  writeTask(pendingDir, 'stranded', { ...rec, id: 'stranded' });
  assert.deepEqual(pickClaimableTasks(pendingDir, 'worker-3090', { lanes: STRANDED_LANES, graceMs: 0, laneAlive: () => true }), ['stranded.json']);
  assert.deepEqual(pickClaimableTasks(pendingDir, 'worker-rx580', { lanes: STRANDED_LANES, graceMs: 0, laneAlive: () => true }), [], 'the restricted lane still never offers it');
});

test('lane avoidance still steers a task off a lower-tier lane while the bigger lane can take it', () => {
  const pendingDir = setupPending();
  writeTask(pendingDir, 'sort-avoid', { source: 'brain_dump_sort', avoidLanes: ['worker-rx580'] });
  assert.deepEqual(pickClaimableTasks(pendingDir, 'worker-rx580', { lanes: STRANDED_LANES, graceMs: 0, laneAlive: () => true }), [], 'the small lane steps aside');
  assert.deepEqual(pickClaimableTasks(pendingDir, 'worker-3090', { lanes: STRANDED_LANES, graceMs: 0, laneAlive: () => true }), ['sort-avoid.json']);
});

test('lane avoidance does not hold a task for a lane that is known to be down', () => {
  const pendingDir = setupPending();
  writeTask(pendingDir, 'sort-avoid', { source: 'brain_dump_sort', avoidLanes: ['worker-rx580'] });
  const bigDown = (id) => id !== 'worker-3090';
  assert.deepEqual(pickClaimableTasks(pendingDir, 'worker-rx580', { lanes: STRANDED_LANES, graceMs: 0, laneAlive: bigDown }), ['sort-avoid.json'], 'the 3090 is down, so the small lane takes it');
});

test('lane avoidance never strands a task on a switched-off lane: with the only other lane disabled the avoiding lane still claims it; with it idle the avoiding lane skips it', () => {
  const lanes = [{ id: 'worker-3090' }, { id: 'worker-p40' }];
  const heartbeat = (dir, id, status) => fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ instanceId: id, status, lastHeartbeat: new Date().toISOString() }));
  const instancesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-inst-'));
  const pendingDir = setupPending();
  writeTask(pendingDir, 'a-avoided', { source: 'adhoc', humanQueued: true, avoidLanes: ['worker-p40'] });
  heartbeat(instancesDir, 'worker-3090', 'disabled');
  assert.deepEqual(pickClaimableTasks(pendingDir, 'worker-p40', { lanes, graceMs: 0, instancesDir }), ['a-avoided.json'], 'worker-3090 is switched off, so it is not somewhere else the task can go');
  heartbeat(instancesDir, 'worker-3090', 'idle');
  assert.deepEqual(pickClaimableTasks(pendingDir, 'worker-p40', { lanes, graceMs: 0, instancesDir }), [], 'with worker-3090 alive the avoiding lane skips it, as before');
  assert.deepEqual(pickClaimableTasks(pendingDir, 'worker-3090', { lanes, graceMs: 0, instancesDir }), ['a-avoided.json']);
});

// --- the claim path reads its task files through the RAM cache (queue-cache.js) ---

const CACHE_LANES = [{ id: 'worker-3090' }, { id: 'worker-p40' }];

function withEnv(name, value, fn) {
  const prev = process.env[name];
  process.env[name] = value;
  try { return fn(); } finally { if (prev === undefined) delete process.env[name]; else process.env[name] = prev; }
}

function pickFor(pendingDir, lane) {
  return pickClaimableTasks(pendingDir, lane, { lanes: CACHE_LANES, graceMs: 0, instancesDir: path.join(pendingDir, '..', 'instances') });
}

function pickUncached(pendingDir, lane) {
  return withEnv('AGENT_MANAGER_QUEUE_CACHE', 'false', () => pickFor(pendingDir, lane));
}

// One pending directory holding every shape the ranking looks at.
function buildCacheFixture() {
  const pendingDir = setupPending();
  const coordDir = path.join(pendingDir, '..', 'coordinating');
  fs.mkdirSync(coordDir, { recursive: true });
  fs.writeFileSync(path.join(coordDir, 'hub-a.json'), JSON.stringify({ id: 'hub-a', status: 'coordinating', hubPriority: 5, createdAt: '2026-09-01T00:00:00Z' }));
  writeTask(pendingDir, 'pinned-here', { source: 'adhoc', pinnedWorker: 'worker-p40' });
  writeTask(pendingDir, 'pinned-elsewhere', { source: 'adhoc', pinnedWorker: 'worker-3090' });
  writeTask(pendingDir, 'avoids-p40', { source: 'adhoc', humanQueued: true, avoidLanes: ['worker-p40'] });
  writeTask(pendingDir, 'premium', { source: 'adhoc', humanQueued: true, premiumPriority: true });
  writeTask(pendingDir, 'hub-child', { source: 'adhoc', parentHub: 'hub-a' });
  writeTask(pendingDir, 'human-adhoc', { source: 'adhoc', humanQueued: true });
  writeTask(pendingDir, 'bot-adhoc', { source: 'adhoc' });
  writeTask(pendingDir, 'trouble', { source: 'trouble_log' });
  fs.writeFileSync(path.join(pendingDir, 'corrupt.json'), '{ not json');
  fs.writeFileSync(path.join(pendingDir, 'empty.json'), '');
  fs.writeFileSync(path.join(pendingDir, 'notes.txt'), 'not a task');
  return pendingDir;
}

// A directory whose mtime is an hour old: the cache's fast path applies from the second call on (a freshly changed directory is "racy" and is always re-scanned).
function ageDir(dir) {
  const old = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(dir, old, old);
}

// What the ranking must say for the fixture, written out: a pin first, premium next, the hub child, then human adhoc, trouble and bot adhoc, and the
// unreadable files last; worker-p40 never sees the task that degenerated on it nor the one pinned to the other lane. Comparing the cached path with
// the uncached one cannot catch a change that hits both, so the expected lists are explicit.
const CACHE_FIXTURE_CLAIMS = {
  'worker-p40': ['pinned-here.json', 'premium.json', 'hub-child.json', 'human-adhoc.json', 'trouble.json', 'bot-adhoc.json', 'corrupt.json', 'empty.json'],
  'worker-3090': ['pinned-elsewhere.json', 'premium.json', 'hub-child.json', 'avoids-p40.json', 'human-adhoc.json', 'trouble.json', 'bot-adhoc.json', 'corrupt.json', 'empty.json'],
};

test('cache on or off, cold or cached, the claim list is identical for every lane and is the expected one', () => {
  const pendingDir = buildCacheFixture();
  for (const lane of ['worker-p40', 'worker-3090']) {
    const want = pickUncached(pendingDir, lane);
    assert.deepEqual(want, CACHE_FIXTURE_CLAIMS[lane], `uncached list for ${lane}`);
    assert.deepEqual(pickFor(pendingDir, lane), want, `cold call for ${lane}`);
    assert.deepEqual(pickFor(pendingDir, lane), want, `cached call for ${lane}`);
  }
});

test('after an edit to a task file the cached claim list still equals the uncached one', () => {
  const pendingDir = buildCacheFixture();
  pickFor(pendingDir, 'worker-p40');
  writeTask(pendingDir, 'bot-adhoc', { source: 'adhoc', humanQueued: true, premiumPriority: true, note: 'edited in place, longer than before' });
  const bumped = new Date(Date.now() + 5000);
  fs.utimesSync(pendingDir, bumped, bumped); // a directory change makes the next call re-validate at once
  for (const lane of ['worker-p40', 'worker-3090']) assert.deepEqual(pickFor(pendingDir, lane), pickUncached(pendingDir, lane));
  const afterEdit = pickFor(pendingDir, 'worker-3090');
  assert.ok(afterEdit.indexOf('bot-adhoc.json') < afterEdit.indexOf('human-adhoc.json'), 'the edit (now premium) must change the order');
});

test('a cached call reads no task file and stats none', (t) => {
  const pendingDir = buildCacheFixture();
  ageDir(pendingDir);
  const want = pickFor(pendingDir, 'worker-p40');
  const touched = [];
  const realRead = fs.readFileSync;
  const realStat = fs.statSync;
  t.mock.method(fs, 'readFileSync', function (p, ...rest) {
    if (String(p).startsWith(pendingDir + path.sep)) touched.push(`read ${path.basename(String(p))}`);
    return realRead.call(fs, p, ...rest);
  });
  t.mock.method(fs, 'statSync', function (p, ...rest) {
    if (String(p).startsWith(pendingDir + path.sep)) touched.push(`stat ${path.basename(String(p))}`);
    return realStat.call(fs, p, ...rest);
  });
  assert.deepEqual(pickFor(pendingDir, 'worker-p40'), CACHE_FIXTURE_CLAIMS['worker-p40']);
  assert.deepEqual(want, CACHE_FIXTURE_CLAIMS['worker-p40']);
  assert.deepEqual(touched, []);
});

test('a task added after a cached call is offered by the next call, and a task claimed away is not', () => {
  const pendingDir = buildCacheFixture();
  ageDir(pendingDir);
  const before = pickFor(pendingDir, 'worker-3090');
  assert.ok(before.includes('trouble.json'));
  writeTask(pendingDir, 'late-arrival', { source: 'adhoc', humanQueued: true, premiumPriority: true });
  const added = pickFor(pendingDir, 'worker-3090');
  assert.ok(added.includes('late-arrival.json'));
  assert.deepEqual(added, pickUncached(pendingDir, 'worker-3090'));
  const claimedAway = path.join(os.tmpdir(), `claimed-away-${process.pid}-${Date.now()}.json`);
  fs.renameSync(path.join(pendingDir, 'trouble.json'), claimedAway);
  const removed = pickFor(pendingDir, 'worker-3090');
  fs.rmSync(claimedAway, { force: true });
  assert.ok(!removed.includes('trouble.json'));
  assert.deepEqual(removed, pickUncached(pendingDir, 'worker-3090'));
});

test('an unwritable cache root changes nothing in the claim list', () => {
  const pendingDir = buildCacheFixture();
  const blocker = path.join(pendingDir, '..', 'blocker');
  fs.writeFileSync(blocker, 'a file where the cache directory should be');
  const want = pickUncached(pendingDir, 'worker-p40');
  const got = withEnv('AGENT_MANAGER_QUEUE_CACHE_DIR', path.join(blocker, 'cache'), () => [pickFor(pendingDir, 'worker-p40'), pickFor(pendingDir, 'worker-p40')]);
  assert.deepEqual(got[0], want);
  assert.deepEqual(got[1], want);
});

test('a missing or empty pending directory gives an empty list', () => {
  assert.deepEqual(pickFor(path.join(os.tmpdir(), `no-such-pending-${process.pid}-${Date.now()}`), 'worker-p40'), []);
  assert.deepEqual(pickFor(setupPending(), 'worker-p40'), []);
});

// --- one scan per tick: `--with-premium` and the claim loop in scripts/local-worker.sh ---

// A small pending directory with one premium task, no pins and no hub, so the result does not depend on the machine's lane configuration.
function buildPremiumFixture() {
  const pendingDir = setupPending();
  writeTask(pendingDir, 'n-trouble', { source: 'trouble_log' });
  writeTask(pendingDir, 'p-premium', { source: 'adhoc', humanQueued: true, premiumPriority: true });
  writeTask(pendingDir, 'n-human', { source: 'adhoc', humanQueued: true });
  writeTask(pendingDir, 'not-premium-string', { source: 'adhoc', humanQueued: true, premiumPriority: 'true' });
  fs.writeFileSync(path.join(pendingDir, 'corrupt.json'), '{ not json');
  return pendingDir;
}

// The ranker treats any truthy premiumPriority as premium, while the flag (like the shell filter it replaces) is a strict === true: the string 'true' therefore ranks second but is flagged 0.
const PREMIUM_FIXTURE_ORDER = ['p-premium.json', 'not-premium-string.json', 'n-human.json', 'n-trouble.json', 'corrupt.json'];

function runCli(pendingDir, lane, ...extra) {
  const r = spawnSyncTop(process.execPath, [path.join(__dirname, 'next-claimable-task.js'), pendingDir, lane, ...extra], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split('\n').filter(Boolean);
}

test('withPremium rows have the same names in the same order as the plain list, and the flag is exactly premiumPriority === true', () => {
  const pendingDir = buildPremiumFixture();
  const plain = pickClaimableTasks(pendingDir, 'worker-p40');
  const rows = pickClaimableTasks(pendingDir, 'worker-p40', { withPremium: true });
  assert.deepEqual(plain, PREMIUM_FIXTURE_ORDER);
  assert.deepEqual(rows.map((r) => r.name), plain);
  assert.deepEqual(rows.filter((r) => r.premium).map((r) => r.name), ['p-premium.json']);
  assert.ok(rows.every((r) => typeof r.premium === 'boolean'));
});

test('a pinned premium task carries its flag too', () => {
  const pendingDir = setupPending();
  writeTask(pendingDir, 'pinned-premium', { source: 'adhoc', humanQueued: true, premiumPriority: true, pinnedWorker: 'worker-p40' });
  writeTask(pendingDir, 'pinned-plain', { source: 'adhoc', humanQueued: true, pinnedWorker: 'worker-p40' });
  const rows = pickClaimableTasks(pendingDir, 'worker-p40', { withPremium: true });
  assert.deepEqual(rows.map((r) => [r.name, r.premium]).sort(), [['pinned-plain.json', false], ['pinned-premium.json', true]]);
});

test('the command line: --with-premium prints name<TAB>flag per line in the plain order, and without it the output is the plain names', () => {
  const pendingDir = buildPremiumFixture();
  assert.deepEqual(runCli(pendingDir, 'worker-p40'), PREMIUM_FIXTURE_ORDER);
  const withFlag = runCli(pendingDir, 'worker-p40', '--with-premium');
  assert.deepEqual(withFlag.map((l) => l.split('\t')[0]), PREMIUM_FIXTURE_ORDER);
  assert.deepEqual(withFlag.map((l) => l.split('\t')[1]), ['1', '0', '0', '0', '0']);
  assert.deepEqual(runCli(pendingDir, '--with-premium', 'worker-p40'), withFlag, 'the flag may come before the lane');
});

test('with premium rows each task file is read at most once on a cold cache and not at all on a cached call', (t) => {
  const pendingDir = buildPremiumFixture();
  ageDir(pendingDir);
  const reads = [];
  const realRead = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function (p, ...rest) {
    if (String(p).startsWith(pendingDir + path.sep)) reads.push(path.basename(String(p)));
    return realRead.call(fs, p, ...rest);
  });
  pickClaimableTasks(pendingDir, 'worker-p40', { withPremium: true });
  assert.equal(reads.length, PREMIUM_FIXTURE_ORDER.length);
  assert.equal(new Set(reads).size, reads.length, 'no file read twice');
  reads.length = 0;
  pickClaimableTasks(pendingDir, 'worker-p40', { withPremium: true });
  assert.deepEqual(reads, []);
});

// The real claim loop, cut out of scripts/local-worker.sh and run in bash against a fixture.
function claimLoopFromScript() {
  const text = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'local-worker.sh'), 'utf8');
  const start = text.indexOf("    while IFS=$'\\t' read -r name premium_flag; do");
  const endMarker = '--with-premium 2>/dev/null)';
  const end = text.indexOf(endMarker, start) + endMarker.length;
  assert.ok(start > 0 && end > start, 'the claim loop was not found in scripts/local-worker.sh');
  return text.slice(start, end);
}

function runClaimLoop(pendingDir, lane, premiumOnly) {
  const script = `items=()\n${claimLoopFromScript()}\nfor i in "\${items[@]}"; do printf '%s\\n' "$i"; done`;
  const r = spawnSyncTop('bash', ['-c', script], {
    env: { ...process.env, PACKAGE_SRC_DIR: __dirname, pdir: pendingDir, INSTANCE_ID: lane, PREMIUM_ONLY: premiumOnly ? 'true' : 'false' },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split('\n').filter(Boolean);
}

test('local-worker.sh claim loop: a normal tick gets every name in ranked order, a premium-only tick only the premium ones', () => {
  const pendingDir = buildPremiumFixture();
  assert.deepEqual(runClaimLoop(pendingDir, 'worker-p40', false), PREMIUM_FIXTURE_ORDER);
  assert.deepEqual(runClaimLoop(pendingDir, 'worker-p40', true), ['p-premium.json']);
});

test('local-worker.sh reads the pending queue once per tick: one ranking call, no second pass over every file', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'local-worker.sh'), 'utf8');
  assert.equal((text.match(/next-claimable-task\.js" "\$pdir"/g) || []).length, 1);
  assert.ok(!text.includes('filter_premium_names'));
  assert.ok(text.includes('--with-premium'));
});

test('the lane is read correctly whichever side of it --with-premium sits: a task pinned to the lane is offered either way', () => {
  const pendingDir = buildPremiumFixture();
  writeTask(pendingDir, 'pinned-p40', { source: 'adhoc', humanQueued: true, pinnedWorker: 'worker-p40' });
  writeTask(pendingDir, 'pinned-3090', { source: 'adhoc', humanQueued: true, pinnedWorker: 'worker-3090' });
  const after = runCli(pendingDir, 'worker-p40', '--with-premium');
  const before = runCli(pendingDir, '--with-premium', 'worker-p40');
  assert.deepEqual(before, after);
  assert.equal(after[0].split('\t')[0], 'pinned-p40.json');
  assert.ok(!after.some((l) => l.startsWith('pinned-3090.json')));
});

test('local-worker.sh claim loop: a blank line is skipped and a line without a flag is a normal, non-premium task', () => {
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-loop-stub-'));
  fs.writeFileSync(path.join(stubDir, 'next-claimable-task.js'),
    "console.log('');\nconsole.log('a.json\\t1');\nconsole.log('b.json\\t0');\nconsole.log('c.json');\n");
  const run = (premiumOnly) => {
    const script = `items=()\n${claimLoopFromScript()}\nfor i in "\${items[@]}"; do printf '%s\\n' "$i"; done`;
    const r = spawnSyncTop('bash', ['-c', script], {
      env: { ...process.env, PACKAGE_SRC_DIR: stubDir, pdir: '/unused', INSTANCE_ID: 'worker-p40', PREMIUM_ONLY: premiumOnly ? 'true' : 'false' },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.split('\n');
  };
  assert.deepEqual(run(false), ['a.json', 'b.json', 'c.json', '']);
  assert.deepEqual(run(true), ['a.json', '']);
  fs.rmSync(stubDir, { recursive: true, force: true });
});

