'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { deadProcessCheck, restartTargetFor } = require('./dead-process-check.js');

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

// restartTargetFor's P40 env (2026-09-07, Grimmethy: "the p40 has 2 tasks running on it
// and the gtx is idle" -- root-caused live: a watchdog-restarted worker-p40 process was
// found actually running with LOCAL_MODEL=qwen3.8:27b-q4_K_M, the HOST's model, because
// this restart path never carried launch.sh's own OLLAMA_URL/LOCAL_MODEL wrapping for
// this lane). Mutates/restores process.env directly (not a mocked getter) since
// restartTargetFor reads it the same simple way production code does.

test('restartTargetFor: worker-p40 carries the P40 env when both AGENT_MANAGER_P40_* vars are set', () => {
  const prevUrl = process.env.AGENT_MANAGER_P40_OLLAMA_URL;
  const prevModel = process.env.AGENT_MANAGER_P40_MODEL;
  process.env.AGENT_MANAGER_P40_OLLAMA_URL = 'http://192.168.122.29:11434';
  process.env.AGENT_MANAGER_P40_MODEL = 'qwen3.8-p40:27b-q4_K_M';
  try {
    const target = restartTargetFor('worker-p40');
    assert.deepEqual(target.env, {
      OLLAMA_URL: 'http://192.168.122.29:11434',
      LOCAL_MODEL: 'qwen3.8-p40:27b-q4_K_M',
      AGENT_MANAGER_GPU_YIELD_APPS: '',
    });
  } finally {
    if (prevUrl === undefined) delete process.env.AGENT_MANAGER_P40_OLLAMA_URL; else process.env.AGENT_MANAGER_P40_OLLAMA_URL = prevUrl;
    if (prevModel === undefined) delete process.env.AGENT_MANAGER_P40_MODEL; else process.env.AGENT_MANAGER_P40_MODEL = prevModel;
  }
});

test('restartTargetFor: worker-reasoning-p40 gets the same P40 env treatment as worker-p40', () => {
  const prevUrl = process.env.AGENT_MANAGER_P40_OLLAMA_URL;
  const prevModel = process.env.AGENT_MANAGER_P40_MODEL;
  process.env.AGENT_MANAGER_P40_OLLAMA_URL = 'http://192.168.122.29:11434';
  process.env.AGENT_MANAGER_P40_MODEL = 'qwen3.8-p40:27b-q4_K_M';
  try {
    const target = restartTargetFor('worker-reasoning-p40');
    assert.equal(target.env.LOCAL_MODEL, 'qwen3.8-p40:27b-q4_K_M');
  } finally {
    if (prevUrl === undefined) delete process.env.AGENT_MANAGER_P40_OLLAMA_URL; else process.env.AGENT_MANAGER_P40_OLLAMA_URL = prevUrl;
    if (prevModel === undefined) delete process.env.AGENT_MANAGER_P40_MODEL; else process.env.AGENT_MANAGER_P40_MODEL = prevModel;
  }
});

// 2026-09-07 follow-up (Grimmethy: "let's disable the p40 until I can get a fan on it"
// -- the card was found thermally throttling, see agent-manager.env's own comment on the
// incident): when the P40 env is not configured at all, restartTargetFor now refuses to
// restart worker-p40/worker-reasoning-p40 entirely (returns null, same as an
// unrecognized instanceId) rather than the earlier behavior of still restarting it
// WITHOUT the P40 env -- that earlier behavior was itself the original bug this file's
// other tests cover (silently falling back to the host GPU); simply omitting the env
// still let a "disabled" P40 lane get resurrected onto the wrong GPU the moment its
// heartbeat went stale.
test('restartTargetFor: refuses to restart worker-p40 at all when the P40 vars are not configured (deliberately disabled)', () => {
  const prevUrl = process.env.AGENT_MANAGER_P40_OLLAMA_URL;
  const prevModel = process.env.AGENT_MANAGER_P40_MODEL;
  delete process.env.AGENT_MANAGER_P40_OLLAMA_URL;
  delete process.env.AGENT_MANAGER_P40_MODEL;
  try {
    assert.equal(restartTargetFor('worker-p40'), null);
    assert.equal(restartTargetFor('worker-reasoning-p40'), null);
  } finally {
    if (prevUrl !== undefined) process.env.AGENT_MANAGER_P40_OLLAMA_URL = prevUrl;
    if (prevModel !== undefined) process.env.AGENT_MANAGER_P40_MODEL = prevModel;
  }
});

