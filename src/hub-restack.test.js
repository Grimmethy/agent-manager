'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// coordinator-sweep.js now calls ensureRegistered() at load time (S4a of the hub-tasks
// extraction, 2026-09-24), which reads AGENT_MANAGER_REPO_ROOT via getConfig() -- same
// forced (not `||`-defaulted) guard review-task.test.js/apply-task.test.js already use.
process.env.AGENT_MANAGER_REPO_ROOT = require('os').tmpdir();
process.env.AGENT_MANAGER_PIPELINE_DIR = process.env.AGENT_MANAGER_REPO_ROOT;

const { restackHubChain } = require('./hub-restack.js');
const { coordinatorSweep } = require('./coordinator-sweep.js');
const { hubHasUnmergedEarlierSibling } = require('./hub-priority.js');
const { isDependencySatisfied } = require('./task-sources.js');

const B = 'agent/decompose-nested-hub';

function makePipeline() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-restack-'));
  for (const s of ['coordinating', 'adhoc', 'pending', 'drafting/worker-1', 'blocked', 'done', 'review']) fs.mkdirSync(path.join(dir, 'queue', s), { recursive: true });
  return dir;
}
const put = (dir, state, task) => { const f = path.join(dir, 'queue', state, `${task.id}.json`); fs.writeFileSync(f, JSON.stringify(task, null, 2)); return f; };
const read = (dir, state, id) => JSON.parse(fs.readFileSync(path.join(dir, 'queue', state, `${id}.json`), 'utf8'));
const child = (id, over = {}) => ({ id, domain: 'adhoc', source: 'manual', title: id, promptContext: { rawText: id, decomposedFrom: 'hub-n' }, history: [], ...over });

// The live PF nested hub: piece 0 done + stacked; piece 1 independent + unstarted; piece 2 stacked 2/2 depending only on piece 0.
function mixedHub(dir) {
  put(dir, 'coordinating', { id: 'hub-n', status: 'coordinating', history: [], subTasks: ['p0', 'p1', 'p2'].map((id) => ({ id, title: id, status: 'pending' })) });
  put(dir, 'done', child('p0', { terminalDisposition: 'pending-merge', stacked: { branch: B, seq: 1, total: 2 } }));
  put(dir, 'adhoc', child('p1'));
  put(dir, 'adhoc', child('p2', { stacked: { branch: B, seq: 2, total: 2 }, dependsOn: ['p0'] }));
}

test('the live nested-hub shape: the independent piece and the wiring piece are put on the chain, in hub order, and nothing waits on a merge any more', () => {
  const dir = makePipeline();
  mixedHub(dir);
  // before: the independent piece is held behind piece 0's unmerged branch
  assert.equal(hubHasUnmergedEarlierSibling(dir, read(dir, 'adhoc', 'p1'), { subTasks: [{ id: 'p0', status: 'pending-merge' }, { id: 'p1', status: 'in-progress' }, { id: 'p2', status: 'in-progress' }], id: 'hub-n' }).blocked, true);

  const summary = coordinatorSweep({ pipelineDir: dir, repoRoot: dir });
  assert.equal(summary.restacked, 2);

  const p1 = read(dir, 'adhoc', 'p1');
  const p2 = read(dir, 'adhoc', 'p2');
  assert.deepEqual(p1.stacked, { branch: B, seq: 2, total: 3 });
  assert.deepEqual(p1.dependsOn, ['p0']);
  assert.deepEqual(p2.stacked, { branch: B, seq: 3, total: 3 });
  assert.deepEqual(p2.dependsOn, ['p1'], 'the wiring piece now waits for BOTH creators, through the chain');
  assert.equal(p1.history.at(-1).stage, 'restacked');
  assert.ok(read(dir, 'coordinating', 'hub-n').history.some((h) => /restacked 2 piece\(s\)/.test(h.detail || '')));

  // after: both real gates release piece 1 with piece 0 still unmerged
  const hub = read(dir, 'coordinating', 'hub-n');
  assert.equal(isDependencySatisfied(dir, 'p0'), true, 'a stacked predecessor that reached done/ is satisfied without a merge');
  assert.equal(hubHasUnmergedEarlierSibling(dir, p1, hub).blocked, false);
  assert.equal(hub.subTasks[1].heldFor, undefined);
});

test('idempotent: a second sweep changes nothing', () => {
  const dir = makePipeline();
  mixedHub(dir);
  coordinatorSweep({ pipelineDir: dir, repoRoot: dir });
  const before = fs.readFileSync(path.join(dir, 'queue', 'adhoc', 'p1.json'), 'utf8');
  const s2 = coordinatorSweep({ pipelineDir: dir, repoRoot: dir });
  assert.equal(s2.restacked, undefined);
  assert.equal(fs.readFileSync(path.join(dir, 'queue', 'adhoc', 'p1.json'), 'utf8'), before);
});

function recs(dir, ids) {
  const m = new Map();
  for (const id of ids) {
    for (const state of ['adhoc', 'pending', 'done', 'drafting/worker-1', 'blocked']) {
      const file = path.join(dir, 'queue', state, `${id}.json`);
      if (fs.existsSync(file)) { m.set(id, { task: JSON.parse(fs.readFileSync(file, 'utf8')), state: state.split('/')[0], file }); break; }
    }
  }
  return m;
}
const hubOf = (ids) => ({ id: 'hub-n', subTasks: ids.map((id) => ({ id })) });

