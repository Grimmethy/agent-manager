'use strict';

// hub-rename.js: a hub's record takes its HUB#### id, references follow, in-flight members are healed later.
// Run: node --test src/hub-rename.test.js

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

const { renameHub, repairStaleHubRefs } = require('./hub-rename.js');
const { coordinatorSweep } = require('./coordinator-sweep.js');
const { findTaskRecordById } = require('./forensic-bundle.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hub-rename-'));
const put = (dir, sub, rec) => {
  fs.mkdirSync(path.join(dir, 'queue', sub), { recursive: true });
  fs.writeFileSync(path.join(dir, 'queue', sub, `${rec.id}.json`), JSON.stringify(rec, null, 2));
};
const read = (dir, sub, id) => JSON.parse(fs.readFileSync(path.join(dir, 'queue', sub, `${id}.json`), 'utf8'));
const exists = (dir, sub, id) => fs.existsSync(path.join(dir, 'queue', sub, `${id}.json`));

// Outer hub (function-length-fix-ac-2 -> HUB0001) with a done piece, a nested hub member (-> HUB0002) and an in-flight piece inside the nested hub.
function fixture() {
  const dir = tmp();
  put(dir, 'coordinating', { id: 'outer', hubSerial: 1, hubLabel: 'HUB0001', title: 'HUB0001 · Outer', createdAt: '2026-09-20T01:00:00Z',
    subTasks: [{ id: 'o1', title: 'HUB0001 · 1/2 · one', status: 'done' }, { id: 'nested', title: 'HUB0002 · Nested', status: 'in-progress' }] });
  put(dir, 'done', { id: 'o1', title: 'HUB0001 · 1/2 · one', promptContext: { decomposedFrom: 'outer' } });
  put(dir, 'coordinating', { id: 'nested', hubSerial: 2, hubLabel: 'HUB0002', title: 'HUB0002 · Nested', parentHub: 'outer', promptContext: { decomposedFrom: 'outer' },
    createdAt: '2026-09-20T02:00:00Z', subTasks: [{ id: 'n1', title: 'HUB0002 · 1/2 · a', status: 'pending' }, { id: 'n2', title: 'HUB0002 · 2/2 · b', status: 'in-progress' }] });
  put(dir, 'adhoc', { id: 'n1', title: 'HUB0002 · 1/2 · a', promptContext: { decomposedFrom: 'nested' } });
  put(dir, 'drafting/worker-3090', { id: 'n2', title: 'HUB0002 · 2/2 · b', promptContext: { decomposedFrom: 'nested' } });
  put(dir, 'adhoc', { id: 'waiter', title: 'waits on the nested hub', dependsOn: ['nested', 'other'], promptContext: {} });
  return dir;
}

test('renameHub: the record takes its label as id, remembers the old id, and idle references follow', () => {
  const dir = fixture();
  const r = renameHub(dir, 'nested');
  assert.deepEqual([r.renamed, r.from, r.to], [true, 'nested', 'HUB0002']);
  assert.equal(exists(dir, 'coordinating', 'nested'), false);
  const hub = read(dir, 'coordinating', 'HUB0002');
  assert.equal(hub.id, 'HUB0002');
  assert.deepEqual(hub.formerIds, ['nested']);
  assert.match(hub.history[hub.history.length - 1].detail || hub.history[hub.history.length - 1].message || '', /nested -> HUB0002/);
  assert.equal(read(dir, 'coordinating', 'outer').subTasks[1].id, 'HUB0002', "the parent hub's checklist entry follows");
  assert.equal(read(dir, 'adhoc', 'n1').promptContext.decomposedFrom, 'HUB0002');
  assert.deepEqual(read(dir, 'adhoc', 'waiter').dependsOn, ['HUB0002', 'other']);
  assert.equal(read(dir, 'drafting/worker-3090', 'n2').promptContext.decomposedFrom, 'nested', 'a member a worker is drafting is NOT rewritten under it');
  assert.deepEqual(r.deferred, ['n2']);
});

test('renameHub: renaming the outer hub updates the nested hub parentHub / decomposedFrom and done members; member ids never change', () => {
  const dir = fixture();
  assert.equal(renameHub(dir, 'outer').renamed, true);
  const nested = read(dir, 'coordinating', 'nested');
  assert.equal(nested.parentHub, 'HUB0001');
  assert.equal(nested.promptContext.decomposedFrom, 'HUB0001');
  assert.equal(read(dir, 'done', 'o1').promptContext.decomposedFrom, 'HUB0001');
  assert.ok(exists(dir, 'done', 'o1'), 'member id and file are untouched');
});

test('renameHub refuses safely: unknown hub, no label yet, already renamed, target exists', () => {
  const dir = fixture();
  put(dir, 'coordinating', { id: 'unlabelled', title: 'x', subTasks: [{ id: 'u', status: 'pending' }] });
  assert.equal(renameHub(dir, 'missing').renamed, false);
  assert.match(renameHub(dir, 'unlabelled').reason, /no hubLabel/);
  assert.equal(renameHub(dir, 'nested').renamed, true);
  assert.equal(renameHub(dir, 'HUB0002').reason, 'already renamed');
  put(dir, 'coordinating', { id: 'clash', hubLabel: 'HUB0001', title: 'x', subTasks: [] });
  put(dir, 'coordinating', { id: 'HUB0001', hubLabel: 'HUB0001', title: 'x', subTasks: [] });
  assert.match(renameHub(dir, 'clash').reason, /already exists/);
});

test('repairStaleHubRefs / coordinatorSweep heal the deferred member once it is idle (and never before)', () => {
  const dir = fixture();
  renameHub(dir, 'nested');
  const hub = read(dir, 'coordinating', 'HUB0002');
  const rec = (id) => findTaskRecordById(dir, id);
  const recById = new Map([['n1', rec('n1')], ['n2', rec('n2')]]);
  assert.equal(repairStaleHubRefs(hub, recById), 0, 'n2 is still drafting');
  // the worker finishes: the record settles in done/
  fs.renameSync(path.join(dir, 'queue', 'drafting', 'worker-3090', 'n2.json'), path.join(dir, 'queue', 'done', 'n2.json'));
  const summary = coordinatorSweep({ pipelineDir: dir, repoRoot: null });
  assert.equal(summary.staleHubRefsRepaired, 1);
  assert.equal(read(dir, 'done', 'n2').promptContext.decomposedFrom, 'HUB0002');
  assert.equal(coordinatorSweep({ pipelineDir: dir, repoRoot: null }).staleHubRefsRepaired, undefined, 'idempotent');
});
