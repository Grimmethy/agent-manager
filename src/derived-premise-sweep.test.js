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