test('never touches a piece that has started (drafting / blocked / done), and leaves a later piece alone only until it can be linked to a real predecessor', () => {
  const dir = makePipeline();
  put(dir, 'done', child('p0', { stacked: { branch: B, seq: 1, total: 3 } }));
  put(dir, 'drafting/worker-1', child('p1'));                       // started, unstacked: left exactly as it is
  put(dir, 'adhoc', child('p2'));
  const changed = restackHubChain(hubOf(['p0', 'p1', 'p2']), recs(dir, ['p0', 'p1', 'p2']));
  assert.deepEqual(changed, ['p2']);
  assert.equal(read(dir, 'drafting/worker-1', 'p1').stacked, undefined);
  assert.deepEqual(read(dir, 'adhoc', 'p2').dependsOn, ['p1'], 'still chains after the started piece');
});

test('leaves alone: a hub with no chain at all, a hub whose stacked pieces span two branches, a file-decompose hub, and a lone-piece hub', () => {
  const noChain = makePipeline();
  put(noChain, 'adhoc', child('a')); put(noChain, 'adhoc', child('b'));
  assert.deepEqual(restackHubChain(hubOf(['a', 'b']), recs(noChain, ['a', 'b'])), [], 'fully independent hubs are not converted');

  const two = makePipeline();
  put(two, 'done', child('a', { stacked: { branch: 'agent/x', seq: 1, total: 2 } }));
  put(two, 'done', child('b', { stacked: { branch: 'agent/y', seq: 1, total: 2 } }));
  put(two, 'adhoc', child('c'));
  assert.deepEqual(restackHubChain(hubOf(['a', 'b', 'c']), recs(two, ['a', 'b', 'c'])), []);

  const fd = makePipeline();
  put(fd, 'done', child('a', { stacked: { branch: B, seq: 1, total: 2 } })); put(fd, 'adhoc', child('b'));
  assert.deepEqual(restackHubChain({ ...hubOf(['a', 'b']), decomposeHub: true }, recs(fd, ['a', 'b'])), []);
  assert.deepEqual(restackHubChain({ ...hubOf(['a', 'b']), mode: 'stacked' }, recs(fd, ['a', 'b'])), []);
  assert.deepEqual(restackHubChain(hubOf(['a']), recs(fd, ['a'])), []);
});

test('keeps a dependsOn that points OUTSIDE the hub, and skips a missing predecessor instead of linking to a task that can never be satisfied', () => {
  const dir = makePipeline();
  put(dir, 'done', child('p0', { stacked: { branch: B, seq: 1, total: 3 } }));
  put(dir, 'adhoc', child('p2', { dependsOn: ['some-outside-task'] }));
  // p1 has no record anywhere (aged out)
  const changed = restackHubChain(hubOf(['p0', 'p1', 'p2']), recs(dir, ['p0', 'p1', 'p2']));
  assert.deepEqual(changed, ['p2']);
  assert.deepEqual(read(dir, 'adhoc', 'p2').dependsOn, ['some-outside-task', 'p0']);
});

test('kill switch AGENT_MANAGER_HUB_RESTACK=false', () => {
  const dir = makePipeline();
  mixedHub(dir);
  process.env.AGENT_MANAGER_HUB_RESTACK = 'false';
  try {
    assert.equal(coordinatorSweep({ pipelineDir: dir, repoRoot: dir }).restacked, undefined);
    assert.equal(read(dir, 'adhoc', 'p1').stacked, undefined);
  } finally { delete process.env.AGENT_MANAGER_HUB_RESTACK; }
});

// 2026-09-20, PF HUB0003: a NESTED hub (the parent is itself step 3/3 of a chain on the same branch) was renumbered 1/3..3/3, so its
// first child looked like the chain start and apply reset the branch away, discarding steps 1-2. It must take the parent's slot.
test('a nested hub takes its parent\'s slot in the chain: children are numbered from the parent\'s seq, not from 1', () => {
  const dir = makePipeline();
  put(dir, 'coordinating', { id: 'hub-n', status: 'coordinating', history: [], stacked: { branch: B, seq: 3, total: 3 }, subTasks: ['c1', 'c2', 'c3'].map((id) => ({ id, title: id, status: 'pending' })) });
  put(dir, 'adhoc', child('c1', { stacked: { branch: B, seq: 3, total: 5 } }));
  put(dir, 'adhoc', child('c2', { stacked: { branch: B, seq: 1, total: 3 } }));
  put(dir, 'adhoc', child('c3'));
  const changed = restackHubChain(read(dir, 'coordinating', 'hub-n'), recs(dir, ['c1', 'c2', 'c3']));
  assert.deepEqual(changed.sort(), ['c2', 'c3']);
  assert.deepEqual(read(dir, 'adhoc', 'c1').stacked, { branch: B, seq: 3, total: 5 }, 'already correct: untouched');
  assert.deepEqual(read(dir, 'adhoc', 'c2').stacked, { branch: B, seq: 4, total: 5 });
  assert.deepEqual(read(dir, 'adhoc', 'c3').stacked, { branch: B, seq: 5, total: 5 });
  assert.deepEqual(restackHubChain(read(dir, 'coordinating', 'hub-n'), recs(dir, ['c1', 'c2', 'c3'])), [], 'idempotent');
});

test('a hub whose own stacked slot is on a DIFFERENT branch does not offset its children', () => {
  const dir = makePipeline();
  put(dir, 'coordinating', { id: 'hub-n', status: 'coordinating', history: [], stacked: { branch: 'agent/decompose-other', seq: 2, total: 2 }, subTasks: ['c1', 'c2'].map((id) => ({ id, title: id, status: 'pending' })) });
  put(dir, 'adhoc', child('c1', { stacked: { branch: B, seq: 1, total: 2 } }));
  put(dir, 'adhoc', child('c2'));
  restackHubChain(read(dir, 'coordinating', 'hub-n'), recs(dir, ['c1', 'c2']));
  assert.deepEqual(read(dir, 'adhoc', 'c2').stacked, { branch: B, seq: 2, total: 2 });
});
