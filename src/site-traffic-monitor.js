'use strict';

// Site traffic monitor for grimm (multi-node plan, piece 2e): pauses this machine's Agent Manager workers while the Property Forager site is in use, so the
// people using it get the machine, and lets the work resume when they are gone.
//
// The signal: sockets in state ESTABLISHED or TIME-WAIT whose LOCAL port is 8080 (the pf-web front door), 3002 (the public backend it proxies to) or 3010 (the
// admin port), read with `ss -tanH`. There is no request log to read: pf-web is a plain node server that logs nothing, and 0 such sockets is the measured idle
// baseline (2026-11-11). TIME-WAIT keeps a request visible for about a minute after its connection closes, so short requests are not missed between passes.
// A TIME-WAIT socket whose PEER is this machine itself (127.x or ::1) is not counted: the host's own once-a-minute health sampler (pf-health-sample.timer,
// 127.0.0.1:8080) left one every minute, which kept the node paused for ever (6 h "stuck" alert, 2026-11-11). Loopback ESTABLISHED sockets still count, so a
// request being served right now is seen wherever it comes from; only the minute-long afterglow of a loopback-only request is dropped.
//
// Each pass (default every 10 seconds):
//   traffic       setPause('node', {source: "site-traffic", reason: "site in use", ttlMin: 10}), refreshing the 10 minute expiry. A pause someone else set here (any
//                 other source, for example the operator's) is left exactly as it is.
//   no traffic    after AGENT_MANAGER_SITE_IDLE_MIN minutes (default 5) without any, the node pause is cleared, but ONLY when its source is site-traffic.
//   backstop      load average above AGENT_MANAGER_SITE_MAX_LOAD (default 3.0) or free RAM below AGENT_MANAGER_SITE_MIN_FREE_GB (default 3, MemAvailable) pauses with
//                 source site-backstop and clears when both are back under the limits, so the live site is protected even before anyone has opened it.
//   ss fails      nothing is changed: a failed read is not "idle". The 10 minute expiry on every pause this monitor sets is what makes it fail-open: a dead monitor
//                 can never leave the machine paused for long, and a graceful stop clears its own pause at once.
//   stuck         a node pause (any source) seen continuously for more than AGENT_MANAGER_SITE_STUCK_HOURS (default 6) raises ONE urgent notification through
//                 src/notify.js, key pause-stuck:<hostname>. The clock is in memory, so a restart of the monitor restarts it.
// Logging: one line per state change (paused, resumed, backstop on/off, ss failing or recovered, stuck), never one per pass.
//
// Run: node src/site-traffic-monitor.js          (the loop; SIGTERM or SIGINT stop it and clear its own pause)
//      node src/site-traffic-monitor.js --once   (one pass, prints the result as JSON, for tests and cron)

const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');
const { setPause, clearPause, readPause } = require('./worker-switch.js');
const { notify } = require('./notify.js');

const SITE_PORTS = [8080, 3002, 3010];
const COUNTED_STATES = ['ESTAB', 'TIME-WAIT'];
const PAUSE_TTL_MIN = 10;
const OWN_SOURCES = ['site-traffic', 'site-backstop'];

function numberFrom(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function config(env = process.env) {
  return {
    idleMin: numberFrom(env.AGENT_MANAGER_SITE_IDLE_MIN, 5),
    maxLoad: numberFrom(env.AGENT_MANAGER_SITE_MAX_LOAD, 3.0),
    minFreeGb: numberFrom(env.AGENT_MANAGER_SITE_MIN_FREE_GB, 3),
    pollS: numberFrom(env.AGENT_MANAGER_SITE_POLL_S, 10),
    stuckHours: numberFrom(env.AGENT_MANAGER_SITE_STUCK_HOURS, 6),
  };
}

// True for an `ss` address (127.0.0.1:44000, [::1]:44000, [::ffff:127.0.0.1]:44000) whose host part is the loopback interface.
function isLoopbackAddress(addr) {
  const host = String(addr || '').slice(0, String(addr || '').lastIndexOf(':')).replace(/^\[|\]$/g, '').toLowerCase();
  return host === '::1' || /^127\./.test(host) || /^::ffff:127\./.test(host);
}

// Counts the ESTABLISHED sockets, and the TIME-WAIT sockets whose peer is not this machine, whose local port is a site port in the output of `ss -tanH`
// (columns: state, recv-q, send-q, local, peer).
function countSiteSockets(ssOutput) {
  let count = 0;
  for (const line of String(ssOutput || '').split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || !COUNTED_STATES.includes(cols[0])) continue;
    const port = Number(cols[3].slice(cols[3].lastIndexOf(':') + 1));
    if (!SITE_PORTS.includes(port)) continue;
    if (cols[0] === 'TIME-WAIT' && isLoopbackAddress(cols[4])) continue;
    count += 1;
  }
  return count;
}

// Available memory in GB (MemAvailable counts reclaimable cache; os.freemem() does not), rounded to two places.
function freeRamGb(readMeminfo = () => fs.readFileSync('/proc/meminfo', 'utf8'), freemem = os.freemem) {
  let bytes = freemem();
  try {
    const m = /^MemAvailable:\s+(\d+)\s+kB/m.exec(readMeminfo());
    if (m) bytes = Number(m[1]) * 1024;
  } catch (e) { /* no /proc/meminfo: keep os.freemem */ }
  return Math.round((bytes / (1024 * 1024 * 1024)) * 100) / 100;
}

