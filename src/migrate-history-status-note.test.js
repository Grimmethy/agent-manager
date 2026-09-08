'use strict';

// Unit tests for migrate-history-status-note.js -- the one-off migration that rewrites
// { status, at, note } history entries (context-trim-sweep.js / blocked-drain.js, before
// their 2026-09-08 fix) to the canonical { stage, at, detail } shape task-history.js's
// appendHistoryEvent already uses everywhere else.
//
// Run: node --test src/migrate-history-status-note.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { migrate, normalizeHistory, allTaskFiles } = require('./migrate-history-status-note.js');

function tmpPipeline() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-history-'));
  for (const s of ['pending', 'blocked', 'needs-clarification', 'coordinating', 'adhoc',
    'drafting/worker-1', 'done', 'done/_archived_no_action', 'done/_archived/2026-08']) {
    fs.mkdirSync(path.join(dir, 'queue', s), { recursive: true });
  }
  return dir;
}

function write(dir, relPath, data) {
  fs.writeFileSync(path.join(dir, 'queue', relPath), JSON.stringify(data));
}

function read(dir, relPath) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'queue', relPath), 'utf8'));
}

test('normalizeHistory rewrites a status/note entry to stage/detail', () => {
  const data = { id: 't1', history: [{ status: 'pending', at: '2026-01-01T00:00:00Z', note: 'auto-requeued' }] };
  const { changed, entriesFixed } = normalizeHistory(data);
  assert.equal(changed, true);
  assert.equal(entriesFixed, 1);
  assert.deepEqual(data.history[0], { stage: 'pending', at: '2026-01-01T00:00:00Z', detail: 'auto-requeued' });
});

test('normalizeHistory leaves an already-canonical entry completely untouched', () => {
  const data = { id: 't1', history: [{ stage: 'created', at: '2026-01-01T00:00:00Z', detail: 'x' }] };
  const before = JSON.stringify(data);
  const { changed, entriesFixed } = normalizeHistory(data);
  assert.equal(changed, false);
  assert.equal(entriesFixed, 0);
  assert.equal(JSON.stringify(data), before);
});

test('normalizeHistory is idempotent -- running it twice on the same object changes nothing the second time', () => {
  const data = { id: 't1', history: [{ status: 'pending', at: '2026-01-01T00:00:00Z', note: 'x' }] };
  normalizeHistory(data);
  const after1 = JSON.stringify(data);
  const { changed } = normalizeHistory(data);
  assert.equal(changed, false);
  assert.equal(JSON.stringify(data), after1);
});

test('normalizeHistory does not overwrite an existing detail with note, only fills a missing one', () => {
  const data = { id: 't1', history: [{ status: 'pending', at: 'x', detail: 'real detail', note: 'stale note' }] };
  normalizeHistory(data);
  assert.equal(data.history[0].detail, 'real detail');
  assert.equal(data.history[0].note, undefined);
});

test('normalizeHistory fixes only the divergent entries in a mixed history array, preserving order and other entries exactly', () => {
  const data = {
    id: 't1',
    history: [
      { stage: 'created', at: '1' },
      { status: 'pending', at: '2', note: 'auto-requeued' },
      { stage: 'draft-started', at: '3' },
    ],
  };
  const { entriesFixed } = normalizeHistory(data);
  assert.equal(entriesFixed, 1);
  assert.equal(data.history.length, 3);
  assert.equal(data.history[0].stage, 'created');
  assert.equal(data.history[1].stage, 'pending');
  assert.equal(data.history[1].detail, 'auto-requeued');
  assert.equal(data.history[2].stage, 'draft-started');
});

test('normalizeHistory handles a task with no history, or an empty history array, without throwing', () => {
  assert.deepEqual(normalizeHistory({ id: 't1' }), { changed: false, entriesFixed: 0 });
  assert.deepEqual(normalizeHistory({ id: 't1', history: [] }), { changed: false, entriesFixed: 0 });
});

