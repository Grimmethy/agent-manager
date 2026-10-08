'use strict';

// derived-premise-sweep.js: retires derived_task findings that are deterministically dead, before a lane drafts them. No model.
// Run: node --test src/derived-premise-sweep.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { sweepDerivedPremise } = require('./derived-premise-sweep.js');

const NOW = Date.parse('2026-09-21T12:00:00Z');
const iso = (h) => new Date(NOW - h * 3600 * 1000).toISOString();

function pipeline() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'derived-sweep-'));
  for (const s of ['adhoc', 'pending', 'review', 'approved', 'awaiting-confirm', 'blocked', 'needs-clarification', 'coordinating', 'done/_archived_no_action', 'derived', 'drafting/worker-1']) fs.mkdirSync(path.join(dir, 'queue', s), { recursive: true });
  return dir;
}
const put = (dir, state, task) => fs.writeFileSync(path.join(dir, 'queue', state, `${task.id}.json`), JSON.stringify(task, null, 2));
const has = (dir, state, id) => fs.existsSync(path.join(dir, 'queue', state, `${id}.json`));
const readArchived = (dir, id) => JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'done', '_archived_no_action', `${id}.json`), 'utf8'));
const dt = (id, rawText, over = {}) => ({ id, source: 'derived_task', domain: 'adhoc', title: id, createdAt: iso(1), history: [{ stage: 'created', at: iso(1) }], promptContext: { rawText, brainDumpEntryId: `bd-${id}` }, ...over });
const fromRaiser = (id, taskId, over = {}) => dt(id, 'a finding about src/exists.ts', { promptContext: { rawText: 'a finding about src/exists.ts', brainDumpEntryId: `bd-${id}`, derivedFrom: { source: 'manual', taskId } }, ...over });
const present = { existsOnDisk: () => true, existsAtRef: () => false };
const absent = { existsOnDisk: () => false, existsAtRef: () => false };
const run = (dir, extra = {}) => sweepDerivedPremise({ pipelineDir: dir, repoRoot: '/r', mainBranch: 'main', now: NOW, fetch: false, ...present, ...extra });

test('CASCADE: a finding raised by an abandoned task is retired from every unworked state, and stamped with why', () => {
  const dir = pipeline();
  put(dir, 'done/_archived_no_action', { id: 'HUB0007-02', terminalDisposition: 'abandoned' });
  for (const st of ['derived', 'pending', 'adhoc', 'needs-clarification', 'blocked']) put(dir, st, fromRaiser(`spin-${st}`, 'HUB0007-02'));
  const s = run(dir);
  assert.equal(s.archived.length, 5);
  for (const st of ['derived', 'pending', 'adhoc', 'needs-clarification', 'blocked']) {
    assert.equal(has(dir, st, `spin-${st}`), false, st);
    const rec = readArchived(dir, `spin-${st}`);
    assert.equal(rec.terminalDisposition, 'abandoned');
    assert.equal(rec.autoRetired.rule, 'raised-by-abandoned-task');
    assert.equal(rec.history.at(-1).stage, 'abandoned');
    assert.match(rec.history.at(-1).detail, /auto-retired \(raised-by-abandoned-task\).*HUB0007-02/);
  }
});

test('CASCADE never touches a task a lane holds (drafting / review / approved), nor one raised by a merged or live task', () => {
  const dir = pipeline();
  put(dir, 'done/_archived_no_action', { id: 'gone', terminalDisposition: 'abandoned' });
  put(dir, 'drafting/worker-1', fromRaiser('in-flight', 'gone'));
  put(dir, 'review', fromRaiser('in-review', 'gone'));
  put(dir, 'approved', fromRaiser('approved-one', 'gone'));
  put(dir, 'derived', fromRaiser('raised-by-live', 'still-open'));
  put(dir, 'adhoc', { id: 'still-open', source: 'manual', promptContext: { rawText: 'x' } });
  const s = run(dir);
  assert.deepEqual(s.archived, []);
  for (const [st, id] of [['drafting/worker-1', 'in-flight'], ['review', 'in-review'], ['approved', 'approved-one'], ['derived', 'raised-by-live']]) assert.equal(has(dir, st, id), true, id);
});

