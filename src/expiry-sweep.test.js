'use strict';

// Tests for expiry-sweep.js -- source-agnostic retirement of queued tasks whose subject aged out while they waited
// (2026-09-24, change_review flood). Real temp queue dirs; the source's `expiry` hook is a plain fake.
//
// Run: node --test src/expiry-sweep.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sweepExpiry } = require('./expiry-sweep.js');

function setup() {
  const pipelineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'expiry-sweep-'));
  for (const d of ['pending', 'approved', path.join('done', '_archived_no_action')]) fs.mkdirSync(path.join(pipelineDir, 'queue', d), { recursive: true });
  return pipelineDir;
}
function put(pipelineDir, id, extra = {}, dir = 'pending') {
  const task = { id, source: 'fake_source', history: [], ...extra };
  fs.writeFileSync(path.join(pipelineDir, 'queue', dir, `${id}.json`), JSON.stringify(task, null, 2));
  return task;
}
const at = (pipelineDir, dir, id) => path.join(pipelineDir, 'queue', dir, `${id}.json`);
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

// A fake source: any task with `old: true` expires; one already holding an approved result is applied instead of archived.
function fakeSource(extra = {}) {
  const calls = { findExpired: [], record: [] };
  return {
    calls,
    name: 'fake_source',
    expiry: {
      idPrefixes: ['fake-'],
      findExpired: ({ tasks }) => { calls.findExpired.push(tasks.map((t) => t.id)); return tasks.filter((t) => t.task.old).map((t) => ({ id: t.id, action: t.task.hasResult ? 'apply' : 'archive', reason: 'too old' })); },
      record: ({ results }) => calls.record.push(results.map((r) => `${r.action}:${r.id}`)),
      ...extra,
    },
  };
}

test('archive: stamps terminalDisposition aged-out + manualArchive + history, moves to done/_archived_no_action/ -- and keeps fresh tasks', () => {
  const dir = setup();
  put(dir, 'fake-old', { old: true }); put(dir, 'fake-fresh', {});
  const summary = sweepExpiry({ pipelineDir: dir, sources: [fakeSource()], force: true });
  assert.equal(summary.archived, 1);
  assert.equal(fs.existsSync(at(dir, 'pending', 'fake-old')), false);
  assert.equal(fs.existsSync(at(dir, 'pending', 'fake-fresh')), true, 'a task the source did not flag stays put');
  const rec = read(at(dir, 'done/_archived_no_action', 'fake-old'));
  assert.equal(rec.terminalDisposition, 'aged-out', 'NOT abandoned -- nothing was lost');
  assert.equal(rec.manualArchive.from, 'pending');
  assert.equal(rec.manualArchive.reason, 'too old');
  assert.ok(rec.history.some((h) => h.stage === 'aged-out'));
});

test('apply: a task already holding an approved result goes to approved/, not the archive, with blocked stamps cleared', () => {
  const dir = setup();
  put(dir, 'fake-has-result', { old: true, hasResult: true, blockedStage: 'apply', blockedReason: 'dirty clone', status: 'blocked' });
  const summary = sweepExpiry({ pipelineDir: dir, sources: [fakeSource()], force: true });
  assert.equal(summary.released, 1);
  assert.equal(summary.archived, 0);
  const rec = read(at(dir, 'approved', 'fake-has-result'));
  assert.equal(rec.status, 'approved');
  assert.equal(rec.blockedStage, undefined);
  assert.equal(rec.blockedReason, undefined);
  assert.equal(rec.terminalDisposition, undefined, 'it is applied, not retired');
  assert.equal(fs.existsSync(at(dir, 'done/_archived_no_action', 'fake-has-result')), false);
});

test('only THIS source\'s tasks under its id prefixes are offered to its hook (a sibling source sharing a prefix is not)', () => {
  const dir = setup();
  put(dir, 'fake-mine', { old: true });
  put(dir, 'fake-sibling', { old: true, source: 'sibling_fix' });   // same prefix, different source
  put(dir, 'other-thing', { old: true });                            // different prefix
  const src = fakeSource();
  sweepExpiry({ pipelineDir: dir, sources: [src], force: true });
  assert.deepEqual(src.calls.findExpired, [['fake-mine']]);
  assert.equal(fs.existsSync(at(dir, 'pending', 'fake-sibling')), true);
  assert.equal(fs.existsSync(at(dir, 'pending', 'other-thing')), true);
});

test('only queue/pending/ is scanned -- a task a worker holds (drafting/) or that is in review/ is never touched', () => {
  const dir = setup();
  fs.mkdirSync(path.join(dir, 'queue', 'drafting', 'worker-3090'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'queue', 'review'), { recursive: true });
  put(dir, 'fake-claimed', { old: true }, path.join('drafting', 'worker-3090'));
  put(dir, 'fake-in-review', { old: true }, 'review');
  const summary = sweepExpiry({ pipelineDir: dir, sources: [fakeSource()], force: true });
  assert.equal(summary.checked, 0);
  assert.equal(fs.existsSync(at(dir, 'drafting/worker-3090', 'fake-claimed')), true);
  assert.equal(fs.existsSync(at(dir, 'review', 'fake-in-review')), true);
});

