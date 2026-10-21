'use strict';

// HUB0164 2/4 of 4 -- infra-attribution tests.
//
// Tests the HUB0164 1/4 module (src/infra-attribution.js): the worker's requeue gate splits a
// failing lane's output into LANE-attributable (a non-primary lane's infra-shaped/empty failure
// is the lane's fault) and TASK-attributable (primary-lane failures and non-infra content are
// the task's). These tests drive the REAL classifyInfraFailure and recordLaneFailure exports
// and SIMULATE the worker gate (scripts/local-worker.sh's requeue/block decision with
// DRAFT_INFRA_REQUEUE_LIMIT, default 3) IN-PROCESS -- no child_process, no bash shelling out.
//
// Lane-attributable path: the lane is at fault -- bump the LANE counter and leave
// task.infraRequeueCount untouched (the task is innocent).
// Task-attributable path: bump task.infraRequeueCount; at DRAFT_INFRA_REQUEUE_LIMIT (3) the
// worker's "giving up" branch runs and the task is blocked.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Stub the per-lane store BEFORE requiring the module under test: recordLaneFailure captures
// lane-health.js's exports at load time (CJS), so swapping the cached exports first is what
// lets these tests assert delegation with matching args instead of poking a real instancesDir.
const laneHealthPath = require.resolve('./lane-health.js');
const laneHealthReal = require(laneHealthPath);
const laneHealthCalls = [];
require.cache[laneHealthPath].exports = {
  readSamples: (instancesDir, laneId) => {
    laneHealthCalls.push(['readSamples', instancesDir, laneId]);
    return laneHealthReal.readSamples(instancesDir, laneId);
  },
  assess: (samples, cfg) => {
    laneHealthCalls.push(['assess', samples, cfg]);
    return laneHealthReal.assess(samples, cfg);
  },
};

const { classifyInfraFailure, recordLaneFailure } = require('./infra-attribution.js');

const PRIMARY = 'primary';
const OTHER_LANE = 'gpu-lane-2';
const INFRA_TEXT = 'draft failed: BLOCKER-TYPE: infra-error (Ollama host unreachable)';
const NON_INFRA_TEXT = 'lint failed: 3 errors in src/foo.js';
// scripts/local-worker.sh: DRAFT_INFRA_REQUEUE_LIMIT rounds (default 3).
const DRAFT_INFRA_REQUEUE_LIMIT = 3;

// In-process simulation of the worker's requeue/block gate (local-worker.sh's node -e block,
// extended with the HUB0164 lane split). Returns the action the worker would take.
function simulateWorkerGate({ failureText, laneId, task, laneCounter }) {
  const verdict = classifyInfraFailure({ failureText, laneId, primaryLaneId: PRIMARY });
  if (verdict.laneAttributable) {
    // Lane's fault: count it against the lane, not the task -- the task keeps its budget.
    laneCounter.count += 1;
    return 'requeue';
  }
  // Task's fault: consume one of the task's bounded infra-requeue rounds; at the limit the
  // worker takes its "giving up" branch (count capped, never incremented past the bound).
  task.infraRequeueCount = Math.min((task.infraRequeueCount || 0) + 1, DRAFT_INFRA_REQUEUE_LIMIT);
  return task.infraRequeueCount >= DRAFT_INFRA_REQUEUE_LIMIT ? 'block' : 'requeue';
}

test('classifyInfraFailure: lane-attributable input leaves task.infraRequeueCount unchanged and bumps the lane counter', () => {
  const task = { infraRequeueCount: 2 };
  const laneCounter = { count: 1 };
  const verdict = classifyInfraFailure({ failureText: INFRA_TEXT, laneId: OTHER_LANE, primaryLaneId: PRIMARY });
  assert.equal(verdict.laneAttributable, true, 'non-primary lane with infra-shaped text is lane-attributable');
  const action = simulateWorkerGate({ failureText: INFRA_TEXT, laneId: OTHER_LANE, task, laneCounter });
  assert.equal(action, 'requeue');
  assert.equal(task.infraRequeueCount, 2, 'task budget must be untouched for a lane-attributable failure');
  assert.equal(laneCounter.count, 2, 'lane counter must bump from 1 to 2');
});

