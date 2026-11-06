'use strict';

// Tests for src/hub-add-piece.js (2026-10-31): a follow-up piece attached to an already-coordinating hub, so the hub's checklist (and readyToMerge)
// waits for it. Real files in temp pipelines; the clock and the wait are injected. Run: node --test src/hub-add-piece.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { addPieceToHub } = require('./hub-add-piece.js');

const NOW = () => '2026-10-31T12:00:00.000Z';
const NO_WAIT = () => {};
const BRANCH = 'agent/decompose-adhoc-big-task-111';

function makePipeline({ pieces = 3, stackedChain = true, hubExtra = {}, premium = true, otherBranchOn = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-add-piece-'));
  for (const s of ['coordinating', 'adhoc', 'done', 'pending']) fs.mkdirSync(path.join(dir, 'queue', s), { recursive: true });
  const subTasks = [];
  for (let i = 1; i <= pieces; i += 1) {
    const id = `HUB0900-0${i}-piece-${i}`;
    const rec = { id, domain: 'adhoc', source: 'manual', title: `HUB0900 · ${i}/${pieces} · piece ${i}`, promptContext: { rawText: `piece ${i}`, decomposedFrom: 'adhoc-big-task-111' } };
    if (stackedChain) { rec.stacked = { branch: otherBranchOn === i ? 'agent/other-chain' : BRANCH, seq: i, total: pieces }; if (i > 1) rec.dependsOn = [`HUB0900-0${i - 1}-piece-${i - 1}`]; }
    const state = i === 1 ? 'done' : 'adhoc';
    fs.writeFileSync(path.join(dir, 'queue', state, `${id}.json`), JSON.stringify(rec, null, 2));
    subTasks.push({ id, title: rec.title, status: i === 1 ? 'pending-merge' : 'pending', phase: i === 1 ? 'built' : 'open' });
  }
  const hub = { id: 'adhoc-big-task-111', title: 'Big task', hubLabel: 'HUB0900', hubSerial: 900, subTasks, ownerGates: [], history: [], ...(premium ? { premiumPriority: true } : {}), ...hubExtra };
  fs.writeFileSync(path.join(dir, 'queue', 'coordinating', `${hub.id}.json`), JSON.stringify(hub, null, 2));
  return { dir, hubId: hub.id, hubFile: path.join(dir, 'queue', 'coordinating', `${hub.id}.json`) };
}
const readHub = (p) => JSON.parse(fs.readFileSync(p.hubFile, 'utf8'));
const add = (p, extra = {}) => addPieceToHub({ pipelineDir: p.dir, hubId: p.hubId, title: 'Gate the pool sweep', rawText: 'Do the gate.', who: 'tester', reason: 'corrective', now: NOW, sleep: NO_WAIT, ...extra });

test('a new piece is built exactly like a decomposed one and listed on the hub', () => {
  const p = makePipeline();
  const r = add(p, { files: ['src/a.js', 'src/b.js'] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.id, 'HUB0900-04-gate-the-pool-sweep');
  assert.equal(r.total, 4);
  const child = JSON.parse(fs.readFileSync(path.join(p.dir, 'queue', 'adhoc', `${r.id}.json`), 'utf8'));
  assert.equal(child.title, 'HUB0900 · 4/4 · Gate the pool sweep');
  assert.equal(child.domain, 'adhoc');
  assert.equal(child.source, 'manual');
  assert.deepEqual(child.stacked, { branch: BRANCH, seq: 4, total: 4 });
  assert.deepEqual(child.dependsOn, ['HUB0900-03-piece-3']);
  assert.equal(child.premiumPriority, true);
  assert.equal(child.promptContext.decomposedFrom, 'adhoc-big-task-111');
  assert.match(child.promptContext.rawText, /^Do the gate\.\nFiles: src\/a\.js, src\/b\.js$/);
  const hub = readHub(p);
  assert.equal(hub.subTasks.length, 4);
  assert.deepEqual(hub.subTasks[3], { id: r.id, title: child.title, status: 'pending' });
  assert.match(hub.history.at(-1).detail, /added to the hub by tester: corrective -- the hub is not ready to merge until it is built/);
  assert.equal(hub.hubLabel, 'HUB0900');
});

test('two adds get distinct ids and the next sequence numbers', () => {
  const p = makePipeline();
  const a = add(p, { title: 'First extra' });
  const b = add(p, { title: 'Second extra' });
  assert.equal(a.ok && b.ok, true);
  assert.notEqual(a.id, b.id);
  const bChild = JSON.parse(fs.readFileSync(path.join(p.dir, 'queue', 'adhoc', `${b.id}.json`), 'utf8'));
  assert.equal(bChild.stacked.seq, 5);
  assert.deepEqual(bChild.dependsOn, [a.id]);
  assert.equal(readHub(p).subTasks.length, 5);
});

test('a hub of independent pieces gets an unstacked piece with no dependsOn', () => {
  const p = makePipeline({ stackedChain: false });
  const r = add(p);
  const child = JSON.parse(fs.readFileSync(path.join(p.dir, 'queue', 'adhoc', `${r.id}.json`), 'utf8'));
  assert.equal(child.stacked, undefined);
  assert.equal(child.dependsOn, undefined);
});

test('premium is inherited only when the hub has it', () => {
  const p = makePipeline({ premium: false });
  const r = add(p);
  assert.equal(JSON.parse(fs.readFileSync(path.join(p.dir, 'queue', 'adhoc', `${r.id}.json`), 'utf8')).premiumPriority, undefined);
});

test('an explicit dependsOn overrides the previous-piece default', () => {
  const p = makePipeline();
  const r = add(p, { dependsOn: ['HUB0900-02-piece-2'] });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(p.dir, 'queue', 'adhoc', `${r.id}.json`), 'utf8')).dependsOn, ['HUB0900-02-piece-2']);
});