test('an archive copy that already exists -> the pending task is restored, not overwritten or lost', () => {
  const dir = setup();
  put(dir, 'fake-dup', { old: true });
  fs.writeFileSync(at(dir, 'done/_archived_no_action', 'fake-dup'), JSON.stringify({ id: 'fake-dup', marker: 'earlier archive' }));
  const summary = sweepExpiry({ pipelineDir: dir, sources: [fakeSource()], force: true });
  assert.equal(summary.skipped, 1);
  assert.equal(fs.existsSync(at(dir, 'pending', 'fake-dup')), true, 'restored');
  assert.equal(read(at(dir, 'done/_archived_no_action', 'fake-dup')).marker, 'earlier archive', 'the earlier archive is untouched');
  assert.equal(fs.existsSync(path.join(dir, 'queue', '.expiry-staging', 'fake-dup.json')), false, 'nothing stranded in staging');
});

test('dry run reports but moves nothing and does not call record()', () => {
  const dir = setup();
  put(dir, 'fake-old', { old: true });
  const src = fakeSource();
  const summary = sweepExpiry({ pipelineDir: dir, sources: [src], dryRun: true });
  assert.equal(summary.archived, 1);
  assert.equal(fs.existsSync(at(dir, 'pending', 'fake-old')), true);
  assert.deepEqual(src.calls.record, []);
});

test('record() is called once per source with what was actually moved', () => {
  const dir = setup();
  put(dir, 'fake-a', { old: true }); put(dir, 'fake-b', { old: true, hasResult: true }); put(dir, 'fake-c', {});
  const src = fakeSource();
  sweepExpiry({ pipelineDir: dir, sources: [src], force: true });
  assert.equal(src.calls.record.length, 1);
  assert.deepEqual(src.calls.record[0].sort(), ['apply:fake-b', 'archive:fake-a']);
});

test('throttled: a second run inside the interval does nothing; force overrides; the interval is configurable', () => {
  const dir = setup();
  put(dir, 'fake-old', { old: true });
  const t0 = new Date('2026-09-24T12:00:00Z');
  sweepExpiry({ pipelineDir: dir, sources: [fakeSource()], now: t0 });                       // first run: not throttled
  put(dir, 'fake-old2', { old: true });
  const again = sweepExpiry({ pipelineDir: dir, sources: [fakeSource()], now: new Date(t0.getTime() + 60 * 1000) });
  assert.equal(again.throttled, true);
  assert.equal(fs.existsSync(at(dir, 'pending', 'fake-old2')), true);
  const later = sweepExpiry({ pipelineDir: dir, sources: [fakeSource()], now: new Date(t0.getTime() + 31 * 60 * 1000) });
  assert.equal(later.throttled, false);
  assert.equal(later.archived, 1);
  process.env.AGENT_MANAGER_EXPIRY_SWEEP_MINUTES = '0';
  try {
    put(dir, 'fake-old3', { old: true });
    assert.equal(sweepExpiry({ pipelineDir: dir, sources: [fakeSource()], now: new Date(t0.getTime() + 32 * 60 * 1000) }).archived, 1, 'interval 0 = every run');
  } finally { delete process.env.AGENT_MANAGER_EXPIRY_SWEEP_MINUTES; }
});

test('kill switch AGENT_MANAGER_EXPIRY_SWEEP=false, a source without an expiry hook, and a throwing hook are all harmless', () => {
  const dir = setup();
  put(dir, 'fake-old', { old: true });
  process.env.AGENT_MANAGER_EXPIRY_SWEEP = 'false';
  try { assert.equal(sweepExpiry({ pipelineDir: dir, sources: [fakeSource()], force: true }).archived, 0); } finally { delete process.env.AGENT_MANAGER_EXPIRY_SWEEP; }
  assert.equal(sweepExpiry({ pipelineDir: dir, sources: [{ name: 'plain' }], force: true }).sources, 0);
  const boom = fakeSource({ findExpired: () => { throw new Error('boom'); } });
  const s = sweepExpiry({ pipelineDir: dir, sources: [boom], force: true });
  assert.equal(s.errors, 1);
  assert.equal(fs.existsSync(at(dir, 'pending', 'fake-old')), true, 'a failing hook leaves the queue alone');
});

test('an unreadable/garbage task file is skipped, not fatal', () => {
  const dir = setup();
  fs.writeFileSync(at(dir, 'pending', 'fake-garbage'), '{not json');
  put(dir, 'fake-old', { old: true });
  const s = sweepExpiry({ pipelineDir: dir, sources: [fakeSource()], force: true });
  assert.equal(s.archived, 1);
  assert.equal(fs.existsSync(at(dir, 'pending', 'fake-garbage')), true);
});

test('the aged-out disposition is a recognised terminal / no-code-coming state', () => {
  const src = fs.readFileSync(path.join(__dirname, 'task-sources.js'), 'utf8');
  assert.match(src, /NO_CODE_COMING_DISPOSITIONS = new Set\([^)]*'aged-out'/);
  assert.match(fs.readFileSync(path.join(__dirname, 'task-disposition.js'), 'utf8'), /TERMINAL_STAGES = new Set\(\[[^\]]*'aged-out'/);
  assert.match(fs.readFileSync(path.join(__dirname, 'hub-priority.js'), 'utf8'), /SIBLING_RESOLVED_STATUSES = new Set\(\[[^\]]*'aged-out'/);
});
