'use strict';

// The minimum number of site sockets that count as 'site in use' (AGENT_MANAGER_SITE_PAUSE_MIN_SOCKETS, default 1) in src/site-traffic-monitor.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { config, createMonitor } = require('./site-traffic-monitor.js');
const { readPause } = require('./worker-switch.js');

const T0 = Date.UTC(2026, 10, 11, 12, 0, 0);
const MIN = 60 * 1000;
const IDLE_SS = 'LISTEN 0 511 0.0.0.0:8080 0.0.0.0:*\nESTAB 0 0 192.168.40.83:22 192.168.40.11:50000\n';
const sockets = (n) => `${IDLE_SS}${Array.from({ length: n }, (_, i) => `ESTAB 0 0 192.168.40.83:8080 192.168.40.20:${51000 + i}\n`).join('')}`;

function setup(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-monitor-'));
  const env = { HOME: '/nonexistent-home', AGENT_MANAGER_DISABLED_WORKERS_DIR: path.join(dir, 'switch'), ...extra };
  const t = { env, clock: T0, ss: IDLE_SS, load: 0.5, meminfo: 'MemAvailable: 8388608 kB\n', logs: [], sent: [], ssError: null, markerAt: null };
  const monitor = createMonitor({
    env,
    markerMtime: () => t.markerAt,
    now: () => t.clock,
    runSs: async () => { if (t.ssError) throw new Error(t.ssError); return t.ss; },
    loadavg: () => [t.load, 0, 0],
    readMeminfo: () => t.meminfo,
    freemem: () => 0,
    send: async (msg) => { t.sent.push(msg); },
    log: (line) => t.logs.push(line),
    hostname: 'grimm-test',
  });
  t.monitor = monitor;
  t.pass = () => monitor.pass();
  t.at = (ms) => { t.clock = T0 + ms; };
  t.marker = () => readPause('node', env, t.clock);
  return t;
}


test('the minimum comes from AGENT_MANAGER_SITE_PAUSE_MIN_SOCKETS: default 1, whole numbers only, a bad or non-positive value gives 1', () => {
  assert.equal(config({}).minSockets, 1);
  assert.equal(config({ AGENT_MANAGER_SITE_PAUSE_MIN_SOCKETS: '3' }).minSockets, 3);
  assert.equal(config({ AGENT_MANAGER_SITE_PAUSE_MIN_SOCKETS: '2.9' }).minSockets, 2);
  assert.equal(config({ AGENT_MANAGER_SITE_PAUSE_MIN_SOCKETS: '0.4' }).minSockets, 1);
  for (const bad of ['0', '-3', 'x', '']) assert.equal(config({ AGENT_MANAGER_SITE_PAUSE_MIN_SOCKETS: bad }).minSockets, 1, bad);
});

test('with the default one socket pauses', async () => {
  const t = setup();
  t.ss = sockets(1);
  assert.equal((await t.pass()).action, 'paused');
  assert.equal(t.marker().source, 'site-traffic');
});

test('with a minimum of 3: one or two sockets never pause, three do, and the reason is logged with the count', async () => {
  const t = setup({ AGENT_MANAGER_SITE_PAUSE_MIN_SOCKETS: '3' });
  for (const n of [1, 2]) {
    t.ss = sockets(n);
    const r = await t.pass();
    assert.equal(r.action, 'none', `${n} sockets`);
    assert.equal(r.sockets, n);
    assert.equal(t.marker(), null);
  }
  t.ss = sockets(3);
  assert.equal((await t.pass()).action, 'paused');
  assert.equal(t.marker().source, 'site-traffic');
  assert.deepEqual(t.logs, ['paused: site in use (3 sockets)']);
});

test('below the minimum is idle: a pause lapses after the idle wait even while one or two sockets stay open, and three keep refreshing it', async () => {
  const t = setup({ AGENT_MANAGER_SITE_PAUSE_MIN_SOCKETS: '3' });
  t.ss = sockets(3);
  await t.pass();
  t.at(2 * MIN); t.ss = sockets(2);
  assert.equal((await t.pass()).action, 'none');
  assert.notEqual(t.marker(), null, 'the pause stays inside the 5 minute idle wait');
  t.at(5 * MIN - 1);
  assert.equal((await t.pass()).action, 'none');
  t.at(5 * MIN);
  assert.equal((await t.pass()).action, 'resumed');
  assert.equal(t.marker(), null);
  const u = setup({ AGENT_MANAGER_SITE_PAUSE_MIN_SOCKETS: '3' });
  u.ss = sockets(3);
  await u.pass();
  for (const m of [3, 6, 9, 12]) { u.at(m * MIN); u.ss = sockets(3); assert.equal((await u.pass()).action, 'paused'); }
  assert.notEqual(u.marker(), null);
});

test('the minimum never overrides a foreign pause or the load backstop', async () => {
  const t = setup({ AGENT_MANAGER_SITE_PAUSE_MIN_SOCKETS: '3' });
  t.load = 9;
  t.ss = sockets(1);
  assert.equal((await t.pass()).action, 'backstop');
  assert.equal(t.marker().source, 'site-backstop');
});