test('refuses a hub that is not coordinating, or has no pieces, or is a file-decompose hub', () => {
  const p = makePipeline();
  assert.match(addPieceToHub({ pipelineDir: p.dir, hubId: 'no-such-hub', title: 't', rawText: 'r', sleep: NO_WAIT }).error, /^no coordinating hub 'no-such-hub'/);
  const fd = makePipeline({ hubExtra: { mode: 'file-decompose' } });
  assert.match(add(fd).error, /file-decompose hub/);
  const empty = makePipeline({ pieces: 0 });
  assert.match(add(empty).error, /no subTasks list/);
});

test('refuses to guess when the pieces span several branches', () => {
  const p = makePipeline({ otherBranchOn: 2 });
  assert.match(add(p).error, /span 2 branches/);
  assert.equal(readHub(p).subTasks.length, 3);
  assert.equal(fs.readdirSync(path.join(p.dir, 'queue', 'adhoc')).filter((f) => f.includes('gate-the-pool')).length, 0, 'no child file left behind');
});

test('requires a title and a rawText for a new piece', () => {
  const p = makePipeline();
  assert.match(add(p, { title: '  ' }).error, /title is required/);
  assert.match(add(p, { rawText: '' }).error, /rawText/);
});

test('an id that already exists as an unlisted record is refused, not overwritten', () => {
  const p = makePipeline();
  const orphan = path.join(p.dir, 'queue', 'adhoc', 'HUB0900-04-gate-the-pool-sweep.json');
  fs.writeFileSync(orphan, JSON.stringify({ id: 'HUB0900-04-gate-the-pool-sweep', note: 'filed by hand earlier' }));
  const r = add(p);
  assert.equal(r.ok, false);
  assert.match(r.error, /already exists/);
  assert.equal(JSON.parse(fs.readFileSync(orphan, 'utf8')).note, 'filed by hand earlier', 'the existing record is untouched');
  assert.equal(readHub(p).subTasks.length, 3);
});

test('a piece that needs the owner is listed in the hub ownerGates', () => {
  const p = makePipeline();
  const r = add(p, { rawText: 'This is a design decision for the owner.' });
  assert.equal(r.ownerGate, 'design decision');
  assert.equal(readHub(p).ownerGates.at(-1).id, r.id);
});

