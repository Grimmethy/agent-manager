'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { config, countSiteSockets, freeRamGb, createMonitor, main, SITE_PORTS, PAUSE_TTL_MIN } = require('./site-traffic-monitor.js');
const { readPause, setPause } = require('./worker-switch.js');

const T0 = Date.UTC(2026, 10, 11, 12, 0, 0);
const MIN = 60 * 1000;
const IDLE_SS = 'LISTEN 0 511 0.0.0.0:8080 0.0.0.0:*\nLISTEN 0 511 *:3002 *:*\nESTAB 0 0 192.168.40.83:22 192.168.40.11:50000\n';
const BUSY_SS = `${IDLE_SS}ESTAB 0 0 192.168.40.83:8080 192.168.40.20:51234\n`;

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

test('the site ports are 8080, 3002 and 3010 and a pause lasts 10 minutes unless refreshed', () => {
  assert.deepEqual(SITE_PORTS, [8080, 3002, 3010]);
  assert.equal(PAUSE_TTL_MIN, 10);
});

test('countSiteSockets counts ESTAB and TIME-WAIT sockets on a site local port and nothing else', () => {
  const out = [
    'ESTAB 0 0 192.168.40.83:8080 192.168.40.20:51234',
    'TIME-WAIT 0 0 192.168.40.83:3002 192.168.40.20:44000',
    'ESTAB 0 0 [::ffff:127.0.0.1]:3010 [::ffff:127.0.0.1]:44001',
    'LISTEN 0 511 0.0.0.0:8080 0.0.0.0:*',
    'SYN-RECV 0 0 192.168.40.83:8080 192.168.40.20:51235',
    'FIN-WAIT-1 0 0 192.168.40.83:8080 192.168.40.20:51236',
    'ESTAB 0 0 192.168.40.83:22 192.168.40.11:50000',
    'ESTAB 0 0 192.168.40.83:41000 192.168.40.11:8080',
    'ESTAB 0 0 192.168.40.83:80800 192.168.40.20:1',
    'ESTAB 0 0 192.168.40.83:8080',
    'garbage line', '', '   ',
  ].join('\n');
  assert.equal(countSiteSockets(out), 3);
  assert.equal(countSiteSockets(''), 0);
  assert.equal(countSiteSockets(undefined), 0);
  assert.equal(countSiteSockets(IDLE_SS), 0);
  assert.equal(countSiteSockets(BUSY_SS), 1);
});

test('a TIME-WAIT socket whose peer is this machine is not traffic, but a loopback ESTAB socket and a TIME-WAIT from anywhere else are', () => {
  const tw = (peer) => `TIME-WAIT 0 0 127.0.0.1:8080 ${peer}\n`;
  assert.equal(countSiteSockets(tw('127.0.0.1:44000')), 0);
  assert.equal(countSiteSockets(tw('127.0.0.2:44000')), 0);
  assert.equal(countSiteSockets(tw('[::1]:44000')), 0);
  assert.equal(countSiteSockets(tw('[::ffff:127.0.0.1]:44000')), 0);
  assert.equal(countSiteSockets(tw('192.168.40.20:44000')), 1);
  assert.equal(countSiteSockets(tw('100.64.0.9:44000')), 1);
  assert.equal(countSiteSockets(tw('[fe80::1]:44000')), 1);
  assert.equal(countSiteSockets(tw('1270.0.0.1:44000')), 1, 'only a real 127.x host is loopback');
  assert.equal(countSiteSockets('ESTAB 0 0 127.0.0.1:8080 127.0.0.1:44000\n'), 1);
  assert.equal(countSiteSockets('ESTAB 0 0 [::1]:3002 [::1]:44000\n'), 1);
});

const TUNNEL_SS = `${IDLE_SS}ESTAB 0 0 127.0.0.1:8080 127.0.0.1:43604\nESTAB 0 0 [::ffff:127.0.0.1]:3002 [::ffff:127.0.0.1]:33958\n`;