test('AUTO-SKIP: every cited file missing -> retired; one file still present -> kept; only for unworked states', () => {
  const dir = pipeline();
  put(dir, 'derived', dt('dead', 'Problem in `src/gone.ts`'));
  put(dir, 'pending', dt('dead-pending', 'Problem in `src/gone.ts`'));
  put(dir, 'adhoc', dt('dead-adhoc', 'Problem in `src/gone.ts`'));
  put(dir, 'needs-clarification', dt('dead-nc', 'Problem in `src/gone.ts`')); // already worked: may legitimately cite gone files
  put(dir, 'derived', dt('alive', 'Problem in `src/gone.ts` and `src/here.ts`'));
  const s = run(dir, { ...absent, existsOnDisk: (p) => p === 'src/here.ts' });
  assert.deepEqual(s.archived.map((a) => a.id).sort(), ['dead', 'dead-adhoc', 'dead-pending']);
  assert.equal(readArchived(dir, 'dead').autoRetired.rule, 'all-cited-files-missing');
  assert.match(readArchived(dir, 'dead').autoRetired.detail, /src\/gone\.ts/);
  assert.equal(has(dir, 'needs-clarification', 'dead-nc'), true);
  assert.equal(has(dir, 'derived', 'alive'), true);
});

test('never retires: a human-prioritised task, a stacked task, an inert leftover origin record, or a non-derived task', () => {
  const dir = pipeline();
  put(dir, 'derived', dt('premium', 'Problem in `src/gone.ts`', { premiumPriority: true }));
  put(dir, 'derived', dt('stacked', 'Problem in `src/gone.ts`', { stacked: { branch: 'agent/x', seq: 1, total: 2 } }));
  put(dir, 'derived', dt('leftover', 'Problem in `src/gone.ts`'));
  put(dir, 'done', { id: 'leftover', source: 'derived_task' });
  put(dir, 'adhoc', { ...dt('manual-task', 'Problem in `src/gone.ts`'), source: 'manual' });
  const s = run(dir, absent);
  assert.deepEqual(s.archived, []);
  for (const [st, id] of [['derived', 'premium'], ['derived', 'stacked'], ['derived', 'leftover'], ['adhoc', 'manual-task']]) assert.equal(has(dir, st, id), true, id);
});

test('closes the source brain-dump entry with the reason, so the record stays consistent', () => {
  const dir = pipeline();
  const bdPath = path.join(dir, 'brain-dump.json');
  fs.writeFileSync(bdPath, JSON.stringify({ entries: [{ id: 'bd-dead', status: 'actioned', rawText: 'x' }] }));
  put(dir, 'derived', dt('dead', 'Problem in `src/gone.ts`'));
  run(dir, { ...absent, brainDumpPath: bdPath });
  const e = JSON.parse(fs.readFileSync(bdPath, 'utf8')).entries[0];
  assert.match(e.resolvedNote, /auto-retired before drafting \(all-cited-files-missing\)/);
  assert.ok(e.resolvedAt);
});