test('restartTargetFor: refuses to restart worker-p40 when only ONE of the two P40 vars is set (partial config, same as unconfigured)', () => {
  const prevUrl = process.env.AGENT_MANAGER_P40_OLLAMA_URL;
  const prevModel = process.env.AGENT_MANAGER_P40_MODEL;
  process.env.AGENT_MANAGER_P40_OLLAMA_URL = 'http://192.168.122.29:11434';
  delete process.env.AGENT_MANAGER_P40_MODEL;
  try {
    assert.equal(restartTargetFor('worker-p40'), null);
  } finally {
    if (prevUrl === undefined) delete process.env.AGENT_MANAGER_P40_OLLAMA_URL; else process.env.AGENT_MANAGER_P40_OLLAMA_URL = prevUrl;
    if (prevModel !== undefined) process.env.AGENT_MANAGER_P40_MODEL = prevModel;
  }
});

test('restartTargetFor: an ordinary worker (worker-1, worker-reasoning) never carries a P40 env, even when the P40 vars happen to be set', () => {
  const prevUrl = process.env.AGENT_MANAGER_P40_OLLAMA_URL;
  const prevModel = process.env.AGENT_MANAGER_P40_MODEL;
  process.env.AGENT_MANAGER_P40_OLLAMA_URL = 'http://192.168.122.29:11434';
  process.env.AGENT_MANAGER_P40_MODEL = 'qwen3.8-p40:27b-q4_K_M';
  try {
    assert.equal('env' in restartTargetFor('worker-1'), false);
    assert.equal('env' in restartTargetFor('worker-reasoning'), false);
    assert.equal('env' in restartTargetFor('reviewer'), false);
  } finally {
    if (prevUrl === undefined) delete process.env.AGENT_MANAGER_P40_OLLAMA_URL; else process.env.AGENT_MANAGER_P40_OLLAMA_URL = prevUrl;
    if (prevModel === undefined) delete process.env.AGENT_MANAGER_P40_MODEL; else process.env.AGENT_MANAGER_P40_MODEL = prevModel;
  }
});