test('classifyInfraFailure: non-attributable (primary lane) still increments and blocks at DRAFT_INFRA_REQUEUE_LIMIT', () => {
  const task = { infraRequeueCount: DRAFT_INFRA_REQUEUE_LIMIT - 1 }; // 2: one round left
  const laneCounter = { count: 0 };
  const verdict = classifyInfraFailure({ failureText: INFRA_TEXT, laneId: PRIMARY, primaryLaneId: PRIMARY });
  assert.equal(verdict.laneAttributable, false, 'primary-lane failures are never lane-attributable');
  const action = simulateWorkerGate({ failureText: INFRA_TEXT, laneId: PRIMARY, task, laneCounter });
  assert.equal(task.infraRequeueCount, DRAFT_INFRA_REQUEUE_LIMIT, 'task count increments to the limit (3)');
  assert.equal(action, 'block', 'at the limit the worker takes its "giving up" / blocked path');
  assert.equal(laneCounter.count, 0, 'lane counter stays untouched on the task-attributable path');

  // Already at the limit: blocked immediately, count does not run past the bound.
  const task2 = { infraRequeueCount: DRAFT_INFRA_REQUEUE_LIMIT };
  const action2 = simulateWorkerGate({ failureText: INFRA_TEXT, laneId: PRIMARY, task: task2, laneCounter });
  assert.equal(action2, 'block', 'an already-at-limit task is still blocked');
  assert.equal(task2.infraRequeueCount, DRAFT_INFRA_REQUEUE_LIMIT, 'no increment past the limit');
});

test('classifyInfraFailure: empty output on the primary lane is task-attributable', () => {
  for (const emptyText of ['', null, undefined, '   ']) {
    const verdict = classifyInfraFailure({ failureText: emptyText, laneId: PRIMARY, primaryLaneId: PRIMARY });
    assert.equal(verdict.laneAttributable, false, `empty output (${JSON.stringify(emptyText)}) on the primary lane is task-attributable`);
    const task = { infraRequeueCount: 0 };
    const action = simulateWorkerGate({ failureText: emptyText, laneId: PRIMARY, task, laneCounter: { count: 0 } });
    assert.equal(action, 'requeue', 'empty output on the primary lane consumes a task round (still under the limit)');
    assert.equal(task.infraRequeueCount, 1, 'empty output on the primary lane increments task.infraRequeueCount');
  }
});

test('classifyInfraFailure: non-infra text is task-attributable', () => {
  const verdict = classifyInfraFailure({ failureText: NON_INFRA_TEXT, laneId: OTHER_LANE, primaryLaneId: PRIMARY });
  assert.equal(verdict.laneAttributable, false, 'content (non-infra) failures are task-attributable even on a non-primary lane');
  const task = { infraRequeueCount: 1 };
  const action = simulateWorkerGate({ failureText: NON_INFRA_TEXT, laneId: OTHER_LANE, task, laneCounter: { count: 0 } });
  assert.equal(action, 'requeue', 'under the limit, a non-infra failure still requeues once');
  assert.equal(task.infraRequeueCount, 2, 'non-infra text increments task.infraRequeueCount');
});

test('recordLaneFailure delegates with matching args and triggers no pause/throttle side-effects', async (t) => {
  laneHealthCalls.length = 0;

  // Timer spies: any pause/throttle side-effect the module introduced would schedule one of these.
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let timerCalls = 0;
  t.after(() => {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  });
  globalThis.setTimeout = (...args) => { timerCalls += 1; throw new Error(`unexpected timer: ${String(args[0]).slice(0, 60)}`); };
  globalThis.clearTimeout = () => { timerCalls += 1; throw new Error('unexpected clearTimeout'); };

  const instancesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-attribution-test-'));
  const reason = 'lane-2 infra-shaped failure: BLOCKER-TYPE: infra-error';
  const now = 1760000000000;
  const result = recordLaneFailure(OTHER_LANE, { reason, now, instancesDir });

  const readCall = laneHealthCalls.find((c) => c[0] === 'readSamples');
  assert.ok(readCall, 'recordLaneFailure must read the lane-health store');
  assert.equal(readCall[1], instancesDir, 'readSamples delegates with the matching instancesDir');
  assert.equal(readCall[2], OTHER_LANE, 'readSamples delegates with the matching laneId');

  const assessCall = laneHealthCalls.find((c) => c[0] === 'assess');
  assert.ok(assessCall, 'recordLaneFailure must assess through the lane-health store');
  assert.equal(assessCall[1].length, 1, 'assess receives the recorded sample appended to the (empty) existing samples');
  assert.equal(assessCall[1][0].ok, false, 'the recorded sample is a fresh failed verdict');
  assert.equal(assessCall[1][0].error, reason, 'the recorded sample carries the exact reason (matching args)');
  assert.deepEqual(result, laneHealthReal.assess(assessCall[1]), 'recordLaneFailure returns the delegate assess() verdict');

  assert.equal(timerCalls, 0, 'the attribution path must not introduce any pause/throttle timer');

  fs.rmSync(instancesDir, { recursive: true, force: true });
});
