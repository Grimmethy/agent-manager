'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const registry = require('../src/task-source-registry.js');

function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) {
    prev[k] = process.env[k];
    process.env[k] = vars[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

function withPipelineDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-guard-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-root-'));
  return withEnv({ AGENT_MANAGER_PIPELINE_DIR: dir, AGENT_MANAGER_REPO_ROOT: root }, () =>
    fn(path.join(dir, 'instances', 'pipeline-history.log'), root),
  );
}

function readEvents(logPath) {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('owner mismatch suppresses candidates and writes one owner-mismatch event', () => {
  registry.clearRegistry();
  withPipelineDir((logPath) => {
    registry.registerTaskSource('owned_elsewhere', {
      priority: 1,
      owners: ['/definitely/not/a/real/root'],
      next: () => ({ id: 'x' }),
    });
    const entry = registry.getRegisteredSource('owned_elsewhere');
    assert.equal(entry.next(), null);
    const events = readEvents(logPath).filter((e) => e.type === 'owner-mismatch');
    assert.equal(events.length, 1);
    assert.equal(events[0].source, 'owned_elsewhere');
    assert.equal(events[0].reason, 'owner-mismatch');
    assert.deepEqual(events[0].owners, ['/definitely/not/a/real/root']);
    assert.ok('taskId' in events[0] && 'runningRoot' in events[0]);
  });
  registry.clearRegistry();
});

test('owner matching the running root returns candidates and writes no owner-mismatch event', () => {
  registry.clearRegistry();
  withPipelineDir((logPath, root) => {
    registry.registerTaskSource('owned_here', { priority: 1, owners: [root], next: () => ({ id: 'mine' }) });
    assert.deepEqual(registry.getRegisteredSource('owned_here').next(), { id: 'mine' });
    assert.equal(readEvents(logPath).filter((e) => e.type === 'owner-mismatch').length, 0);
  });
  registry.clearRegistry();
});

test('source with no declared owners is unaffected and writes no mismatch event', () => {
  registry.clearRegistry();
  withPipelineDir((logPath) => {
    registry.registerTaskSource('unscoped', { priority: 1, next: () => ({ id: 'y' }) });
    const entry = registry.getRegisteredSource('unscoped');
    assert.deepEqual(entry.next(), { id: 'y' });
    assert.equal(readEvents(logPath).filter((e) => e.type === 'owner-mismatch').length, 0);
  });
  registry.clearRegistry();
});

test('one mismatched source does not suppress an unowned source in the same run', () => {
  registry.clearRegistry();
  withPipelineDir((logPath) => {
    registry.registerTaskSource('mismatched', {
      priority: 1,
      owners: ['/definitely/not/a/real/root'],
      next: () => ({ id: 'bad' }),
    });
    registry.registerTaskSource('free', { priority: 2, next: () => ({ id: 'good' }) });
    assert.equal(registry.getRegisteredSource('mismatched').next(), null);
    assert.deepEqual(registry.getRegisteredSource('free').next(), { id: 'good' });
    const events = readEvents(logPath).filter((e) => e.type === 'owner-mismatch');
    assert.equal(events.length, 1);
    assert.equal(events[0].source, 'mismatched');
  });
  registry.clearRegistry();
});