test('adopt attaches an existing child that names this hub, without rewriting it', () => {
  const p = makePipeline();
  const id = 'HUB0900-05-hand-filed';
  const rec = { id, domain: 'adhoc', source: 'manual', title: 'HUB0900 · 5/5 · hand filed', promptContext: { rawText: 'x', decomposedFrom: 'adhoc-big-task-111' }, stacked: { branch: BRANCH, seq: 5, total: 5 }, dependsOn: ['HUB0900-03-piece-3'] };
  const file = path.join(p.dir, 'queue', 'adhoc', `${id}.json`);
  fs.writeFileSync(file, JSON.stringify(rec));
  const before = fs.readFileSync(file, 'utf8');
  const r = addPieceToHub({ pipelineDir: p.dir, hubId: p.hubId, adopt: id, who: 'tester', now: NOW, sleep: NO_WAIT });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.adopted, true);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'the adopted record is left untouched');
  assert.equal(readHub(p).subTasks.at(-1).id, id);
  assert.equal(addPieceToHub({ pipelineDir: p.dir, hubId: p.hubId, adopt: id, now: NOW, sleep: NO_WAIT }).already, true, 'adopting twice is idempotent');
  assert.equal(readHub(p).subTasks.filter((s) => s.id === id).length, 1);
});

test('adopt refuses a child of another hub, a missing child, and a child on another branch', () => {
  const p = makePipeline();
  const mk = (id, extra) => fs.writeFileSync(path.join(p.dir, 'queue', 'adhoc', `${id}.json`), JSON.stringify({ id, title: id, promptContext: { rawText: 'x', decomposedFrom: 'adhoc-big-task-111' }, ...extra }));
  mk('other-hub-child', { promptContext: { rawText: 'x', decomposedFrom: 'some-other-hub' } });
  mk('wrong-branch', { stacked: { branch: 'agent/else', seq: 9, total: 9 } });
  const run = (adopt) => addPieceToHub({ pipelineDir: p.dir, hubId: p.hubId, adopt, now: NOW, sleep: NO_WAIT });
  assert.match(run('other-hub-child').error, /not 'adhoc-big-task-111'/);
  assert.match(run('nope').error, /no task record/);
  assert.match(run('wrong-branch').error, /stacked on agent\/else/);
  assert.equal(readHub(p).subTasks.length, 3);
});

test('a coordinator write that drops the new entry is detected and re-applied', () => {
  const p = makePipeline();
  const stale = readHub(p);
  let calls = 0;
  const sleep = () => { calls += 1; if (calls === 2) fs.writeFileSync(p.hubFile, JSON.stringify(stale, null, 2)); }; // the sweep writes its old copy back
  const r = add(p, { sleep });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(calls >= 3, `the write was verified by reading it back (waited ${calls} times), and re-applied after the stale overwrite`);
  assert.equal(readHub(p).subTasks.length, 4, 'the entry survived the stale overwrite');
  assert.equal(readHub(p).subTasks.filter((x) => x.id === r.id).length, 1, 'and is listed exactly once');
});

test('without any concurrent write the entry is listed once and the write is still verified', () => {
  const p = makePipeline();
  let calls = 0;
  const r = add(p, { sleep: () => { calls += 1; } });
  assert.equal(r.ok, true);
  assert.ok(calls >= 2, 'read back at least twice');
  assert.equal(readHub(p).subTasks.filter((x) => x.id === r.id).length, 1);
});

test('the kill switch refuses and changes nothing', () => {
  const p = makePipeline();
  process.env.AGENT_MANAGER_HUB_ADD_PIECE = 'false';
  try {
    assert.match(add(p).error, /switched off/);
  } finally { delete process.env.AGENT_MANAGER_HUB_ADD_PIECE; }
  assert.equal(readHub(p).subTasks.length, 3);
});

test('the CLI prints one JSON line and exits 0 on success, 1 on a refusal', () => {
  const p = makePipeline();
  const pc = path.join(p.dir, 'pc.json');
  fs.writeFileSync(pc, JSON.stringify({ rawText: 'Do the CLI thing.', files: ['src/x.js'] }));
  const script = path.join(__dirname, 'hub-add-piece.js');
  const ok = spawnSync('node', [script, p.hubId, '--pipeline-dir', p.dir, '--title', 'Via the CLI', '--prompt-context-file', pc, '--who', 'cli', '--reason', 'test'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  const out = JSON.parse(ok.stdout.trim().split('\n').at(-1));
  assert.equal(out.ok, true);
  assert.equal(out.total, 4);
  const bad = spawnSync('node', [script, 'missing-hub', '--pipeline-dir', p.dir, '--title', 'x', '--prompt-context-file', pc], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(JSON.parse(bad.stdout.trim().split('\n').at(-1)).error, /no coordinating hub/);
});