function runSsDefault() {
  return new Promise((resolve, reject) => {
    execFile('ss', ['-tanH'], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

function createMonitor({ env = process.env, now = () => Date.now(), runSs = runSsDefault, loadavg = os.loadavg, readMeminfo, freemem, send = notify, log = () => {}, hostname = os.hostname() } = {}) {
  const cfg = config(env);
  const state = { lastTrafficAt: null, pausedSince: null, stuckAlerted: false, ssFailing: false, backstopOn: false, paused: false };
  const pauseOpts = (source, reason) => ({ reason, source, ttlMin: PAUSE_TTL_MIN });

  async function pass() {
    const at = now();
    let out;
    try {
      out = await runSs();
    } catch (e) {
      if (!state.ssFailing) log(`ss failed (${String((e && e.message) || e).slice(0, 80)}); leaving the pause as it is`);
      state.ssFailing = true;
      return { action: 'ss-failed' };
    }
    if (state.ssFailing) log('ss works again');
    state.ssFailing = false;

    const sockets = countSiteSockets(out);
    const load = Math.round(loadavg()[0] * 100) / 100;
    const freeGb = freeRamGb(readMeminfo, freemem);
    const overLimits = load > cfg.maxLoad || freeGb < cfg.minFreeGb;
    let current = readPause('node', env, at);
    let action = 'none';
    const foreign = () => current && !OWN_SOURCES.includes(current.source);

    if (sockets > 0) {
      state.lastTrafficAt = at;
      if (!foreign()) {
        setPause('node', pauseOpts('site-traffic', 'site in use'), env, at);
        if (!current || current.source !== 'site-traffic') log(`paused: site in use (${sockets} sockets)`);
        action = 'paused';
      }
    } else if (current && current.source === 'site-traffic') {
      if (state.lastTrafficAt === null) state.lastTrafficAt = at; // after a restart, count the idle time from now
      if (at - state.lastTrafficAt >= cfg.idleMin * 60 * 1000) {
        clearPause('node', env);
        log(`resumed: no site traffic for ${cfg.idleMin} minutes`);
        action = 'resumed';
      }
    }

    current = readPause('node', env, at);
    if (overLimits) {
      if (!current || current.source === 'site-backstop') {
        setPause('node', pauseOpts('site-backstop', load > cfg.maxLoad ? `load ${load}` : `free RAM ${freeGb} GB`), env, at);
        if (!state.backstopOn) log(`paused: backstop (load ${load}, free RAM ${freeGb} GB)`);
        state.backstopOn = true;
        action = 'backstop';
      }
    } else {
      if (current && current.source === 'site-backstop') {
        clearPause('node', env);
        log('resumed: load and free RAM are back under the limits');
        action = 'backstop-cleared';
      }
      state.backstopOn = false;
    }

    current = readPause('node', env, at);
    state.paused = current !== null;
    if (current === null) {
      state.pausedSince = null;
      state.stuckAlerted = false;
    } else {
      if (state.pausedSince === null) state.pausedSince = at;
      if (!state.stuckAlerted && at - state.pausedSince > cfg.stuckHours * 60 * 60 * 1000) {
        state.stuckAlerted = true;
        log(`stuck: this machine has been paused for more than ${cfg.stuckHours} hours`);
        await send({ level: 'urgent', key: `pause-stuck:${hostname}`, title: `${hostname} has been paused for more than ${cfg.stuckHours} hours`, text: `The node pause on ${hostname} (source ${current.source}) has not ended.` }, { env, now: () => at });
      }
    }
    return { action, sockets, load, freeGb, paused: state.paused };
  }

  // A graceful stop clears the pause this monitor set, so a restart does not leave the machine paused until the expiry.
  function shutdown() {
    const current = readPause('node', env, now());
    if (current && OWN_SOURCES.includes(current.source)) {
      clearPause('node', env);
      log('stopped: cleared my pause');
    }
  }

  return { pass, shutdown, state, cfg };
}

// Logs go to stderr (the journal captures both streams), so `--once` leaves stdout as exactly one JSON line even when the pass logs a state change.
async function main(argv = process.argv.slice(2), env = process.env, io = {}) {
  const out = io.out || ((s) => process.stdout.write(`${s}\n`));
  const err = io.err || ((s) => process.stderr.write(`${s}\n`));
  const log = (line) => err(`[site-traffic] ${new Date().toISOString()} ${line}`);
  const monitor = createMonitor({ env, log, runSs: io.runSs });
  if (argv.includes('--once')) {
    out(JSON.stringify(await monitor.pass()));
    return 0;
  }
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  log(`started (poll ${monitor.cfg.pollS}s, idle ${monitor.cfg.idleMin} min, load limit ${monitor.cfg.maxLoad}, free RAM limit ${monitor.cfg.minFreeGb} GB)`);
  while (!stopping) {
    try { await monitor.pass(); } catch (e) { log(`pass error: ${String((e && e.message) || e).slice(0, 100)}`); }
    await new Promise((r) => setTimeout(r, monitor.cfg.pollS * 1000));
  }
  monitor.shutdown();
  return 0;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; });
}

module.exports = { config, countSiteSockets, freeRamGb, createMonitor, main, SITE_PORTS, PAUSE_TTL_MIN };