test('countSiteSockets can ignore loopback ESTAB sockets, and still counts the LAN ones and TIME-WAIT from elsewhere', () => {
  assert.equal(countSiteSockets(TUNNEL_SS), 2);
  assert.equal(countSiteSockets(TUNNEL_SS, { ignoreLoopbackEstab: true }), 0);
  assert.equal(countSiteSockets(TUNNEL_SS, {}), 2);
  assert.equal(countSiteSockets(`${TUNNEL_SS}ESTAB 0 0 192.168.40.83:8080 192.168.40.20:51234\n`, { ignoreLoopbackEstab: true }), 1);
  assert.equal(countSiteSockets(`${TUNNEL_SS}TIME-WAIT 0 0 192.168.40.83:8080 192.168.40.20:51234\n`, { ignoreLoopbackEstab: true }), 1);
});

test('a fresh probe marker hides loopback ESTAB sockets for 12 seconds, no more, and never hides anyone else', async () => {
  const t = setup();
  t.ss = TUNNEL_SS;
  t.markerAt = T0 - 11999;
  assert.equal((await t.pass()).probeWindow, true);
  assert.equal(t.marker(), null, 'no pause while the probe window covers the tunnel connection');
  t.markerAt = T0 - 12000;
  assert.equal((await t.pass()).probeWindow, true, '12 seconds old is still inside the window');
  t.markerAt = T0 - 12001;
  const r = await t.pass();
  assert.equal(r.probeWindow, false);
  assert.equal(r.sockets, 2);
  assert.equal(t.marker().source, 'site-traffic', 'an old marker no longer hides anything');
});

test('the probe marker: absent, in the future, or a visitor from the LAN all leave the pause in place', async () => {
  let t = setup();
  t.ss = TUNNEL_SS;
  t.markerAt = null;
  assert.equal((await t.pass()).probeWindow, false);
  assert.equal(t.marker().source, 'site-traffic');
  t = setup();
  t.ss = TUNNEL_SS;
  t.markerAt = T0 + 5000;
  assert.equal((await t.pass()).probeWindow, false, 'a marker dated well in the future is not trusted');
  t = setup();
  t.ss = `${TUNNEL_SS}ESTAB 0 0 192.168.40.83:8080 192.168.40.20:51234\n`;
  t.markerAt = T0 - 1000;
  const r = await t.pass();
  assert.equal(r.probeWindow, true);
  assert.equal(r.sockets, 1);
  assert.equal(t.marker().source, 'site-traffic', 'a LAN visitor during the probe window still pauses');
});

test('config defaults and overrides', () => {
  assert.equal(config({ HOME: '/h' }).probeMarker, '/h/.local/state/agent-manager/site-probe-marker');
  assert.equal(config({}).probeTtlS, 12);
  assert.equal(config({ AGENT_MANAGER_SITE_PROBE_MARKER: '/x/m', AGENT_MANAGER_SITE_PROBE_TTL_S: '30' }).probeMarker, '/x/m');
  assert.equal(config({ AGENT_MANAGER_SITE_PROBE_TTL_S: '30' }).probeTtlS, 30);
  const { probeMarker, probeTtlS, ...rest } = config({});
  assert.deepEqual(rest, { idleMin: 5, maxLoad: 3, minFreeGb: 3, pollS: 10, stuckHours: 6 });
  const c = config({ AGENT_MANAGER_SITE_IDLE_MIN: '2', AGENT_MANAGER_SITE_MAX_LOAD: '1.5', AGENT_MANAGER_SITE_MIN_FREE_GB: '4', AGENT_MANAGER_SITE_POLL_S: '30', AGENT_MANAGER_SITE_STUCK_HOURS: '1' });
  assert.deepEqual({ ...c, probeMarker: undefined, probeTtlS: undefined }, { idleMin: 2, maxLoad: 1.5, minFreeGb: 4, pollS: 30, stuckHours: 1, probeMarker: undefined, probeTtlS: undefined });
  assert.equal(config({ AGENT_MANAGER_SITE_IDLE_MIN: '0' }).idleMin, 5);
  assert.equal(config({ AGENT_MANAGER_SITE_MAX_LOAD: 'x' }).maxLoad, 3);
});

