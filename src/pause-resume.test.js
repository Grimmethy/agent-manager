'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { schedulePauseResume } = require('./pause-resume.js');

function harness(startMs = 1_000_000) {
  let t = startMs;
  const timers = [];
  const log = [];
  return {
    timers,
    log,
    now: () => t,
    advance: (ms) => { t += ms; },
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    requeue: (task) => { log.push(task.id); },
  };
}

function run(h, resetsAt, parkedTasks) {
  schedulePauseResume({
    pause: { resetsAt },
    parkedTasks,
    requeue: h.requeue,
    now: h.now,
    setTimer: h.setTimer,
  });
}

const mixed = () => [
  { id: 's1' },
  { id: 'p1', premiumPriority: true },
  { id: 's2', premiumPriority: false },
  { id: 'p2', premiumPriority: 1 },
];

test('delay is resetsAt - now() and nothing requeues before the timer fires', () => {
  const h = harness();
  run(h, h.now() + 5000, mixed());
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].ms, 5000);
  assert.deepEqual(h.log, []);
});

test('past or current resetsAt gives delay 0', () => {
  const h = harness();
  run(h, h.now() - 1000, mixed());
  assert.equal(h.timers[0].ms, 0);

  const h2 = harness();
  run(h2, h2.now(), mixed());
  assert.equal(h2.timers[0].ms, 0);
});

test('on fire, premium requeues before standard, each task exactly once', () => {
  const h = harness();
  run(h, h.now() + 100, mixed());
  h.advance(100);
  h.timers[0].fn();
  assert.deepEqual(h.log, ['p1', 'p2', 's1', 's2']);
});

test('second callback invocation and clock advance do not requeue again', () => {
  const h = harness();
  run(h, h.now() + 100, mixed());
  h.advance(100);
  h.timers[0].fn();
  const after = [...h.log];
  h.advance(10_000);
  h.timers[0].fn();
  assert.deepEqual(h.log, after);
  assert.equal(h.log.length, 4);
});

test('exactly one timer is armed, and never re-armed after firing', () => {
  const h = harness();
  run(h, h.now() + 60_000, mixed());
  assert.equal(h.timers.length, 1);
  h.advance(60_000);
  h.timers[0].fn();
  h.timers[0].fn();
  assert.equal(h.timers.length, 1);
});

test('restart with a future resetsAt arms exactly one timer', () => {
  const h = harness();
  run(h, h.now() + 30_000, mixed());
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].ms, 30_000);
  assert.deepEqual(h.log, []);
});
