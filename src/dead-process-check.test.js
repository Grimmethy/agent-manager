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

// Regression, 2026-08-23: caught live -- local-client.js's majorityVote() fix (a single
// vote's hard failure no longer aborts the whole review) raised the reviewer's real
// worst-case single-review duration to ~1440s (3 votes * up to 2 attempts each * 240s
// ceiling), which the OLD 1200s WORKER_ZOMBIE_THRESHOLD_SECONDS would have started
// SIGKILL-ing mid-legitimate-retry -- the exact same failure mode this file's own header
// comment documents happening to draft's worst case in 2026-08-16 before that value was
// last raised. A reviewer instance whose pid is alive and stuck on the SAME task for
// 1440s must NOT be flagged as a zombie.
test('a reviewer stuck "working" the SAME task for review\'s real worst-case duration (~1440s, 6 sequential majorityVote attempts) is NOT flagged as a zombie', () => {
  const dir = tempInstancesDir();
  const stuckTime = new Date(Date.now() - 1440_000).toISOString(); // 24 min -- review's real worst case
  writeHeartbeat(dir, 'reviewer', { status: 'working', currentTaskId: 'some-task', lastHeartbeat: stuckTime, stateSince: stuckTime });
  const cooldownPath = path.join(dir, '.watchdog-restart-cooldown.json');

  const actions = deadProcessCheck({ instancesDir: dir, cooldownPath, now: Date.now() });
  assert.deepEqual(actions, [], 'still comfortably within the real worst-case chain -- must not be treated as a hung/zombie process');
});

test('a healthy, recently-updated worker heartbeat produces no action', () => {
  const dir = tempInstancesDir();
  writeHeartbeat(dir, 'reviewer');
  const cooldownPath = path.join(dir, '.watchdog-restart-cooldown.json');

  const actions = deadProcessCheck({ instancesDir: dir, cooldownPath, now: Date.now() });
  assert.deepEqual(actions, []);
});

// --- findOrphanedModelCallProcesses (2026-08-24, pipeline hardening: "that going
// looking needs to be an automated process") ---------------------------------------------
const { findOrphanedModelCallProcesses } = require('./dead-process-check.js');

test('flags a local-draft.js process reparented to pid 1 as an orphan', () => {
  const listProcesses = () => [
    { pid: 100, ppid: 1, cmd: 'node /repo/src/local-draft.js /repo/queue/drafting/worker-1/some-task.json' },
  ];
  const orphans = findOrphanedModelCallProcesses({ listProcesses });
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].pid, 100);
});

test('does not flag a local-draft.js process whose parent is a real, live daemon (ppid != 1)', () => {
  const listProcesses = () => [
    { pid: 100, ppid: 555, cmd: 'node /repo/src/local-draft.js /repo/queue/drafting/worker-1/some-task.json' },
  ];
  const orphans = findOrphanedModelCallProcesses({ listProcesses });
  assert.deepEqual(orphans, []);
});

test('does not flag an unrelated process reparented to pid 1 -- only local-draft.js matters', () => {
  const listProcesses = () => [
    { pid: 100, ppid: 1, cmd: 'node /repo/src/dead-process-check.js' },
    { pid: 101, ppid: 1, cmd: 'sshd: some-unrelated-daemon' },
  ];
  const orphans = findOrphanedModelCallProcesses({ listProcesses });
  assert.deepEqual(orphans, []);
});

test('returns an empty list (never throws) when `ps` itself fails', () => {
  const listProcesses = () => { throw new Error('ps: command not found'); };
  assert.doesNotThrow(() => findOrphanedModelCallProcesses({ listProcesses }));
  assert.deepEqual(findOrphanedModelCallProcesses({ listProcesses }), []);
});

test('flags multiple real orphans in one pass', () => {
  const listProcesses = () => [
    { pid: 100, ppid: 1, cmd: 'node /repo/src/local-draft.js /repo/queue/drafting/worker-1/a.json' },
    { pid: 200, ppid: 999, cmd: 'node /repo/src/local-draft.js /repo/queue/drafting/worker-reasoning/b.json' },
    { pid: 300, ppid: 1, cmd: 'node /repo/src/local-draft.js /repo/queue/drafting/worker-1/c.json' },
  ];
  const orphans = findOrphanedModelCallProcesses({ listProcesses });
  assert.deepEqual(orphans.map((o) => o.pid), [100, 300]);
});