test('freeRamGb uses MemAvailable and falls back to os.freemem', () => {
  assert.equal(freeRamGb(() => 'MemAvailable: 8388608 kB', () => 1), 8);
  assert.equal(freeRamGb(() => { throw new Error('no proc'); }, () => 2 * 1024 * 1024 * 1024), 2);
});

test('traffic sets a node pause from site-traffic with a 10 minute expiry, and every pass refreshes it', async () => {
  const t = setup();
  t.ss = BUSY_SS;
  const r = await t.pass();
  assert.equal(r.action, 'paused');
  assert.equal(r.sockets, 1);
  const m = t.marker();
  assert.equal(m.source, 'site-traffic');
  assert.equal(m.reason, 'site in use');
  assert.equal(m.expiresAt, new Date(T0 + 10 * MIN).toISOString());
  t.at(8 * MIN);
  await t.pass();
  assert.equal(t.marker().expiresAt, new Date(T0 + 18 * MIN).toISOString());
});

test('no traffic: the pause stays for 5 minutes, is cleared at exactly 5, and only when its source is site-traffic', async () => {
  const t = setup();
  t.ss = BUSY_SS;
  await t.pass();
  t.ss = IDLE_SS;
  t.at(4 * MIN + 59 * 1000);
  assert.equal((await t.pass()).action, 'none');
  assert.notEqual(t.marker(), null);
  t.at(5 * MIN);
  assert.equal((await t.pass()).action, 'resumed');
  assert.equal(t.marker(), null);
  assert.deepEqual(t.logs.map((l) => l.split(':')[0]), ['paused', 'resumed']);
});

test('the idle wait follows AGENT_MANAGER_SITE_IDLE_MIN and restarts with every burst of traffic', async () => {
  const t = setup({ AGENT_MANAGER_SITE_IDLE_MIN: '2' });
  t.ss = BUSY_SS;
  await t.pass();
  t.ss = IDLE_SS;
  t.at(1 * MIN);
  await t.pass();
  t.ss = BUSY_SS;
  t.at(1 * MIN + 30 * 1000);
  await t.pass();
  t.ss = IDLE_SS;
  t.at(3 * MIN);
  assert.equal((await t.pass()).action, 'none', 'only 1.5 minutes since the last traffic');
  t.at(3 * MIN + 30 * 1000);
  assert.equal((await t.pass()).action, 'resumed');
});

test('a pause someone else set here is never overwritten by traffic and never cleared when the site is idle', async () => {
  const t = setup();
  setPause('node', { source: 'operator', reason: 'mine' }, t.env, T0);
  t.ss = BUSY_SS;
  assert.equal((await t.pass()).action, 'none');
  assert.equal(t.marker().source, 'operator');
  assert.equal(t.marker().expiresAt, null);
  t.ss = IDLE_SS;
  t.at(60 * MIN);
  await t.pass();
  assert.equal(t.marker().source, 'operator');
});

test('after a restart an existing site-traffic pause is cleared once the site has been idle for the full wait, counted from the restart', async () => {
  const t = setup();
  setPause('node', { source: 'site-traffic', ttlMin: 10 }, t.env, T0);
  assert.equal((await t.pass()).action, 'none');
  t.at(4 * MIN);
  assert.equal((await t.pass()).action, 'none');
  t.at(5 * MIN);
  assert.equal((await t.pass()).action, 'resumed');
});

test('the load backstop pauses above the limit (not at it), refreshes, and clears when the load is back under', async () => {
  const t = setup();
  t.load = 3;
  assert.equal((await t.pass()).action, 'none');
  t.load = 3.01;
  const r = await t.pass();
  assert.equal(r.action, 'backstop');
  assert.equal(t.marker().source, 'site-backstop');
  assert.equal(t.marker().reason, 'load 3.01');
  t.at(5 * MIN);
  assert.equal((await t.pass()).action, 'backstop');
  assert.equal(t.marker().expiresAt, new Date(T0 + 15 * MIN).toISOString());
  t.load = 1;
  t.at(6 * MIN);
  assert.equal((await t.pass()).action, 'backstop-cleared');
  assert.equal(t.marker(), null);
  assert.equal(t.logs.filter((l) => l.startsWith('paused: backstop')).length, 1);
});

