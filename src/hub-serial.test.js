'use strict';

// hub-serial.js: HUB#### serials, member ids and titles, and the sweep-side backfill for hubs that predate them.
// Run: node --test src/hub-serial.test.js

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

const {
  formatHubLabel, hasHubTitlePrefix, allocateHubSerial, allocateHubSerials, hubTitle, memberTitle, memberId,
  assignMissingHubSerials, retitleHubMembers,
} = require('./hub-serial.js');
const { queueSubTasks } = require('./apply-adhoc-diff.js');
const { coordinatorSweep } = require('./coordinator-sweep.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hub-serial-'));
const put = (dir, state, rec) => {
  fs.mkdirSync(path.join(dir, 'queue', state), { recursive: true });
  fs.writeFileSync(path.join(dir, 'queue', state, `${rec.id}.json`), JSON.stringify(rec, null, 2));
};
const read = (dir, state, id) => JSON.parse(fs.readFileSync(path.join(dir, 'queue', state, `${id}.json`), 'utf8'));

test('labels are HUB + four digits and titles/ids are built from them', () => {
  assert.equal(formatHubLabel(7), 'HUB0007');
  assert.equal(formatHubLabel(12345), 'HUB12345');
  assert.equal(memberId('HUB0007', 2, 'wire-it'), 'HUB0007-02-wire-it');
  assert.equal(memberTitle('HUB0007', 2, 5, 'Wire it'), 'HUB0007 · 2/5 · Wire it');
  assert.equal(hasHubTitlePrefix('HUB0007 · 2/5 · Wire it'), true);
  assert.equal(hasHubTitlePrefix('HUB0007 · Wire it'), true);
  assert.equal(hasHubTitlePrefix('Wire it'), false);
});

test('a hub title REPLACES a leading candidate id instead of stacking on it, and is idempotent', () => {
  assert.equal(hubTitle('HUB0003', 'AC-2 · Extract pure geometry', 'AC-2'), 'HUB0003 · Extract pure geometry');
  assert.equal(hubTitle('HUB0003', 'AC-2 -- Extract pure geometry', 'AC-2'), 'HUB0003 · Extract pure geometry');
  assert.equal(hubTitle('HUB0003', 'Extract pure geometry', null), 'HUB0003 · Extract pure geometry');
  assert.equal(hubTitle('HUB0003', 'HUB0003 · Extract pure geometry', null), 'HUB0003 · Extract pure geometry');
  assert.equal(memberTitle('HUB0003', 1, 2, 'HUB0003 · 1/2 · x'), 'HUB0003 · 1/2 · x');
});

test('serials are monotonic and never reused; a block allocation is consecutive', () => {
  const dir = tmp();
  assert.equal(allocateHubSerial(dir), 1);
  assert.equal(allocateHubSerial(dir), 2);
  assert.equal(allocateHubSerials(dir, 3), 3);
  assert.equal(allocateHubSerial(dir), 6);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'hub-serials.json'), 'utf8')).next, 7);
});

test('queueSubTasks: each hub gets its own serial; members are HUB####-NN-slug with HUB#### · i/n · titles', () => {
  const dir = tmp();
  const a = queueSubTasks([{ title: 'Create tileGrid', rawText: 'x' }, { title: 'Wire it', rawText: 'y' }], dir, 'parent-a', {});
  const b = queueSubTasks([{ title: 'Other one', rawText: 'x' }, { title: 'Other two', rawText: 'y' }], dir, 'parent-b', {});
  assert.deepEqual([a.hubSerial, a.hubLabel, b.hubSerial, b.hubLabel], [1, 'HUB0001', 2, 'HUB0002']);
  assert.deepEqual(a.map((q) => q.id), ['HUB0001-01-create-tilegrid', 'HUB0001-02-wire-it']);
  assert.deepEqual(a.map((q) => q.title), ['HUB0001 · 1/2 · Create tileGrid', 'HUB0001 · 2/2 · Wire it']);
  assert.deepEqual(b.map((q) => q.id), ['HUB0002-01-other-one', 'HUB0002-02-other-two']);
  const rec = read(dir, 'adhoc', 'HUB0001-02-wire-it');
  assert.equal(rec.title, 'HUB0001 · 2/2 · Wire it');
  assert.deepEqual(rec.dependsOn, ['HUB0001-01-create-tilegrid']);
  assert.equal(rec.promptContext.decomposedFrom, 'parent-a');
});

