'use strict';

// Unit tests for heartbeat.js -- the JS-side write_heartbeat_file equivalent used to
// restore the "queued" vs "working" distinction inside local-draft.js's own lock-wait
// (see that file's own header for the full incident).

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { writeHeartbeatFile } = require('./heartbeat.js');

function withTempInstancesDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heartbeat-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function readHb(dir, instanceId) {
  return JSON.parse(fs.readFileSync(path.join(dir, `${instanceId}.json`), 'utf8'));
}

test('writeHeartbeatFile writes the expected shape, including the real process pid', () => {
  withTempInstancesDir((dir) => {
    writeHeartbeatFile(dir, 'worker-reasoning', 'queued', 'qwen3.8:27b-q4_K_M', 'task-1', 'plan');
    const hb = readHb(dir, 'worker-reasoning');
    assert.equal(hb.instanceId, 'worker-reasoning');
    assert.equal(hb.pid, process.pid);
    assert.equal(hb.model, 'qwen3.8:27b-q4_K_M');
    assert.equal(hb.status, 'queued');
    assert.equal(hb.currentTaskId, 'task-1');
    assert.equal(hb.currentPass, 'plan');
    assert.ok(hb.lastHeartbeat);
    assert.ok(hb.stateSince);
  });
});

test('writeHeartbeatFile preserves stateSince across writes with the same status|pass|taskId|pid', () => {
  withTempInstancesDir((dir) => {
    writeHeartbeatFile(dir, 'worker-reasoning', 'working', 'm', 'task-1', 'plan');
    const first = readHb(dir, 'worker-reasoning');
    writeHeartbeatFile(dir, 'worker-reasoning', 'working', 'm', 'task-1', 'plan');
    const second = readHb(dir, 'worker-reasoning');
    assert.equal(second.stateSince, first.stateSince);
  });
});

test('writeHeartbeatFile resets stateSince when the pass changes (queued -> working transition)', () => {
  // Asserts stateSince === this write's own lastHeartbeat rather than comparing two
  // separate real-clock reads across calls -- two writes executed back to back in a unit
  // test can legitimately land in the same millisecond, which would make a cross-call
  // inequality check flaky without actually testing the real invariant (a key change
  // must NOT inherit the previous entry's stateSince, i.e. this write computed its own
  // fresh timestamp rather than copying the old one).
  withTempInstancesDir((dir) => {
    writeHeartbeatFile(dir, 'worker-reasoning', 'queued', 'm', 'task-1', 'plan');
    writeHeartbeatFile(dir, 'worker-reasoning', 'working', 'm', 'task-1', 'plan');
    const working = readHb(dir, 'worker-reasoning');
    assert.equal(working.stateSince, working.lastHeartbeat, 'a key change must produce a fresh stateSince, not an inherited one');
  });
});

test('writeHeartbeatFile carries startedAt forward from a prior write when not passed explicitly', () => {
  withTempInstancesDir((dir) => {
    writeHeartbeatFile(dir, 'worker-reasoning', 'idle', 'm', '', '', '2026-08-25T00:00:00.000Z');
    writeHeartbeatFile(dir, 'worker-reasoning', 'queued', 'm', 'task-1', 'plan');
    const hb = readHb(dir, 'worker-reasoning');
    assert.equal(hb.startedAt, '2026-08-25T00:00:00.000Z');
  });
});

// daemonPid (2026-09-07, Grimmethy: "the p40 has 2 tasks running on it and the gtx is
// idle" -- root-caused live to a real duplicate-daemon incident: check_instance_liveness
// used to trust plain `pid`, which this function overwrites with process.pid on every
// call -- once that child exits and the parent bash daemon has not yet written its own
// next "idle" heartbeat, the file showed a dead child pid, and a second daemon was
// allowed to start under the same instanceId). agent-manager-common.sh's
// write_heartbeat_file is the only ever WRITER of a fresh daemonPid value (this JS
// function never has the daemon's own pid to write); this function must only ever carry
// forward whatever value is already on disk.
test('writeHeartbeatFile carries daemonPid forward from a prior write, never sets it from its own process.pid', () => {
  withTempInstancesDir((dir) => {
    const hbPath = path.join(dir, 'worker-reasoning.json');
    fs.writeFileSync(hbPath, JSON.stringify({ instanceId: 'worker-reasoning', pid: 999999, daemonPid: 999999, status: 'idle' }));
    writeHeartbeatFile(dir, 'worker-reasoning', 'working', 'm', 'task-1', 'plan');
    const hb = readHb(dir, 'worker-reasoning');
    assert.equal(hb.daemonPid, 999999, 'daemonPid must be carried forward from the prior (daemon-written) value');
    assert.equal(hb.pid, process.pid, 'pid itself still reflects the currently-writing process, exactly as before');
    assert.notEqual(hb.daemonPid, hb.pid, 'this test only proves something if the two values actually differ');
  });
});

test('writeHeartbeatFile omits daemonPid entirely when no prior heartbeat ever set one (pre-fix file, or a fresh instance)', () => {
  withTempInstancesDir((dir) => {
    writeHeartbeatFile(dir, 'worker-reasoning', 'working', 'm', 'task-1', 'plan');
    const hb = readHb(dir, 'worker-reasoning');
    assert.equal('daemonPid' in hb, false);
  });
});

test('writeHeartbeatFile does not throw when the instances directory does not exist yet', () => {
  const dir = path.join(os.tmpdir(), `heartbeat-test-missing-${Date.now()}`);
  try {
    assert.doesNotThrow(() => writeHeartbeatFile(dir, 'worker-1', 'idle', null, '', ''));
    assert.ok(fs.existsSync(path.join(dir, 'worker-1.json')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