test('REPORTS held derived tasks; dry run and the kill switch move nothing; an existing archived copy is left alone', () => {
  const dir = pipeline();
  put(dir, 'adhoc', { id: 'hub-child', source: 'manual', createdAt: iso(3), promptContext: { rawText: 'Edit src/exists.ts' } });
  put(dir, 'derived', dt('waiting', 'a finding about src/exists.ts'));
  const s = run(dir);
  assert.deepEqual(s.held, [{ id: 'waiting', by: ['hub-child'] }]);
  assert.equal(has(dir, 'derived', 'waiting'), true, 'held tasks stay queued');

  put(dir, 'derived', dt('dead', 'Problem in `src/gone.ts`'));
  const onlyExists = { ...absent, existsOnDisk: (p) => p === 'src/exists.ts' };
  const dry = run(dir, { ...onlyExists, dryRun: true });
  assert.equal(dry.archived.length, 1); assert.equal(has(dir, 'derived', 'dead'), true, 'dry run moves nothing');
  process.env.AGENT_MANAGER_DERIVED_PREMISE_SWEEP = 'false';
  try { assert.deepEqual(run(dir, onlyExists).archived, []); } finally { delete process.env.AGENT_MANAGER_DERIVED_PREMISE_SWEEP; }
  put(dir, 'done/_archived_no_action', { id: 'dead', terminalDisposition: 'abandoned' });
  assert.deepEqual(run(dir, onlyExists).archived, [], 'an archived copy already exists: nothing is overwritten');
  assert.equal(has(dir, 'derived', 'dead'), true);
});

// ---- target-unreferenced (lib/inert-target.js), 2026-10-08 ----------------------------------------------------------------------------------------
const RS = 'TaxHarvest/backend/src/services/runStore.js';
const GENUINE = '### AC-017 · Remove unused `_patchRun`\n\nStrength: Strong\nFiles: x\n\nProblem: p';
const writeFlags = (dir, flags) => fs.writeFileSync(path.join(dir, 'queue', 'dead-code-flags.json'), JSON.stringify(flags));
const putTriage = (dir, symbol, resp = GENUINE) => put(dir, 'done', { id: `deadcode-${symbol}`, source: 'deadcode_triage', promptContext: { symbol, definedIn: RS }, implementResponse: resp });
const patchRunTask = (id = 'patchrun-1', over = {}) => dt(id, 'In `runStore.js`, `_patchRun` (lines 38-43) unconditionally deletes p.status when the run is Stopped.', { title: "`_patchRun` silently drops status changes when run is already 'Stopped'", ...over });
const inertEnv = (v) => { const prev = process.env.AGENT_MANAGER_DERIVED_INERT_TARGET; if (v === undefined) delete process.env.AGENT_MANAGER_DERIVED_INERT_TARGET; else process.env.AGENT_MANAGER_DERIVED_INERT_TARGET = v; return () => { if (prev === undefined) delete process.env.AGENT_MANAGER_DERIVED_INERT_TARGET; else process.env.AGENT_MANAGER_DERIVED_INERT_TARGET = prev; }; };
const sweep = (dir) => run(dir);

test('INERT TARGET: flagged unreferenced + a GENUINE triage verdict -> retired as target-unreferenced, with the symbol recorded', () => {
  const restore = inertEnv(undefined);
  try {
    const dir = pipeline();
    fs.mkdirSync(path.join(dir, 'queue', 'done'), { recursive: true });
    writeFlags(dir, [{ symbol: '_patchRun', definedIn: RS, callSites: [] }]);
    putTriage(dir, '_patchRun');
    put(dir, 'derived', patchRunTask());
    const s = sweep(dir);
    assert.deepEqual(s.archived, [{ id: 'patchrun-1', rule: 'target-unreferenced', from: 'derived' }]);
    assert.equal(has(dir, 'derived', 'patchrun-1'), false);
    const rec = readArchived(dir, 'patchrun-1');
    assert.equal(rec.autoRetired.rule, 'target-unreferenced');
    assert.equal(rec.autoRetired.symbol, '_patchRun');
    assert.equal(rec.autoRetired.definedIn, RS);
    assert.equal(rec.terminalDisposition, 'abandoned');
  } finally { restore(); }
});

