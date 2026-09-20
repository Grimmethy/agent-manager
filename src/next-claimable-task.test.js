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