test('assignMissingHubSerials numbers older hubs oldest-first, retitles them, and never renumbers a labelled hub', () => {
  const dir = tmp();
  const sub = (id) => ({ id, title: `t ${id}`, status: 'pending' });
  put(dir, 'coordinating', { id: 'newer', title: 'Newer', createdAt: '2026-09-20T03:00:00Z', subTasks: [sub('n1')] });
  put(dir, 'coordinating', { id: 'older', title: 'AC-2 · Older hub', createdAt: '2026-09-20T01:00:00Z', promptContext: { candidateId: 'AC-2' }, subTasks: [sub('o1')] });
  put(dir, 'coordinating', { id: 'done-already', title: 'Has one', hubSerial: 40, hubLabel: 'HUB0040', createdAt: '2026-09-19T00:00:00Z', subTasks: [sub('d1')] });
  assert.equal(assignMissingHubSerials(dir), 2);
  const older = read(dir, 'coordinating', 'older');
  const newer = read(dir, 'coordinating', 'newer');
  assert.deepEqual([older.hubSerial, older.hubLabel, older.title], [1, 'HUB0001', 'HUB0001 · Older hub']);
  assert.deepEqual([newer.hubSerial, newer.title], [2, 'HUB0002 · Newer']);
  assert.equal(read(dir, 'coordinating', 'done-already').hubSerial, 40);
  assert.equal(assignMissingHubSerials(dir), 0, 'idempotent');
});

test('retitleHubMembers: checklist titles always follow; idle member records are rewritten, in-flight ones are left for a later tick', () => {
  const dir = tmp();
  put(dir, 'adhoc', { id: 'm1', title: 'First', source: 'manual' });
  put(dir, 'drafting/worker-3090', { id: 'm2', title: 'Second', source: 'manual' });
  const hub = { hubLabel: 'HUB0009', subTasks: [{ id: 'm1', title: 'First', status: 'pending' }, { id: 'm2', title: 'Second', status: 'in-progress' }] };
  const recs = new Map([
    ['m1', { task: read(dir, 'adhoc', 'm1'), state: 'adhoc', file: path.join(dir, 'queue', 'adhoc', 'm1.json') }],
    ['m2', { task: read(dir, 'drafting/worker-3090', 'm2'), state: 'drafting', file: path.join(dir, 'queue', 'drafting', 'worker-3090', 'm2.json') }],
  ]);
  assert.equal(retitleHubMembers(hub, recs), 1);
  assert.deepEqual(hub.subTasks.map((s) => s.title), ['HUB0009 · 1/2 · First', 'HUB0009 · 2/2 · Second']);
  assert.equal(read(dir, 'adhoc', 'm1').title, 'HUB0009 · 1/2 · First');
  assert.equal(read(dir, 'drafting/worker-3090', 'm2').title, 'Second', 'a child a worker is drafting is not rewritten under it');
  assert.equal(retitleHubMembers(hub, recs), 0, 'idempotent');
});

test('coordinatorSweep labels a pre-serial hub and its idle members end to end', () => {
  const dir = tmp();
  put(dir, 'coordinating', { id: 'function-length-fix-ac-2', title: 'AC-2 · Extract pure geometry', createdAt: '2026-09-20T01:00:00Z', promptContext: { candidateId: 'AC-2' },
    subTasks: [{ id: 'p1', title: 'Piece one', status: 'pending' }, { id: 'p2', title: 'Piece two', status: 'pending' }] });
  put(dir, 'adhoc', { id: 'p1', title: 'Piece one', source: 'manual', domain: 'adhoc' });
  put(dir, 'adhoc', { id: 'p2', title: 'Piece two', source: 'manual', domain: 'adhoc' });
  const summary = coordinatorSweep({ pipelineDir: dir, repoRoot: null });
  assert.equal(summary.hubsLabelled, 1);
  const hub = read(dir, 'coordinating', 'function-length-fix-ac-2');
  assert.equal(hub.title, 'HUB0001 · Extract pure geometry');
  assert.equal(hub.hubLabel, 'HUB0001');
  assert.deepEqual(hub.subTasks.map((s) => s.title), ['HUB0001 · 1/2 · Piece one', 'HUB0001 · 2/2 · Piece two']);
  assert.equal(read(dir, 'adhoc', 'p2').title, 'HUB0001 · 2/2 · Piece two');
});