test('the free RAM backstop pauses below the limit (not at it) and names the RAM in the reason', async () => {
  const t = setup();
  t.meminfo = 'MemAvailable: 3145728 kB\n';
  assert.equal((await t.pass()).action, 'none', '3 GB exactly is not below the limit');
  t.meminfo = 'MemAvailable: 3124757 kB\n';
  assert.equal((await t.pass()).action, 'backstop');
  assert.equal(t.marker().reason, 'free RAM 2.98 GB');
  t.meminfo = 'MemAvailable: 8388608 kB\n';
  t.at(1 * MIN);
  assert.equal((await t.pass()).action, 'backstop-cleared');
});

test('the backstop never replaces or clears another source, and traffic takes over a backstop pause', async () => {
  const t = setup();
  setPause('node', { source: 'operator' }, t.env, T0);
  t.load = 9;
  assert.equal((await t.pass()).action, 'none');
  assert.equal(t.marker().source, 'operator');
  t.load = 0.1;
  await t.pass();
  assert.equal(t.marker().source, 'operator', 'not cleared either');
  const u = setup();
  u.load = 9;
  await u.pass();
  assert.equal(u.marker().source, 'site-backstop');
  u.ss = BUSY_SS;
  u.at(1 * MIN);
  assert.equal((await u.pass()).action, 'paused');
  assert.equal(u.marker().source, 'site-traffic');
  const v = setup();
  v.ss = BUSY_SS;
  await v.pass();
  v.load = 9;
  v.at(1 * MIN);
  await v.pass();
  assert.equal(v.marker().source, 'site-traffic', 'a backstop does not replace a traffic pause');
});

test('a failing ss changes nothing, is logged once, and a recovery is logged', async () => {
  const t = setup();
  t.ss = BUSY_SS;
  await t.pass();
  const before = JSON.stringify(t.marker());
  t.ssError = 'ss: command not found';
  t.at(1 * MIN);
  for (let i = 0; i < 3; i += 1) assert.equal((await t.pass()).action, 'ss-failed');
  assert.equal(JSON.stringify(t.marker()), before);
  assert.equal(t.logs.filter((l) => l.startsWith('ss failed')).length, 1);
  t.ssError = null;
  t.at(2 * MIN);
  await t.pass();
  assert.ok(t.logs.includes('ss works again'));
});

test('a pause held for more than 6 hours raises one urgent message, not before, and a resume resets the clock', async () => {
  const t = setup();
  t.ss = BUSY_SS;
  for (let m = 0; m <= 360; m += 5) { t.at(m * MIN); await t.pass(); }
  assert.equal(t.sent.length, 0, 'exactly 6 hours is not more than 6 hours');
  t.at(361 * MIN);
  await t.pass();
  t.at(400 * MIN);
  await t.pass();
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0].level, 'urgent');
  assert.equal(t.sent[0].key, 'pause-stuck:grimm-test');
  assert.match(t.sent[0].title, /grimm-test has been paused for more than 6 hours/);
  t.ss = IDLE_SS;
  t.at(410 * MIN);
  await t.pass();
  assert.equal(t.marker(), null);
  assert.equal(t.monitor.state.pausedSince, null);
  t.ss = BUSY_SS;
  t.at(420 * MIN);
  await t.pass();
  assert.equal(t.monitor.state.stuckAlerted, false);
});

test('a pause of any source counts toward the stuck alert, and the limit follows AGENT_MANAGER_SITE_STUCK_HOURS', async () => {
  const t = setup({ AGENT_MANAGER_SITE_STUCK_HOURS: '1' });
  setPause('node', { source: 'operator' }, t.env, T0);
  await t.pass();
  t.at(61 * MIN);
  await t.pass();
  assert.equal(t.sent.length, 1);
  assert.match(t.sent[0].text, /source operator/);
});

