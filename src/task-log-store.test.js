'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { taskLogRelPath, buildTaskLogRecord, writeTaskLogFile } = require('./task-log-store.js');

test('taskLogRelPath is a stable, predictable path from just the task id', () => {
  assert.equal(taskLogRelPath('adhoc-foo-123'), 'task-logs/adhoc-foo-123.json');
});

test('buildTaskLogRecord carries the full history array verbatim, never truncated', () => {
  const history = [
    { stage: 'created', at: '1' },
    { stage: 'blocked', at: '2', detail: 'the real reason' },
    { stage: 'requeued', at: '3', note: 'manually requeued from blocked/' },
  ];
  const rec = buildTaskLogRecord({ id: 'x', title: 'X', domain: 'adhoc', source: 'manual', createdAt: '0', history });
  assert.deepEqual(rec.history, history);
  assert.equal(rec.id, 'x');
});

test('buildTaskLogRecord includes optional richer fields only when present', () => {
  const bare = buildTaskLogRecord({ id: 'x', history: [] });
  assert.ok(!('blockedReason' in bare));
  assert.ok(!('draftAttempts' in bare));

  const rich = buildTaskLogRecord({
    id: 'y', history: [],
    blockedReason: 'because', priorRejectionFeedback: ['a'], draftAttempts: [{ attemptNo: 1 }],
    implementResponse: 'RESOLUTION: implemented\ndid the thing',
  });
  assert.equal(rich.blockedReason, 'because');
  assert.deepEqual(rich.priorRejectionFeedback, ['a']);
  assert.deepEqual(rich.draftAttempts, [{ attemptNo: 1 }]);
  assert.equal(rich.implementResponse, 'RESOLUTION: implemented\ndid the thing');
});

test('buildTaskLogRecord keeps promptContext.body (needed for the dashboard description) but drops fetchedFiles (bulky source snapshots)', () => {
  const rec = buildTaskLogRecord({
    id: 'z', history: [],
    promptContext: { body: 'Problem: ...\nSolution: ...', fetchedFiles: { 'src/x.js': 'x'.repeat(10000) } },
  });
  assert.equal(rec.promptContext.body, 'Problem: ...\nSolution: ...');
  assert.ok(!('fetchedFiles' in rec.promptContext));
});

test('writeTaskLogFile writes a real, re-readable JSON file under repoRoot/task-logs/', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'task-log-store-test-'));
  const task = { id: 'adhoc-bar-1', title: 'Bar', domain: 'adhoc', source: 'manual', createdAt: 'now', history: [{ stage: 'created', at: 'now' }] };
  const relPath = writeTaskLogFile(repoRoot, task);
  assert.equal(relPath, 'task-logs/adhoc-bar-1.json');
  const onDisk = JSON.parse(fs.readFileSync(path.join(repoRoot, relPath), 'utf8'));
  assert.equal(onDisk.id, 'adhoc-bar-1');
  assert.deepEqual(onDisk.history, task.history);
});
