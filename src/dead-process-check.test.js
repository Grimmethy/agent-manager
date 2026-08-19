'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { deadProcessCheck } = require('./dead-process-check.js');

function tempInstancesDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dead-process-check-test-'));
}

function writeHeartbeat(dir, instanceId, overrides = {}) {
  const hb = {
    instanceId, pid: process.pid, model: 'ornith:35b', status: 'idle',
    currentTaskId: null, currentPass: null, lastHeartbeat: new Date().toISOString(), stateSince: new Date().toISOString(),
    ...overrides,
  };
  fs.writeFileSync(path.join(dir, `${instanceId}.json`), JSON.stringify(hb));
}

test('a dot-prefixed state file (.active-local-model.json shape) is never mistaken for a dead worker', () => {
  const dir = tempInstancesDir();
  // Real, healthy heartbeat for worker-reasoning.
  writeHeartbeat(dir, 'worker-reasoning');
  // The model-swap-guard's own state file: has `instanceId` matching a real worker, but no
  // lastHeartbeat/pid -- exactly the shape that used to produce a NaN age and a false
  // "process confirmed gone" verdict.
  fs.writeFileSync(path.join(dir, '.active-local-model.json'), JSON.stringify({
    instanceId: 'worker-reasoning', model: 'qwen3.8:27b-q4_K_M', tier: 'high', updatedAt: new Date().toISOString(),
  }));
  const cooldownPath = path.join(dir, '.watchdog-restart-cooldown.json');

  const actions = deadProcessCheck({ instancesDir: dir, cooldownPath, now: Date.now() });
  assert.deepEqual(actions, []);
});

test('the watchdog cooldown file itself (keyed by instanceId, no top-level instanceId field) is silently skipped, not flagged', () => {
  const dir = tempInstancesDir();
  writeHeartbeat(dir, 'worker-1');
  fs.writeFileSync(path.join(dir, '.watchdog-restart-cooldown.json'), JSON.stringify({ 'worker-1': Date.now() }));
  const cooldownPath = path.join(dir, '.watchdog-restart-cooldown.json');

  const actions = deadProcessCheck({ instancesDir: dir, cooldownPath, now: Date.now() });
  assert.deepEqual(actions, []);
});

test('a genuinely dead worker (pid gone, stale heartbeat) still produces a restart action', () => {
  const dir = tempInstancesDir();
  const longDeadPid = 999999; // astronomically unlikely to be a real live pid in the test sandbox
  const staleTime = new Date(Date.now() - 400_000).toISOString(); // > 300s STALE_HEARTBEAT_SECONDS
  writeHeartbeat(dir, 'worker-1', { pid: longDeadPid, lastHeartbeat: staleTime });
  const cooldownPath = path.join(dir, '.watchdog-restart-cooldown.json');

  const actions = deadProcessCheck({ instancesDir: dir, cooldownPath, now: Date.now() });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].instanceId, 'worker-1');
  assert.equal(actions[0].action, 'restart');
  assert.match(actions[0].reason, /process confirmed gone/);
});

test('a healthy, recently-updated worker heartbeat produces no action', () => {
  const dir = tempInstancesDir();
  writeHeartbeat(dir, 'reviewer');
  const cooldownPath = path.join(dir, '.watchdog-restart-cooldown.json');

  const actions = deadProcessCheck({ instancesDir: dir, cooldownPath, now: Date.now() });
  assert.deepEqual(actions, []);
});
