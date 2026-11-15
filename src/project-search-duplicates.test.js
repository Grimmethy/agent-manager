'use strict';

// project_search duplicate cleanup (the source's expiry hook). Pure tests of findDuplicateProjectSearch plus a run through the real sweepExpiry over a
// temp pipeline.
//
// Run: node --test src/project-search-duplicates.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findDuplicateProjectSearch } = require('./project-search-duplicates.js');
const { sweepExpiry } = require('./expiry-sweep.js');

const T = (id, createdAt, extra = {}) => ({ id, task: { id, source: 'project_search', createdAt, generatedForRepoRoot: '/repo/a', promptContext: { projectTag: 'a' }, history: [], ...extra } });

test('three copies for one repo: the newest stays, the two older are archived with a reason naming the kept id', () => {
  const out = findDuplicateProjectSearch({ tasks: [T('project-search-a-1', '2026-10-20T06:20:10Z'), T('project-search-a-3', '2026-10-22T06:20:10Z'), T('project-search-a-2', '2026-10-21T06:20:10Z')] });
  assert.deepEqual(out.map((x) => x.id).sort(), ['project-search-a-1', 'project-search-a-2']);
  assert.ok(out.every((x) => x.action === 'archive'));
  assert.match(out[0].reason, /superseded by project-search-a-3/);
  assert.match(out[0].reason, /duplicate queued project_search search for a/);
});

test('a single task, and no tasks, return nothing', () => {
  assert.deepEqual(findDuplicateProjectSearch({ tasks: [T('project-search-a-1', '2026-10-20T06:20:10Z')] }), []);
  assert.deepEqual(findDuplicateProjectSearch({ tasks: [] }), []);
  assert.deepEqual(findDuplicateProjectSearch({}), []);
});

test('different repo roots are never grouped: one is kept per root', () => {
  const b = (id, at) => T(id, at, { generatedForRepoRoot: '/repo/b', promptContext: { projectTag: 'b' } });
  const out = findDuplicateProjectSearch({ tasks: [T('a-old', '2026-10-20T00:00:00Z'), T('a-new', '2026-10-21T00:00:00Z'), b('b-old', '2026-10-20T00:00:00Z'), b('b-new', '2026-10-21T00:00:00Z')] });
  assert.deepEqual(out.map((x) => x.id).sort(), ['a-old', 'b-old']);
});

test('a task without a usable createdAt is never archived, and is never the kept one over a dated sibling', () => {
  const out = findDuplicateProjectSearch({ tasks: [T('dated-old', '2026-10-20T00:00:00Z'), T('dated-new', '2026-10-21T00:00:00Z'), T('undated', undefined), T('garbled', 'not a date')] });
  assert.deepEqual(out.map((x) => x.id), ['dated-old']);
  assert.deepEqual(findDuplicateProjectSearch({ tasks: [T('only-dated', '2026-10-20T00:00:00Z'), T('undated', undefined)] }), [], 'one dated task is not provably newer than the undated one');
});

test('equal createdAt keeps the greater id, deterministically in either input order', () => {
  const x = T('project-search-a-1', '2026-10-20T00:00:00Z');
  const y = T('project-search-a-2', '2026-10-20T00:00:00Z');
  assert.deepEqual(findDuplicateProjectSearch({ tasks: [x, y] }).map((i) => i.id), ['project-search-a-1']);
  assert.deepEqual(findDuplicateProjectSearch({ tasks: [y, x] }).map((i) => i.id), ['project-search-a-1']);
});

test('falls back to promptContext.projectTag when generatedForRepoRoot is absent', () => {
  const noRoot = (id, at) => T(id, at, { generatedForRepoRoot: undefined });
  const out = findDuplicateProjectSearch({ tasks: [noRoot('x-old', '2026-10-20T00:00:00Z'), noRoot('x-new', '2026-10-21T00:00:00Z')] });
  assert.deepEqual(out.map((i) => i.id), ['x-old']);
});

test('through the real sweepExpiry: the registered hook leaves the newest in pending/ and archives the rest, reversibly', () => {
  require('./task-sources.js');
  const { getRegisteredSources } = require('./task-source-registry.js');
  const source = getRegisteredSources().find((s) => s.name === 'project_search');
  assert.ok(source && source.expiry, 'project_search declares an expiry hook');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-dups-'));
  for (const d of ['pending', 'approved', path.join('done', '_archived_no_action')]) fs.mkdirSync(path.join(dir, 'queue', d), { recursive: true });
  const put = (id, createdAt, extra = {}) => fs.writeFileSync(path.join(dir, 'queue', 'pending', `${id}.json`), JSON.stringify({ id, source: 'project_search', createdAt, generatedForRepoRoot: '/repo/a', promptContext: { projectTag: 'a' }, history: [], ...extra }));
  put('project-search-a-1', '2026-10-20T00:00:00Z');
  put('project-search-a-2', '2026-10-21T00:00:00Z');
  put('project-search-a-3', '2026-10-22T00:00:00Z');
  put('project-search-a-4', '2026-10-23T00:00:00Z');
  put('manual-unrelated', '2026-10-20T00:00:00Z', { source: 'manual' });
  const summary = sweepExpiry({ pipelineDir: dir, sources: [source], force: true });
  assert.equal(summary.archived, 3);
  const pending = fs.readdirSync(path.join(dir, 'queue', 'pending')).sort();
  assert.deepEqual(pending, ['manual-unrelated.json', 'project-search-a-4.json']);
  const archived = fs.readdirSync(path.join(dir, 'queue', 'done', '_archived_no_action')).sort();
  assert.deepEqual(archived, ['project-search-a-1.json', 'project-search-a-2.json', 'project-search-a-3.json']);
  const rec = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'done', '_archived_no_action', 'project-search-a-1.json'), 'utf8'));
  assert.equal(rec.terminalDisposition, 'aged-out');
  assert.match(rec.manualArchive.reason, /superseded by project-search-a-4/);
});
