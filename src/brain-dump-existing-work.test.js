'use strict';

// Tests for brain-dump-existing-work.js: the deterministic "is this entry's work already a task?" check that
// brain_dump_sort runs before sorting an entry and again before queueing its task (2026-10-18 incident: duplicates
// of merged harness work queued from entries an operator had already carried through the pipeline).

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { findExistingWorkForEntry, linkEntryToExistingWork, taskMatchesEntry, raisedFromMatches } = require('./brain-dump-existing-work.js');

const ENTRY = { id: 'bd-1792293449127-non-assignable', serial: 1903, status: 'captured', rawText: 'x', capturedAt: '2026-10-18T03:17:29.000Z' };

function pipeline() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bd-existing-work-'));
}

function writeTask(pd, rel, task, mtime = new Date()) {
  const dir = path.join(pd, 'queue', rel);
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, `${task.id}.json`);
  fs.writeFileSync(fp, JSON.stringify(task));
  fs.utimesSync(fp, mtime, mtime);
  return fp;
}

test('raisedFromMatches: entry id or serial, with or without a trailing note; no partial-number match', () => {
  assert.equal(raisedFromMatches('brain-dump-1903', ENTRY), true);
  assert.equal(raisedFromMatches('brain-dump-1903 (re-scoped by the owner)', ENTRY), true);
  assert.equal(raisedFromMatches(`brain-dump-${ENTRY.id}`, ENTRY), true);
  assert.equal(raisedFromMatches('brain-dump-19034', ENTRY), false);
  assert.equal(raisedFromMatches('brain-dump-190', ENTRY), false);
  assert.equal(raisedFromMatches('claude-code-session-x', ENTRY), false);
  assert.equal(raisedFromMatches(undefined, ENTRY), false);
});

test('taskMatchesEntry: brainDumpEntryId, raisedFrom (top level or promptContext), queuedTaskId; never the sort task', () => {
  assert.equal(taskMatchesEntry({ id: 'a', promptContext: { brainDumpEntryId: ENTRY.id } }, ENTRY), 'brainDumpEntryId');
  assert.equal(taskMatchesEntry({ id: 'b', promptContext: { raisedFrom: 'brain-dump-1903' } }, ENTRY), 'raisedFrom');
  assert.equal(taskMatchesEntry({ id: 'c', raisedFrom: 'brain-dump-1903' }, ENTRY), 'raisedFrom');
  assert.equal(taskMatchesEntry({ id: 'd' }, { ...ENTRY, queuedTaskId: 'd' }), 'queuedTaskId');
  assert.equal(taskMatchesEntry({ id: `brain-dump-sort-${ENTRY.id}`, source: 'brain_dump_sort', domain: 'brain_dump_sort', promptContext: { brainDumpEntryId: ENTRY.id } }, ENTRY), null);
  assert.equal(taskMatchesEntry({ id: 'e', promptContext: { brainDumpEntryId: 'bd-other' } }, ENTRY), null);
});

test('findExistingWorkForEntry finds work in done/ and in done/_archived/<month>/, reports state and how', () => {
  const pd = pipeline();
  writeTask(pd, 'done', { id: 'adhoc-done-one', promptContext: { raisedFrom: 'brain-dump-1903' } });
  const r = findExistingWorkForEntry([pd], ENTRY);
  assert.deepEqual({ taskId: r.taskId, state: r.state, how: r.how }, { taskId: 'adhoc-done-one', state: 'done', how: 'raisedFrom' });

  const pd2 = pipeline();
  writeTask(pd2, path.join('done', '_archived', '2026-10'), { id: 'old-archived', promptContext: { brainDumpEntryId: ENTRY.id } });
  const r2 = findExistingWorkForEntry([pd2], ENTRY);
  assert.equal(r2.state, 'done/_archived');
  assert.equal(r2.how, 'brainDumpEntryId');

  const pd3 = pipeline();
  writeTask(pd3, path.join('drafting', 'worker-3090'), { id: 'in-flight', promptContext: { brainDumpEntryId: ENTRY.id } });
  assert.equal(findExistingWorkForEntry([pd3], ENTRY).state, 'drafting/worker-3090');
});

test('findExistingWorkForEntry ignores the sort task itself, files older than capturedAt, and unrelated tasks', () => {
  const pd = pipeline();
  writeTask(pd, 'pending', { id: `brain-dump-sort-${ENTRY.id}`, source: 'brain_dump_sort', domain: 'brain_dump_sort', promptContext: { brainDumpEntryId: ENTRY.id } });
  writeTask(pd, 'done', { id: 'unrelated', promptContext: { raisedFrom: 'brain-dump-1748' } });
  writeTask(pd, 'done', { id: 'older-than-entry', promptContext: { raisedFrom: 'brain-dump-1903' } }, new Date('2026-10-01T00:00:00Z'));
  assert.equal(findExistingWorkForEntry([pd], ENTRY), null);
  // Without a parseable capturedAt every file is read, so the old record is found.
  assert.equal(findExistingWorkForEntry([pd], { ...ENTRY, capturedAt: undefined }).taskId, 'older-than-entry');
});

test('linkEntryToExistingWork sets the actioned/queuedTaskId fields and a linkedExistingWork stamp', () => {
  const e = { ...ENTRY };
  linkEntryToExistingWork(e, { taskId: 'adhoc-done-one', state: 'done', how: 'raisedFrom' }, 'generator');
  assert.equal(e.status, 'actioned');
  assert.equal(e.queuedTaskId, 'adhoc-done-one');
  assert.ok(e.queuedAt);
  assert.equal(e.linkedExistingWork.how, 'raisedFrom');
  assert.equal(e.linkedExistingWork.by, 'generator');
});
