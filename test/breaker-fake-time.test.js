'use strict';
// Breaker tests that step fake time one interval tick at a time.
//
// A single large mock.timers.tick() fires every due interval callback in one
// synchronous burst, so promise rejection handlers cannot run between ticks the
// way they would in real time. stepTicks() advances one tick, then yields to the
// event loop with a real setImmediate so pending microtasks settle before the
// next tick. Only setInterval is faked; setImmediate and queueMicrotask stay real.

const { describe, test, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');

const INTERVAL_MS = 1000;
const LIMIT = 3;

// Minimal in-file breaker model: trips after LIMIT consecutive 404 responses.
// Any other response (success or a non-404 failure) ends the 404 run. A change of
// identity after a trip restarts the breaker in the closed state.
function createBreaker(limit) {
  return {
    limit,
    run: 0,
    tripped: false,
    identity: null,
    record(status) {
      if (this.tripped) return;
      if (status === 404) {
        this.run += 1;
        if (this.run >= this.limit) this.tripped = true;
        return;
      }
      this.run = 0;
    },
    setIdentity(id) {
      if (id === this.identity) return;
      this.identity = id;
      this.run = 0;
      this.tripped = false;
    },
  };
}

// Polls once per interval. Each probe is async, so failures surface as promise
// rejections, which are handled in a microtask after the tick.
function startPoller(breaker, statuses) {
  let i = 0;
  const probe = async () => {
    const status = i < statuses.length ? statuses[i] : 200;
    i += 1;
    if (status !== 200) {
      const err = new Error(`HTTP ${status}`);
      err.status = status;
      throw err;
    }
  };
  setInterval(() => {
    probe().then(
      () => breaker.record(200),
      (err) => breaker.record(err.status),
    );
  }, INTERVAL_MS);
  return { probesSent: () => i };
}

// Advances fake time one interval at a time, yielding to the real event loop
// after each tick so rejection handlers run before the next tick.
async function stepTicks(n, intervalMs = INTERVAL_MS) {
  for (let k = 0; k < n; k++) {
    mock.timers.tick(intervalMs);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('breaker under stepped fake time', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['setInterval'] });
  });

  afterEach(() => {
    mock.timers.reset();
  });

  test('trips at the limit, not one 404 before it', async () => {
    const breaker = createBreaker(LIMIT);
    startPoller(breaker, [404, 404, 404, 404]);
    breaker.setIdentity('endpoint-a');

    await stepTicks(1);
    assert.equal(breaker.tripped, false);
    await stepTicks(1);
    assert.equal(breaker.tripped, false);
    await stepTicks(1);
    assert.equal(breaker.tripped, true);
  });

  test('does not trip on non-404 failures, even at the same count', async () => {
    const breaker = createBreaker(LIMIT);
    startPoller(breaker, [500, 503, 500, 502, 500]);
    breaker.setIdentity('endpoint-a');

    for (let tick = 1; tick <= 5; tick++) {
      await stepTicks(1);
      assert.equal(breaker.tripped, false, `tripped on non-404 at tick ${tick}`);
    }
  });

  test('a successful response between failures resets the counter', async () => {
    const breaker = createBreaker(LIMIT);
    startPoller(breaker, [404, 404, 200, 404, 404, 404]);
    breaker.setIdentity('endpoint-a');

    await stepTicks(2);
    assert.equal(breaker.run, 2);
    await stepTicks(1);
    assert.equal(breaker.run, 0);
    await stepTicks(2);
    assert.equal(breaker.tripped, false, 'two 404s after a reset must not trip');
    await stepTicks(1);
    assert.equal(breaker.tripped, true, 'third 404 after the reset must trip');
  });

  test('restarts in the closed state on identity change after a trip', async () => {
    const breaker = createBreaker(LIMIT);
    startPoller(breaker, [404, 404, 404, 404, 404, 404]);
    breaker.setIdentity('endpoint-a');

    await stepTicks(3);
    assert.equal(breaker.tripped, true);

    breaker.setIdentity('endpoint-b');
    assert.equal(breaker.tripped, false, 'identity change must clear the trip');
    assert.equal(breaker.run, 0);

    await stepTicks(1);
    assert.equal(breaker.tripped, false);
    await stepTicks(1);
    assert.equal(breaker.tripped, false, 'run must restart from zero after identity change');
    await stepTicks(1);
    assert.equal(breaker.tripped, true);
  });
});