test('deadProcessCheck: a dead worker-p40\'s emitted restart action includes the P40 env end-to-end', () => {
  const prevUrl = process.env.AGENT_MANAGER_P40_OLLAMA_URL;
  const prevModel = process.env.AGENT_MANAGER_P40_MODEL;
  process.env.AGENT_MANAGER_P40_OLLAMA_URL = 'http://192.168.122.29:11434';
  process.env.AGENT_MANAGER_P40_MODEL = 'qwen3.8-p40:27b-q4_K_M';
  try {
    const dir = tempInstancesDir();
    const staleTime = new Date(Date.now() - 400_000).toISOString();
    writeHeartbeat(dir, 'worker-p40', { pid: 999999, lastHeartbeat: staleTime });
    const cooldownPath = path.join(dir, '.watchdog-restart-cooldown.json');

    const actions = deadProcessCheck({ instancesDir: dir, cooldownPath, now: Date.now() });
    assert.equal(actions.length, 1);
    assert.equal(actions[0].instanceId, 'worker-p40');
    assert.deepEqual(actions[0].env, {
      OLLAMA_URL: 'http://192.168.122.29:11434',
      LOCAL_MODEL: 'qwen3.8-p40:27b-q4_K_M',
      AGENT_MANAGER_GPU_YIELD_APPS: '',
    });
  } finally {
    if (prevUrl === undefined) delete process.env.AGENT_MANAGER_P40_OLLAMA_URL; else process.env.AGENT_MANAGER_P40_OLLAMA_URL = prevUrl;
    if (prevModel === undefined) delete process.env.AGENT_MANAGER_P40_MODEL; else process.env.AGENT_MANAGER_P40_MODEL = prevModel;
  }
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

// 2026-09-11, root-caused live ("p40 is entirely blocked by ollama timeouts"): paired
// with local-client.js's P40_PER_CALL_TIMEOUT_CEILING_MS (900s) -- draft's 4-call chain
// at 900s/call is 3600s worst case for the P40 lane specifically, well past the general
// 1680s threshold. Same failure mode this file's own header documents for the 240s/1200s
// case: raising a lane's per-call ceiling without raising its zombie threshold in
// lockstep means the watchdog SIGKILLs a legitimately still-generating worker mid-call.
test('a worker-p40 stuck "working" the SAME task for the P40 lane\'s real worst-case duration (~3600s, 4 sequential 900s calls) is NOT flagged as a zombie', () => {
  const dir = tempInstancesDir();
  const stuckTime = new Date(Date.now() - 3600_000).toISOString(); // 60 min -- the P40 lane's real worst case
  writeHeartbeat(dir, 'worker-p40', { status: 'working', currentTaskId: 'some-task', lastHeartbeat: stuckTime, stateSince: stuckTime });
  const cooldownPath = path.join(dir, '.watchdog-restart-cooldown.json');

  const actions = deadProcessCheck({ instancesDir: dir, cooldownPath, now: Date.now() });
  assert.deepEqual(actions, [], 'still within the P40 lane\'s real worst-case chain -- must not be treated as a hung/zombie process');
});

test('a worker-reasoning-p40 past the P40 lane\'s scaled threshold (3840s) IS flagged as a zombie -- the exception is not unlimited', () => {
  const prevUrl = process.env.AGENT_MANAGER_P40_OLLAMA_URL;
  const prevModel = process.env.AGENT_MANAGER_P40_MODEL;
  process.env.AGENT_MANAGER_P40_OLLAMA_URL = 'http://192.168.122.29:11434';
  process.env.AGENT_MANAGER_P40_MODEL = 'qwen3.8-p40:27b-q4_K_M';
  try {
    const dir = tempInstancesDir();
    const staleTime = new Date(Date.now() - 3900_000).toISOString(); // past 3840s
    writeHeartbeat(dir, 'worker-reasoning-p40', { status: 'working', currentTaskId: 'some-task', lastHeartbeat: staleTime, stateSince: staleTime, pid: process.pid });
    const cooldownPath = path.join(dir, '.watchdog-restart-cooldown.json');

    const actions = deadProcessCheck({ instancesDir: dir, cooldownPath, now: Date.now() });
    assert.equal(actions.length, 1);
    assert.equal(actions[0].instanceId, 'worker-reasoning-p40');
    assert.equal(actions[0].action, 'restart-after-kill');
  } finally {
    if (prevUrl === undefined) delete process.env.AGENT_MANAGER_P40_OLLAMA_URL; else process.env.AGENT_MANAGER_P40_OLLAMA_URL = prevUrl;
    if (prevModel === undefined) delete process.env.AGENT_MANAGER_P40_MODEL; else process.env.AGENT_MANAGER_P40_MODEL = prevModel;
  }
});

// A non-P40 worker at the SAME 3600s age it takes to clear the P40's own longer threshold
// must still be flagged -- confirms the exception is scoped to the two P40 instanceIds,
// not a global change to WORKER_ZOMBIE_THRESHOLD_SECONDS.
test('a worker-1 stuck for the P40 lane\'s worst-case duration (3600s) IS still flagged as a zombie -- the exception does not leak to other lanes', () => {
  const dir = tempInstancesDir();
  const stuckTime = new Date(Date.now() - 3600_000).toISOString();
  writeHeartbeat(dir, 'worker-1', { status: 'working', currentTaskId: 'some-task', lastHeartbeat: stuckTime, stateSince: stuckTime, pid: process.pid });
  const cooldownPath = path.join(dir, '.watchdog-restart-cooldown.json');

  const actions = deadProcessCheck({ instancesDir: dir, cooldownPath, now: Date.now() });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].instanceId, 'worker-1');
  assert.equal(actions[0].action, 'restart-after-kill');
});

test('a healthy, recently-updated worker heartbeat produces no action', () => {
  const dir = tempInstancesDir();
  writeHeartbeat(dir, 'reviewer');
  const cooldownPath = path.join(dir, '.watchdog-restart-cooldown.json');

  const actions = deadProcessCheck({ instancesDir: dir, cooldownPath, now: Date.now() });
  assert.deepEqual(actions, []);
});

