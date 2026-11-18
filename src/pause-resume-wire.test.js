'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { wirePauseResume } = require('./pause-resume-wire.js');

// Fake clock + timer + requeue log.
function fakeClock(startMs = 1_000_000) {
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

const mixed = () => [
  { id: 's1' },
  { id: 'p1', premiumPriority: true },
  { id: 's2', premiumPriority: false },
  { id: 'p2', premiumPriority: 1 },
];

test('parked tasks are requeued exactly once, premium first', () => {
  const c = fakeClock();
  wirePauseResume({
    provider: 'anthropic',
    resetsAt: new Date(c.now() + 100).toISOString(),
    parkedTasks: mixed(),
    requeue: c.requeue,
    now: c.now,
    setTimer: c.setTimer,
  });
  assert.equal(c.timers.length, 1);
  assert.equal(c.timers[0].ms, 100);
  assert.deepEqual(c.log, []);
  c.advance(100);
  c.timers[0].fn();
  c.timers[0].fn();
  assert.deepEqual(c.log, ['p1', 'p2', 's1', 's2']);
});

test('resetsAt accepted as epoch ms, Date or ISO string with the same delay', () => {
  for (const value of [
    1_000_000 + 5000,
    new Date(1_000_000 + 5000),
    new Date(1_000_000 + 5000).toISOString(),
  ]) {
    const c = fakeClock();
    wirePauseResume({
      provider: 'anthropic',
      resetsAt: value,
      parkedTasks: mixed(),
      requeue: c.requeue,
      now: c.now,
      setTimer: c.setTimer,
    });
    assert.equal(c.timers.length, 1);
    assert.equal(c.timers[0].ms, 5000);
  }
});

test('malformed resetsAt does not throw, returns null and arms nothing', () => {
  for (const bad of ['not-a-date', undefined, null, {}, NaN, true]) {
    const c = fakeClock();
    let result;
    assert.doesNotThrow(() => {
      result = wirePauseResume({
        provider: 'anthropic',
        resetsAt: bad,
        parkedTasks: mixed(),
        requeue: c.requeue,
        now: c.now,
        setTimer: c.setTimer,
      });
    });
    assert.equal(result, null);
    assert.equal(c.timers.length, 0);
    assert.deepEqual(c.log, []);
  }
});

test('missing provider returns null without arming a timer', () => {
  const c = fakeClock();
  const result = wirePauseResume({
    provider: '',
    resetsAt: c.now() + 1000,
    parkedTasks: mixed(),
    requeue: c.requeue,
    now: c.now,
    setTimer: c.setTimer,
  });
  assert.equal(result, null);
  assert.equal(c.timers.length, 0);
});

test('a throwing setTimer is swallowed and does not propagate', () => {
  const c = fakeClock();
  assert.doesNotThrow(() => wirePauseResume({
    provider: 'anthropic',
    resetsAt: c.now() + 1000,
    parkedTasks: mixed(),
    requeue: c.requeue,
    now: c.now,
    setTimer: () => { throw new Error('boom'); },
  }));
});