test('allTaskFiles walks every real task location: every QUEUE_STATES dir, every drafting/<lane>, adhoc, and both done archive buckets', () => {
  const dir = tmpPipeline();
  write(dir, 'pending/a.json', { id: 'a' });
  write(dir, 'blocked/b.json', { id: 'b' });
  write(dir, 'needs-clarification/c.json', { id: 'c' });
  write(dir, 'coordinating/d.json', { id: 'd' });
  write(dir, 'adhoc/e.json', { id: 'e' });
  write(dir, 'drafting/worker-1/f.json', { id: 'f' });
  write(dir, 'done/g.json', { id: 'g' });
  write(dir, 'done/_archived_no_action/h.json', { id: 'h' });
  write(dir, 'done/_archived/2026-08/i.json', { id: 'i' });

  const files = allTaskFiles(dir);
  const ids = files.map((f) => path.basename(f, '.json')).sort();
  assert.deepEqual(ids, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']);
});

test('migrate: --report mode (write:false, the default) counts what would change but writes nothing to disk', () => {
  const dir = tmpPipeline();
  write(dir, 'pending/a.json', { id: 'a', history: [{ status: 'pending', at: '1', note: 'x' }] });
  const before = read(dir, 'pending/a.json');

  const summary = migrate({ pipelineDir: dir, write: false });

  assert.equal(summary.scanned, 1);
  assert.equal(summary.filesChanged, 1);
  assert.equal(summary.entriesFixed, 1);
  assert.deepEqual(read(dir, 'pending/a.json'), before, 'report mode must not touch the file on disk');
});

test('migrate: write:true actually rewrites the affected files, leaving unaffected files byte-for-byte alone', () => {
  const dir = tmpPipeline();
  write(dir, 'pending/a.json', { id: 'a', title: 'A', history: [{ status: 'pending', at: '1', note: 'x' }] });
  write(dir, 'blocked/b.json', { id: 'b', title: 'B', history: [{ stage: 'created', at: '1' }] });
  const bBefore = fs.readFileSync(path.join(dir, 'queue', 'blocked', 'b.json'), 'utf8');

  const summary = migrate({ pipelineDir: dir, write: true });

  assert.equal(summary.filesChanged, 1);
  const a = read(dir, 'pending/a.json');
  assert.equal(a.history[0].stage, 'pending');
  assert.equal(a.history[0].detail, 'x');
  assert.equal(a.title, 'A', 'every other field on the task must be preserved');
  assert.equal(fs.readFileSync(path.join(dir, 'queue', 'blocked', 'b.json'), 'utf8'), bBefore, 'a file with no divergent entries must not be rewritten at all');
});

test('migrate: running with write:true twice is a safe no-op the second time', () => {
  const dir = tmpPipeline();
  write(dir, 'pending/a.json', { id: 'a', history: [{ status: 'pending', at: '1', note: 'x' }] });

  migrate({ pipelineDir: dir, write: true });
  const afterFirst = fs.readFileSync(path.join(dir, 'queue', 'pending', 'a.json'), 'utf8');
  const summary2 = migrate({ pipelineDir: dir, write: true });

  assert.equal(summary2.filesChanged, 0);
  assert.equal(fs.readFileSync(path.join(dir, 'queue', 'pending', 'a.json'), 'utf8'), afterFirst);
});

test('migrate: an unreadable/malformed JSON file is counted as an error and does not crash the run', () => {
  const dir = tmpPipeline();
  fs.writeFileSync(path.join(dir, 'queue', 'pending', 'bad.json'), 'not json');
  write(dir, 'blocked/ok.json', { id: 'ok', history: [{ status: 'pending', at: '1', note: 'x' }] });

  const summary = migrate({ pipelineDir: dir, write: false });

  assert.equal(summary.errors, 1);
  assert.equal(summary.filesChanged, 1, 'a malformed sibling file must not block a real one from being counted');
});