// --- findOrphanedModelCallProcesses (2026-08-24, pipeline hardening: "that going
// looking needs to be an automated process"; CORRECTED 2026-08-26 after an 8.5-hour
// live incident -- see dead-process-check.js's own comment on this function. The old
// `ppid === 1` heuristic never fired once during that whole incident: this box runs
// under a `systemd --user` session, which acts as its own subreaper, so orphans land on
// some session-scope process instead of true init -- confirmed live via `ps -ejH`, every
// stuck child's ppid was a non-1, itself-since-dead reaper pid. The fix cross-references
// against currently-tracked worker heartbeat pids instead of assuming any specific
// numeric ppid -- these tests now exercise THAT contract.) ------------------------------
const { findOrphanedModelCallProcesses } = require('./dead-process-check.js');

test('flags a local-draft.js process whose ppid matches no currently-live worker heartbeat (e.g. reparented to pid 1)', () => {
  const dir = tempInstancesDir();
  writeHeartbeat(dir, 'worker-1', { pid: 555 }); // the REAL, current worker-1 -- a different pid than the orphan's ppid below.
  const listProcesses = () => [
    { pid: 100, ppid: 1, cmd: 'node /repo/src/local-draft.js /repo/queue/drafting/worker-1/some-task.json' },
  ];
  const orphans = findOrphanedModelCallProcesses({ listProcesses, instancesDir: dir });
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].pid, 100);
});

// Regression, 2026-08-26: the exact live-incident shape -- a stuck child's ppid was
// NEITHER 1 nor the current worker's real pid (it was a now-dead intermediate reaper).
// The old ppid===1 check would have missed this entirely.
test('flags a local-draft.js process whose ppid is a non-1, non-worker pid (reparented to a now-dead session reaper, not init)', () => {
  const dir = tempInstancesDir();
  writeHeartbeat(dir, 'worker-1', { pid: 555 });
  const listProcesses = () => [
    { pid: 100, ppid: 902699, cmd: 'node /repo/src/local-draft.js /repo/queue/drafting/worker-1/some-task.json' },
  ];
  const orphans = findOrphanedModelCallProcesses({ listProcesses, instancesDir: dir });
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].pid, 100);
});

test('does not flag a local-draft.js process whose parent IS the currently-live worker recorded in its own heartbeat', () => {
  const dir = tempInstancesDir();
  writeHeartbeat(dir, 'worker-1', { pid: 555 });
  const listProcesses = () => [
    { pid: 100, ppid: 555, cmd: 'node /repo/src/local-draft.js /repo/queue/drafting/worker-1/some-task.json' },
  ];
  const orphans = findOrphanedModelCallProcesses({ listProcesses, instancesDir: dir });
  assert.deepEqual(orphans, []);
});

// Regression, 2026-08-26 (same day, second incident): the fix above was ITSELF broken --
// it only checked the IMMEDIATE ppid, but a worker invokes local-draft.js via bash
// `$(...)` command substitution, which always forks an intermediate subshell. The node
// process's real ppid is that ephemeral subshell's pid, never the worker's own heartbeat
// pid -- so the direct-parent check flagged every legitimate in-flight call as an orphan
// and got it killed mid-run. Confirmed live on this exact box. Fix: walk the whole
// ancestor chain, not just the immediate parent.
test('does not flag a local-draft.js process reached through an intermediate command-substitution subshell', () => {
  const dir = tempInstancesDir();
  writeHeartbeat(dir, 'worker-1', { pid: 555 });
  const listProcesses = () => [
    { pid: 555, ppid: 1, cmd: 'bash local-worker.sh worker-1' },
    { pid: 700, ppid: 555, cmd: 'bash -c node /repo/src/local-draft.js ...' }, // the subshell $(...) forks
    { pid: 100, ppid: 700, cmd: 'node /repo/src/local-draft.js /repo/queue/drafting/worker-1/some-task.json' },
  ];
  const orphans = findOrphanedModelCallProcesses({ listProcesses, instancesDir: dir });
  assert.deepEqual(orphans, []);
});