test('INERT TARGET: flagged but NO genuine verdict -> stamped and held (derived/), not retired; a second sweep does not re-stamp', () => {
  const restore = inertEnv(undefined);
  try {
    const dir = pipeline();
    fs.mkdirSync(path.join(dir, 'queue', 'done'), { recursive: true });
    writeFlags(dir, [{ symbol: '_patchRun', definedIn: RS, callSites: [] }]);
    putTriage(dir, '_patchRun', 'FALSE POSITIVE -- loaded through a route table the search cannot see.');
    put(dir, 'derived', patchRunTask());
    const s = sweep(dir);
    assert.deepEqual(s.archived, []);
    assert.equal(s.inertHeld.length, 1);
    const rec = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'derived', 'patchrun-1.json'), 'utf8'));
    assert.equal(rec.inertTarget.symbol, '_patchRun');
    assert.equal(rec.inertTarget.held, true);
    assert.match(rec.history.at(-1).detail, /no call sites.*no GENUINE triage verdict/);
    const again = sweep(dir);
    assert.equal(again.inertHeld.length, 0, 'already stamped');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'derived', 'patchrun-1.json'), 'utf8')).history.filter((h) => h.stage === 'advisory').length, 1);
  } finally { restore(); }
});

test('INERT TARGET: a pending task is stamped but not held (a lane may already claim it); a stacked or human-queued one is left alone', () => {
  const restore = inertEnv(undefined);
  try {
    const dir = pipeline();
    writeFlags(dir, [{ symbol: '_patchRun', definedIn: RS, callSites: [] }]);
    put(dir, 'pending', patchRunTask('p-pending'));
    put(dir, 'derived', patchRunTask('p-stacked', { stacked: { branch: 'agent/x' } }));
    put(dir, 'derived', patchRunTask('p-human', { humanQueued: true }));
    const s = sweep(dir);
    assert.deepEqual(s.inertHeld.map((x) => x.id), ['p-pending']);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'pending', 'p-pending.json'), 'utf8')).inertTarget.held, false);
    assert.equal(has(dir, 'derived', 'p-stacked'), true);
    assert.equal(has(dir, 'derived', 'p-human'), true);
  } finally { restore(); }
});

test('INERT TARGET: a called symbol, a missing flags file, a corrupt flags file and mode=off change nothing', () => {
  const restore = inertEnv(undefined);
  try {
    const dir = pipeline();
    put(dir, 'derived', patchRunTask('no-flags'));
    assert.deepEqual(sweep(dir).archived, [], 'no flags file');
    fs.writeFileSync(path.join(dir, 'queue', 'dead-code-flags.json'), '{corrupt');
    assert.deepEqual(sweep(dir).archived, [], 'corrupt flags file');
    writeFlags(dir, [{ symbol: '_patchRun', definedIn: RS, callSites: [{ file: 'a.js', line: 4 }] }]);
    const s = sweep(dir);
    assert.deepEqual([s.archived, s.inertHeld], [[], []], 'the symbol has a caller');
    writeFlags(dir, [{ symbol: '_patchRun', definedIn: RS, callSites: [] }]);
    fs.mkdirSync(path.join(dir, 'queue', 'done'), { recursive: true });
    putTriage(dir, '_patchRun');
    inertEnv('off');
    const off = sweep(dir);
    assert.deepEqual([off.archived, off.inertHeld], [[], []], 'mode off');
    assert.equal(has(dir, 'derived', 'no-flags'), true);
  } finally { restore(); }
});

test('INERT TARGET: mode=hold never retires even with a genuine verdict', () => {
  const restore = inertEnv('hold');
  try {
    const dir = pipeline();
    fs.mkdirSync(path.join(dir, 'queue', 'done'), { recursive: true });
    writeFlags(dir, [{ symbol: '_patchRun', definedIn: RS, callSites: [] }]);
    putTriage(dir, '_patchRun');
    put(dir, 'derived', patchRunTask());
    const s = sweep(dir);
    assert.deepEqual(s.archived, []);
    assert.equal(s.inertHeld.length, 1);
  } finally { restore(); }
});

