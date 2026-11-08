'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const StalledTaskWorker = require('../src/lib/stalled-task-worker.js');
const DismissalHistory = require('../src/lib/dismissal-history.ts');

test('StalledTaskWorker resolves bare filename to exact path', () => {
  const tmpDir = fs.mkdtempSync('/tmp/stalled-worker-test-');
  const srcDir = path.join(tmpDir, 'src');
  fs.mkdirSync(srcDir);
  fs.writeFileSync(path.join(srcDir, 'downloader.py'), '# downloader');

  const worker = new StalledTaskWorker({ repoRoot: tmpDir });
  const plan = 'Update the file downloader.py to add retry logic';
  const resolved = worker.processPlan(plan);

  assert.ok(resolved.includes(path.join(srcDir, 'downloader.py')),
    `Expected resolved path, got: ${resolved}`);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('StalledTaskWorker leaves ambiguous refs as-is', () => {
  const tmpDir = fs.mkdtempSync('/tmp/stalled-worker-test-');
  const srcDir = path.join(tmpDir, 'src');
  const libDir = path.join(tmpDir, 'lib');
  fs.mkdirSync(srcDir);
  fs.mkdirSync(libDir);
  fs.writeFileSync(path.join(srcDir, 'utils.ts'), '// src');
  fs.writeFileSync(path.join(libDir, 'utils.ts'), '// lib');

  const worker = new StalledTaskWorker({ repoRoot: tmpDir });
  const plan = 'Update the file utils.ts';
  const resolved = worker.processPlan(plan);

  assert.equal(resolved, plan, 'Expected no resolution for ambiguous ref');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('StalledTaskWorker does not mangle existing paths', () => {
  const tmpDir = fs.mkdtempSync('/tmp/stalled-worker-test-');
  const srcDir = path.join(tmpDir, 'src');
  fs.mkdirSync(srcDir);
  fs.writeFileSync(path.join(srcDir, 'config.js'), '// config');

  const worker = new StalledTaskWorker({ repoRoot: tmpDir });
  const plan = 'Update src/config.js to add logging';
  const resolved = worker.processPlan(plan);

  assert.ok(!resolved.includes('src//'), `Expected no double slash, got: ${resolved}`);
  assert.ok(resolved.includes('src/config.js'), 'Expected original ref preserved');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('StalledTaskWorker detects truncation and generates retry prompt', () => {
  const tmpDir = fs.mkdtempSync('/tmp/stalled-worker-test-');
  const srcDir = path.join(tmpDir, 'src');
  fs.mkdirSync(srcDir);
  fs.writeFileSync(path.join(srcDir, 'config.ts'), '// config');

  const worker = new StalledTaskWorker({ repoRoot: tmpDir });
  const plan = 'Update the file config.ts...\nUpdate the file utils.ts...';
  const history = { taskId: 'task-123' };

  const result = worker.retryPlan(plan, history);

  assert.ok(result, 'Should return retry result for truncated plan');
  assert.ok(result.prompt, 'Should have prompt');
  assert.ok(result.dismissal, 'Should have dismissal record');
  assert.ok(result.prompt.includes('config.ts'), 'Prompt should include unresolved refs');
  assert.equal(result.dismissal.taskId, 'task-123');
  assert.equal(result.dismissal.bucket, 'retry');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('StalledTaskWorker returns null for non-truncated plan', () => {
  const tmpDir = fs.mkdtempSync('/tmp/stalled-worker-test-');
  fs.writeFileSync(path.join(tmpDir, 'config.ts'), '// config');

  const worker = new StalledTaskWorker({ repoRoot: tmpDir });
  const plan = 'Update the file config.ts';
  const history = { taskId: 'task-456' };

  const result = worker.retryPlan(plan, history);

  assert.equal(result, null, 'Should return null for non-truncated plan');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('StalledTaskWorker records dismissal history for unresolved refs', () => {
  const tmpDir = fs.mkdtempSync('/tmp/stalled-worker-test-');
  fs.mkdirSync(path.join(tmpDir, 'src'));

  const dismissalHistory = new DismissalHistory();
  const worker = new StalledTaskWorker({
    repoRoot: tmpDir,
    dismissalHistory
  });

  const plan = 'Update the file config.ts...\nModify utils.ts...';
  const history = { taskId: 'task-789' };

  const result = worker.retryPlan(plan, history);

  assert.ok(result, 'Should return retry result');
  assert.equal(dismissalHistory.events.length, 1, 'Should record one dismissal');
  assert.equal(dismissalHistory.events[0].taskId, 'task-789');
  assert.ok(dismissalHistory.events[0].reason.includes('truncated'));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('StalledTaskWorker retryPlan generates prompt with unresolved references', () => {
  const tmpDir = fs.mkdtempSync('/tmp/stalled-worker-test-');
  const srcDir = path.join(tmpDir, 'src');
  fs.mkdirSync(srcDir);
  // Only one file exists, so the other ref will be unresolved
  fs.writeFileSync(path.join(srcDir, 'config.ts'), '// config');

  const worker = new StalledTaskWorker({ repoRoot: tmpDir });
  const plan = 'Update the file config.ts...\nModify utils.ts...';
  const history = { taskId: 'task-101' };

  const result = worker.retryPlan(plan, history);

  assert.ok(result, 'Should return retry result');
  assert.ok(result.prompt.includes('config.ts'), 'Prompt should list unresolved refs');
  assert.ok(result.prompt.includes('utils.ts'), 'Prompt should list unresolved refs');
  assert.ok(result.prompt.includes('Original plan:'), 'Prompt should include original plan');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('DismissalHistory records event with resolution details', () => {
  const history = new DismissalHistory();
  const event = history.record({
    taskId: 'task-truncated-123',
    bucket: 'retry',
    reason: 'Plan truncated with unresolved file references',
    timestamp: Date.now(),
    resolution: {
      unresolvedRefs: ['config.ts', 'utils.ts'],
      candidatesConsidered: {
        'config.ts': ['/repo/src/config.ts', '/repo/lib/config.ts'],
        'utils.ts': ['/repo/src/utils.ts']
      },
      action: 'retry-with-context'
    }
  });

  assert.equal(event.taskId, 'task-truncated-123');
  assert.equal(event.bucket, 'retry');
  assert.ok(event.resolution);
  assert.ok(Array.isArray(event.resolution.unresolvedRefs));
  assert.equal(event.resolution.unresolvedRefs.length, 2);
  assert.ok(event.resolution.candidatesConsidered);
  assert.equal(event.resolution.action, 'retry-with-context');
});

test('DismissalHistory.getEventsByTask filters correctly', () => {
  const history = new DismissalHistory();
  history.record({ taskId: 'task-1', bucket: 'reject', reason: 'r1', timestamp: Date.now() });
  history.record({ taskId: 'task-2', bucket: 'reject', reason: 'r2', timestamp: Date.now() });
  history.record({ taskId: 'task-1', bucket: 'retry', reason: 'r3', timestamp: Date.now() });

  const events = history.getEventsByTask('task-1');
  assert.equal(events.length, 2);
  assert.ok(events.every(e => e.taskId === 'task-1'));
});

test('DismissalHistory.getRecent returns most recent events sorted descending', () => {
  const history = new DismissalHistory();
  const now = Date.now();
  history.record({ taskId: 'task-1', bucket: 'reject', reason: 'r1', timestamp: now - 2000 });
  history.record({ taskId: 'task-2', bucket: 'reject', reason: 'r2', timestamp: now - 1000 });
  history.record({ taskId: 'task-3', bucket: 'reject', reason: 'r3', timestamp: now });

  const recent = history.getRecent('reject', 2);
  assert.equal(recent.length, 2);
  assert.ok(recent[0].timestamp >= recent[1].timestamp);
});
