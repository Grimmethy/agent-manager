'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createProviderPause, jitterFor } = require('./provider-pause.js');

// Fake clock whose setTimeout fires due timers as time advances.
function fakeClock(start) {
  let t = start;
  let seq = 0;
  const timers = [];
  return {
    now: () => t,
    setTimeoutFn: (fn, delay) => { const h = { id: ++seq, fn, at: t + delay, delay, cleared: false, fired: false }; timers.push(h); return h; },
    clearTimeoutFn: (h) => { h.cleared = true; },
    advanceTo(target) {
      for (;;) {
        const due = timers.filter((h) => !h.cleared && !h.fired && h.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        t = Math.max(t, due.at);
        due.fired = true;
        due.fn();
      }
      t = target;
    },
    live: () => timers.filter((h) => !h.cleared && !h.fired),
    all: timers,
  };
}

function setup(clock, dir, extra = {}) {
  return createProviderPause({
    env: { AGENT_MANAGER_PAUSE_STATE_DIR: dir },
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    ...extra,
  });
}

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'provider-pause-'));

test('claiming for the paused provider stops until resetsAt + jitter; others keep claiming', () => {
  const clock = fakeClock(T0);
  const pp = setup(clock, tmp());
  const resetsAt = new Date(T0 + 60000).toISOString();
  pp.pause({ provider: 'claude', resetsAt, source: '429' });
  const until = T0 + 60000 + jitterFor('claude');

  assert.strictEqual(pp.claimAllowed('claude'), false);
  assert.strictEqual(pp.claimAllowed('codex'), true);
  clock.advanceTo(until - 1);
  assert.strictEqual(pp.claimAllowed('claude'), false);
  assert.strictEqual(pp.claimAllowed('codex'), true);
  clock.advanceTo(until);
  assert.strictEqual(pp.claimAllowed('claude'), true);
  assert.strictEqual(pp.claimAllowed('codex'), true);
  assert.strictEqual(pp.getPause('claude'), null);
  assert.strictEqual(clock.live().length, 0);
});

test('exactly one timer per pause; re-pausing replaces it; the callback does not re-arm', () => {
  const clock = fakeClock(T0);
  const pp = setup(clock, tmp());
  pp.pause({ provider: 'claude', resetsAt: T0 + 1000, source: 'a' });
  assert.strictEqual(clock.all.length, 1);
  pp.pause({ provider: 'claude', resetsAt: T0 + 5000, source: 'b' });
  assert.strictEqual(clock.live().length, 1);
  assert.strictEqual(pp.activeTimers(), 1);
  clock.advanceTo(T0 + 5000 + jitterFor('claude'));
  assert.strictEqual(clock.all.length, 2);
  assert.strictEqual(clock.live().length, 0);
});

test('record shape is {provider, resetsAt, source} and is persisted', () => {
  const clock = fakeClock(T0);
  const dir = tmp();
  const pp = setup(clock, dir);
  pp.pause({ provider: 'claude', resetsAt: T0 + 1000, source: 'http-429' });
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'provider-pause.json'), 'utf8'));
  assert.deepStrictEqual(onDisk.claude, { provider: 'claude', resetsAt: new Date(T0 + 1000).toISOString(), source: 'http-429' });
});

test('restart: a persisted pause is re-armed with the remaining delay', () => {
  const clock = fakeClock(T0);
  const dir = tmp();
  setup(clock, dir).pause({ provider: 'claude', resetsAt: T0 + 60000, source: 'x' });

  const clock2 = fakeClock(T0 + 10000); // simulated restart: fresh state, same disk
  const resumed = [];
  const pp2 = setup(clock2, dir, { onResume: (r) => resumed.push(r.provider) });
  assert.deepStrictEqual(pp2.rearm(), ['claude']);
  assert.strictEqual(pp2.claimAllowed('claude'), false);
  assert.strictEqual(clock2.live().length, 1);
  assert.strictEqual(clock2.live()[0].delay, 50000 + jitterFor('claude'));
  clock2.advanceTo(T0 + 60000 + jitterFor('claude'));
  assert.strictEqual(pp2.claimAllowed('claude'), true);
  assert.deepStrictEqual(resumed, ['claude']);
});

test('restart with an already-expired record clears it and arms nothing', () => {
  const clock = fakeClock(T0);
  const dir = tmp();
  setup(clock, dir).pause({ provider: 'claude', resetsAt: T0 + 1000, source: 'x' });
  const clock2 = fakeClock(T0 + 3600000);
  const pp2 = setup(clock2, dir);
  assert.deepStrictEqual(pp2.rearm(), []);
  assert.strictEqual(clock2.all.length, 0);
  assert.strictEqual(pp2.claimAllowed('claude'), true);
});

test('missing or corrupt file does not throw and pauses nothing', () => {
  const clock = fakeClock(T0);
  const dir = tmp();
  const pp = setup(clock, dir);
  assert.strictEqual(pp.claimAllowed('claude'), true);
  fs.writeFileSync(path.join(dir, 'provider-pause.json'), '{not json');
  assert.strictEqual(pp.claimAllowed('claude'), true);
  assert.deepStrictEqual(pp.rearm(), []);
});

test('resuming one provider keeps another provider paused', () => {
  const clock = fakeClock(T0);
  const pp = setup(clock, tmp());
  pp.pause({ provider: 'claude', resetsAt: T0 + 60000, source: 'x' });
  pp.pause({ provider: 'codex', resetsAt: T0 + 60000, source: 'y' });
  pp.resume('claude');
  assert.strictEqual(pp.claimAllowed('claude'), true);
  assert.strictEqual(pp.claimAllowed('codex'), false);
  assert.strictEqual(clock.live().length, 1);
});

test('invalid resetsAt is rejected', () => {
  const pp = setup(fakeClock(T0), tmp());
  assert.throws(() => pp.pause({ provider: 'claude', resetsAt: 'nope', source: 'x' }));
});
