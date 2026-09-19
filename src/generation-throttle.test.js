'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { liveLaneCount, generationThrottled } = require('./generation-throttle.js');

function makeInstances(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-throttle-'));
  for (const [id, pid] of entries) {
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ instanceId: id, pid }));
  }
  return dir;
}

test('two live GPU lanes: one in-flight task does not throttle, two do', () => {
  const dir = makeInstances([['worker-3090', process.pid], ['worker-p40', process.pid], ['reviewer', process.pid]]);
  assert.equal(liveLaneCount(dir), 2, 'only worker-* heartbeats count as lanes');
  assert.equal(generationThrottled(0, dir), false);
  assert.equal(generationThrottled(1, dir), false);
  assert.equal(generationThrottled(2, dir), true);
});

test('dead-pid heartbeats are not counted as lanes', () => {
  const dir = makeInstances([['worker-3090', process.pid], ['worker-p40', 2 ** 22 + 12345]]);
  assert.equal(liveLaneCount(dir), 1);
  assert.equal(generationThrottled(1, dir), true);
});

test('missing instances dir falls back to one slot', () => {
  const missing = path.join(os.tmpdir(), 'gen-throttle-nonexistent-dir');
  assert.equal(liveLaneCount(missing), 1);
  assert.equal(generationThrottled(1, missing), true);
  assert.equal(generationThrottled(0, missing), false);
});

const { makeSourceThrottle } = require('./generation-throttle.js');

test('makeSourceThrottle: a source is blocked only by in-flight work at least as important as itself', () => {
  // two lanes; two derived_task-class tasks (41) already in flight
  const throttled = makeSourceThrottle({ inFlightPriorities: [41, 41], laneCount: 2 });
  assert.equal(throttled(30), false, 'arch_discovery (30) outranks both -- not starved by lower-priority queued work');
  assert.equal(throttled(41), true, 'a peer of the queued work is still blocked');
  assert.equal(throttled(70), true, 'brain_dump_sort (70) is behind them, still blocked');
});

test('makeSourceThrottle: still bounded -- laneCount tasks at-or-above a source block it', () => {
  const throttled = makeSourceThrottle({ inFlightPriorities: [30, 30, 41], laneCount: 2 });
  assert.equal(throttled(30), true, 'two arch-class tasks already in flight fill the priority-30 band');
  assert.equal(throttled(25), false, 'something more important than both is still allowed');
});

test('makeSourceThrottle: Infinity (unresolvable) tasks never block; a premium (-Infinity) task blocks everyone it outranks', () => {
  assert.equal(makeSourceThrottle({ inFlightPriorities: [Infinity, Infinity], laneCount: 2 })(50), false);
  assert.equal(makeSourceThrottle({ inFlightPriorities: [-Infinity, -Infinity], laneCount: 2 })(5), true);
  assert.equal(makeSourceThrottle({ inFlightPriorities: [], laneCount: 2 })(999), false);
  assert.equal(makeSourceThrottle({ inFlightPriorities: [10], laneCount: 1 })(undefined), true, 'a null-priority source is treated as worst');
});
