'use strict';

// Unit tests for reject-retry-check.js's rejectRetryCheck() -- previously had zero test
// coverage. Written after a real live bug (2026-08-17): a task that hit the retry cap got
// its 'exhausted' history event re-appended on EVERY tick forever (nothing here ever moves
// or deletes an exhausted task out of blocked/), confirmed live via one real task that
// accumulated 20+ duplicate entries over ~12 minutes before being caught.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { rejectRetryCheck } = require('./reject-retry-check.js');

function setupDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reject-retry-test-'));
  const blockedDir = path.join(root, 'queue', 'blocked');
  const pendingDir = path.join(root, 'queue', 'pending');
  fs.mkdirSync(blockedDir, { recursive: true });
  fs.mkdirSync(pendingDir, { recursive: true });
  return { root, blockedDir, pendingDir };
}

function writeBlockedTask(blockedDir, id, extra = {}) {
  const task = { id, blockedStage: 'review', blockedReason: 'fabricated reference', history: [], ...extra };
  fs.writeFileSync(path.join(blockedDir, `${id}.json`), JSON.stringify(task, null, 2));
  return task;
}

test('rejectRetryCheck requeues a review-rejected task under the retry cap', () => {
  const { blockedDir, pendingDir } = setupDirs();
  writeBlockedTask(blockedDir, 'task-1', { ornithRejectCount: 0 });

  const summary = rejectRetryCheck({ blockedDir, pendingDir, recordModelOutcome: () => {} });

  assert.equal(summary.requeued, 1);
  assert.equal(summary.exhausted, 0);
  assert.ok(fs.existsSync(path.join(pendingDir, 'task-1.json')));
  assert.ok(!fs.existsSync(path.join(blockedDir, 'task-1.json')));
  const requeued = JSON.parse(fs.readFileSync(path.join(pendingDir, 'task-1.json'), 'utf8'));
  assert.equal(requeued.ornithRejectCount, 1);
});

test('rejectRetryCheck stamps exhausted exactly once when the retry cap is hit, not on every call', () => {
  const { blockedDir, pendingDir } = setupDirs();
  writeBlockedTask(blockedDir, 'task-1', { ornithRejectCount: 2 });

  const first = rejectRetryCheck({ blockedDir, pendingDir, recordModelOutcome: () => {} });
  assert.equal(first.exhausted, 1);
  const afterFirst = JSON.parse(fs.readFileSync(path.join(blockedDir, 'task-1.json'), 'utf8'));
  assert.equal(afterFirst.history.filter((h) => h.stage === 'exhausted').length, 1);

  // Simulate several more ticks against the same still-blocked task -- the real-world
  // scenario that produced 20+ duplicate entries before this fix.
  for (let i = 0; i < 5; i++) {
    rejectRetryCheck({ blockedDir, pendingDir, recordModelOutcome: () => {} });
  }
  const afterMany = JSON.parse(fs.readFileSync(path.join(blockedDir, 'task-1.json'), 'utf8'));
  assert.equal(afterMany.history.filter((h) => h.stage === 'exhausted').length, 1, 'must never re-append a duplicate exhausted event');
});

test('rejectRetryCheck ignores an apply-stage failure (not a review rejection)', () => {
  const { blockedDir, pendingDir } = setupDirs();
  const task = { id: 'task-1', history: [] }; // no blockedStage -- e.g. a real apply-time git failure
  fs.writeFileSync(path.join(blockedDir, 'task-1.json'), JSON.stringify(task));

  const summary = rejectRetryCheck({ blockedDir, pendingDir, recordModelOutcome: () => {} });

  assert.equal(summary.requeued, 0);
  assert.equal(summary.exhausted, 0);
  assert.ok(fs.existsSync(path.join(blockedDir, 'task-1.json')), 'must be left alone in blocked/');
});

test('rejectRetryCheck returns an all-zero summary when blockedDir does not exist', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reject-retry-test-'));
  const summary = rejectRetryCheck({ blockedDir: path.join(root, 'nope'), pendingDir: path.join(root, 'pending') });
  assert.deepEqual(summary, { checked: 0, requeued: 0, exhausted: 0, errors: 0 });
});