test('INERT TARGET re-admission: a stamped task is released and a retired one restored (once) when the scanner finds a caller', () => {
  const restore = inertEnv(undefined);
  try {
    const dir = pipeline();
    fs.mkdirSync(path.join(dir, 'queue', 'done'), { recursive: true });
    // held task whose symbol gains a caller
    put(dir, 'derived', patchRunTask('held-1', { inertTarget: { symbol: '_patchRun', definedIn: RS, at: iso(2), held: true } }));
    // retired task whose symbol gains a caller
    put(dir, 'done/_archived_no_action', patchRunTask('retired-1', { terminalDisposition: 'abandoned', autoRetired: { rule: 'target-unreferenced', detail: 'x', at: iso(3), symbol: '_patchRun', definedIn: RS } }));
    // retired for a DIFFERENT rule: never restored by this sweep
    put(dir, 'done/_archived_no_action', patchRunTask('other-rule', { terminalDisposition: 'abandoned', autoRetired: { rule: 'all-cited-files-missing', detail: 'x', at: iso(3), symbol: '_patchRun', definedIn: RS } }));
    // already restored once and retired again: never ping-pong
    put(dir, 'done/_archived_no_action', patchRunTask('already-readmitted', { terminalDisposition: 'abandoned', inertTargetReadmitted: true, autoRetired: { rule: 'target-unreferenced', detail: 'x', at: iso(3), symbol: '_patchRun', definedIn: RS } }));
    // retired, and its symbol is STILL unreferenced: stays retired
    put(dir, 'done/_archived_no_action', patchRunTask('still-dead', { terminalDisposition: 'abandoned', autoRetired: { rule: 'target-unreferenced', detail: 'x', at: iso(3), symbol: 'stillDead', definedIn: RS } }));
    writeFlags(dir, [{ symbol: '_patchRun', definedIn: RS, callSites: [{ file: 'worker.js', line: 9 }] }, { symbol: 'stillDead', definedIn: RS, callSites: [] }]);
    const s = sweep(dir);
    assert.deepEqual(s.inertReleased.map((x) => x.id), ['held-1']);
    assert.deepEqual(s.inertReadmitted, ['retired-1']);
    const held = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'derived', 'held-1.json'), 'utf8'));
    assert.equal(held.inertTarget, undefined);
    assert.equal(has(dir, 'derived', 'retired-1'), true);
    assert.equal(fs.existsSync(path.join(dir, 'queue', 'done', '_archived_no_action', 'retired-1.json')), false);
    assert.equal(fs.existsSync(path.join(dir, 'queue', 'done', '_archived_no_action', 'other-rule.json')), true, 'retired for a different rule');
    assert.equal(fs.existsSync(path.join(dir, 'queue', 'done', '_archived_no_action', 'already-readmitted.json')), true, 'restored once already');
    assert.equal(fs.existsSync(path.join(dir, 'queue', 'done', '_archived_no_action', 'still-dead.json')), true, 'its symbol still has no caller');
    assert.equal(has(dir, 'derived', 'still-dead'), false);
    const back = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'derived', 'retired-1.json'), 'utf8'));
    assert.equal(back.inertTargetReadmitted, true);
    assert.equal(back.autoRetired, undefined);
    assert.equal(back.terminalDisposition, undefined);
    assert.equal(back.history.at(-1).stage, 'readmitted');
  } finally { restore(); }
});

test('INERT TARGET: a held task is held by isHeld, within the hold cap only', () => {
  const gate = require('./derived-gate.js');
  const stamped = { id: 'h', title: 'x', createdAt: iso(1), promptContext: { rawText: 'about `runStore.js`' }, inertTarget: { symbol: '_patchRun', definedIn: RS, held: true } };
  assert.deepEqual(gate.isHeld(stamped, [], { now: NOW }), { held: true, by: ['inert-target'] });
  assert.equal(gate.isHeld({ ...stamped, createdAt: iso(48) }, [], { now: NOW }).held, false, 'past the 24h hold cap it runs anyway');
  assert.equal(gate.isHeld({ ...stamped, humanQueued: true }, [], { now: NOW }).held, false);
  assert.equal(gate.isHeld({ ...stamped, inertTarget: { ...stamped.inertTarget, held: false } }, [], { now: NOW }).held, false);
});
