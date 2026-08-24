'use strict';

// Unit tests for apply-retry-check.js's applyRetryCheck() -- mirrors
// reject-retry-check.test.js's own coverage shape for the apply-stage sibling
// (2026-08-24, pipeline hardening: apply-failed tasks used to sit in queue/blocked/
// forever requiring a human to manually diagnose and requeue -- see that module's own
// header for the real live incident this closes).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { applyRetryCheck } = require('./apply-retry-check.js');

function setupDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-retry-test-'));
  const blockedDir = path.join(root, 'queue', 'blocked');
  const pendingDir = path.join(root, 'queue', 'pending');
  fs.mkdirSync(blockedDir, { recursive: true });
  fs.mkdirSync(pendingDir, { recursive: true });
  return { root, blockedDir, pendingDir };
}

function writeBlockedTask(blockedDir, id, extra = {}) {
  const task = { id, blockedStage: 'apply', blockedReason: 'git apply failed: patch does not apply', history: [], ...extra };
  fs.writeFileSync(path.join(blockedDir, `${id}.json`), JSON.stringify(task, null, 2));
  return task;
}

test('applyRetryCheck requeues an apply-failed task under the retry cap', () => {
  const { blockedDir, pendingDir } = setupDirs();
  writeBlockedTask(blockedDir, 'task-1', { applyRetryCount: 0 });

  const summary = applyRetryCheck({ blockedDir, pendingDir, recordModelOutcome: () => {} });

  assert.equal(summary.requeued, 1);
  assert.equal(summary.exhausted, 0);
  assert.ok(fs.existsSync(path.join(pendingDir, 'task-1.json')));
  assert.ok(!fs.existsSync(path.join(blockedDir, 'task-1.json')));
  const requeued = JSON.parse(fs.readFileSync(path.join(pendingDir, 'task-1.json'), 'utf8'));
  assert.equal(requeued.applyRetryCount, 1);
});

test('applyRetryCheck ignores a review-stage rejection -- only blockedStage==="apply" is its job', () => {
  const { blockedDir, pendingDir } = setupDirs();
  writeBlockedTask(blockedDir, 'task-1', { blockedStage: 'review', localRejectCount: 0 });

  const summary = applyRetryCheck({ blockedDir, pendingDir, recordModelOutcome: () => {} });

  assert.equal(summary.checked, 1);
  assert.equal(summary.requeued, 0);
  assert.ok(fs.existsSync(path.join(blockedDir, 'task-1.json')), 'a review rejection must be left for reject-retry-check.js, not touched here');
});

test('applyRetryCheck stamps exhausted exactly once when the retry cap is hit, not on every call', () => {
  const { blockedDir, pendingDir } = setupDirs();
  writeBlockedTask(blockedDir, 'task-1', { applyRetryCount: 2 });

  const first = applyRetryCheck({ blockedDir, pendingDir, recordModelOutcome: () => {} });
  assert.equal(first.exhausted, 1);
  const afterFirst = JSON.parse(fs.readFileSync(path.join(blockedDir, 'task-1.json'), 'utf8'));
  assert.equal(afterFirst.history.filter((h) => h.stage === 'exhausted').length, 1);

  for (let i = 0; i < 5; i++) {
    applyRetryCheck({ blockedDir, pendingDir, recordModelOutcome: () => {} });
  }
  const afterMany = JSON.parse(fs.readFileSync(path.join(blockedDir, 'task-1.json'), 'utf8'));
  assert.equal(afterMany.history.filter((h) => h.stage === 'exhausted').length, 1, 'must not re-append exhausted on every tick');
});

test('applyRetryCheck leaves a non-JSON/unreadable file alone and counts it as an error, not a crash', () => {
  const { blockedDir, pendingDir } = setupDirs();
  fs.writeFileSync(path.join(blockedDir, 'broken.json'), '{not valid json');

  const summary = applyRetryCheck({ blockedDir, pendingDir, recordModelOutcome: () => {} });

  assert.equal(summary.errors, 1);
  assert.ok(fs.existsSync(path.join(blockedDir, 'broken.json')));
});

test('applyRetryCheck returns an all-zero summary when queue/blocked/ does not exist at all', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-retry-test-'));
  const summary = applyRetryCheck({
    blockedDir: path.join(root, 'queue', 'blocked'),
    pendingDir: path.join(root, 'queue', 'pending'),
    recordModelOutcome: () => {},
  });
  assert.deepEqual(summary, { checked: 0, requeued: 0, exhausted: 0, errors: 0 });
});