// Regression, 2026-08-26 (third pass, same day): src/heartbeat.js's writeHeartbeatFile,
// called from INSIDE local-draft.js during its own plan/implement passes, overwrites the
// heartbeat's pid field with the CHILD's own process.pid (for queued/working status), not
// the daemon's -- so for most of a real call's life the "live worker pid" IS the exact
// process being checked, not an ancestor of it. Confirmed live: instances/worker-
// reasoning.json's recorded pid matched the running local-draft.js process's own pid
// exactly, sampled repeatedly while a draft call was actively in progress.
test('does not flag a local-draft.js process whose OWN pid is the live worker heartbeat pid (heartbeat.js self-write during an active call)', () => {
  const dir = tempInstancesDir();
  writeHeartbeat(dir, 'worker-reasoning', { pid: 100 }); // heartbeat.js overwrote this to the child's own pid mid-call.
  const listProcesses = () => [
    { pid: 555, ppid: 1, cmd: 'bash local-worker.sh worker-reasoning' },
    { pid: 700, ppid: 555, cmd: 'bash local-worker.sh worker-reasoning' }, // command-substitution subshell, still showing the parent's own argv pre-exec.
    { pid: 100, ppid: 700, cmd: 'node /repo/src/local-draft.js /repo/queue/drafting/worker-reasoning/some-task.json' },
  ];
  const orphans = findOrphanedModelCallProcesses({ listProcesses, instancesDir: dir });
  assert.deepEqual(orphans, []);
});

test('still flags a genuine orphan reached through a dead intermediate process (chain never reaches a live worker)', () => {
  const dir = tempInstancesDir();
  writeHeartbeat(dir, 'worker-1', { pid: 555 });
  const listProcesses = () => [
    { pid: 902699, ppid: 1, cmd: 'session-scope-manager' }, // the now-dead reaper, still present this ps snapshot
    { pid: 100, ppid: 902699, cmd: 'node /repo/src/local-draft.js /repo/queue/drafting/worker-1/some-task.json' },
  ];
  const orphans = findOrphanedModelCallProcesses({ listProcesses, instancesDir: dir });
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].pid, 100);
});

test('does not flag an unrelated process with no matching worker -- only local-draft.js matters', () => {
  const dir = tempInstancesDir();
  const listProcesses = () => [
    { pid: 100, ppid: 1, cmd: 'node /repo/src/dead-process-check.js' },
    { pid: 101, ppid: 1, cmd: 'sshd: some-unrelated-daemon' },
  ];
  const orphans = findOrphanedModelCallProcesses({ listProcesses, instancesDir: dir });
  assert.deepEqual(orphans, []);
});

test('returns an empty list (never throws) when `ps` itself fails', () => {
  const dir = tempInstancesDir();
  const listProcesses = () => { throw new Error('ps: command not found'); };
  assert.doesNotThrow(() => findOrphanedModelCallProcesses({ listProcesses, instancesDir: dir }));
  assert.deepEqual(findOrphanedModelCallProcesses({ listProcesses, instancesDir: dir }), []);
});

test('returns an empty list (never throws) when instancesDir itself is unreadable', () => {
  const listProcesses = () => [
    { pid: 100, ppid: 1, cmd: 'node /repo/src/local-draft.js /repo/queue/drafting/worker-1/some-task.json' },
  ];
  assert.doesNotThrow(() => findOrphanedModelCallProcesses({ listProcesses, instancesDir: '/no/such/dir' }));
});

test('flags multiple real orphans in one pass, leaving the one real live worker child alone', () => {
  const dir = tempInstancesDir();
  writeHeartbeat(dir, 'worker-1', { pid: 555 });
  writeHeartbeat(dir, 'worker-reasoning', { pid: 777 });
  const listProcesses = () => [
    { pid: 100, ppid: 1, cmd: 'node /repo/src/local-draft.js /repo/queue/drafting/worker-1/a.json' },
    { pid: 200, ppid: 777, cmd: 'node /repo/src/local-draft.js /repo/queue/drafting/worker-reasoning/b.json' }, // legitimate -- ppid matches worker-reasoning's real, current pid.
    { pid: 300, ppid: 999, cmd: 'node /repo/src/local-draft.js /repo/queue/drafting/worker-1/c.json' },
  ];
  const orphans = findOrphanedModelCallProcesses({ listProcesses, instancesDir: dir });
  assert.deepEqual(orphans.map((o) => o.pid), [100, 300]);
});