test('steady traffic logs one line, not one per pass', async () => {
  const t = setup();
  t.ss = BUSY_SS;
  for (let i = 0; i < 10; i += 1) { t.at(i * 10 * 1000); await t.pass(); }
  assert.equal(t.logs.length, 1);
  assert.match(t.logs[0], /^paused: site in use \(1 sockets\)$/);
});

test('a graceful stop clears the pause this monitor set but leaves anyone else\'s', async () => {
  const t = setup();
  t.ss = BUSY_SS;
  await t.pass();
  t.monitor.shutdown();
  assert.equal(t.marker(), null);
  assert.ok(t.logs.includes('stopped: cleared my pause'));
  setPause('node', { source: 'operator' }, t.env, T0);
  t.monitor.shutdown();
  assert.equal(t.marker().source, 'operator');
  const u = setup();
  u.load = 9;
  await u.pass();
  u.monitor.shutdown();
  assert.equal(u.marker(), null, 'a backstop pause is also this monitor\'s own');
});

test('the real command line: --once prints one JSON result and the real ss runs', async () => {
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-monitor-cli-'));
  const r = spawnSync('node', [path.join(__dirname, 'site-traffic-monitor.js'), '--once'], { env: { ...process.env, HOME: '/nonexistent-home', AGENT_MANAGER_DISABLED_WORKERS_DIR: path.join(dir, 'switch'), AGENT_MANAGER_SITE_MAX_LOAD: '100000', AGENT_MANAGER_SITE_MIN_FREE_GB: '0.0001' }, encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 0, r.stderr);
  const result = JSON.parse(r.stdout.trim());
  assert.ok(['none', 'paused', 'ss-failed'].includes(result.action), r.stdout);
  assert.equal(r.stdout.trim().split('\n').length, 1, 'stdout is exactly the one JSON line');
  if (result.action !== 'ss-failed') assert.equal(typeof result.sockets, 'number');
});

test('the load is rounded to two places before it is compared and named in the reason', async () => {
  const t = setup();
  t.load = 3.004;
  assert.equal((await t.pass()).action, 'none', 'rounds to 3, which is not above the limit');
  t.load = 3.014;
  assert.equal((await t.pass()).action, 'backstop');
  assert.equal(t.marker().reason, 'load 3.01');
});

test('--once prints exactly one JSON line on stdout and sends the state-change log to stderr', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-monitor-main-'));
  const env = { HOME: '/nonexistent-home', AGENT_MANAGER_DISABLED_WORKERS_DIR: path.join(dir, 'switch'), AGENT_MANAGER_SITE_MAX_LOAD: '100000', AGENT_MANAGER_SITE_MIN_FREE_GB: '0.0001' };
  const out = [];
  const err = [];
  const code = await main(['--once'], env, { out: (s) => out.push(s), err: (s) => err.push(s), runSs: async () => BUSY_SS });
  assert.equal(code, 0);
  assert.equal(out.length, 1);
  assert.equal(JSON.parse(out[0]).action, 'paused');
  assert.equal(err.length, 1);
  assert.match(err[0], /^\[site-traffic\] \d{4}-\d\d-\d\dT[\d:.]+Z paused: site in use \(1 sockets\)$/);
  assert.equal(readPause('node', env, Date.now()).source, 'site-traffic');
});

test('--once with an idle site prints the result and logs nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-monitor-main-'));
  const env = { HOME: '/nonexistent-home', AGENT_MANAGER_DISABLED_WORKERS_DIR: path.join(dir, 'switch'), AGENT_MANAGER_SITE_MAX_LOAD: '100000', AGENT_MANAGER_SITE_MIN_FREE_GB: '0.0001' };
  const out = [];
  const err = [];
  await main(['--once'], env, { out: (s) => out.push(s), err: (s) => err.push(s), runSs: async () => IDLE_SS });
  assert.equal(JSON.parse(out[0]).action, 'none');
  assert.equal(err.length, 0);
});
