'use strict';

// Stress-test ramp decision (multi-node plan, piece 5d): how many workers a node can run, found by raising them one at a time and stopping at the first limit.
// The limits (plan decision 11): the site more than 20 percent slower than its baseline, load average above 3.0 (4 cores), free RAM below 3 GB, or a rate
// limit from the cloud gateway. At the first breach the farm stops and the cap is one step below the worker count that broke it.
//
//   evaluateSample(baseline, sample, limits) -> {ok, breaches}   breaches are 'site', 'load', 'ram', 'rate'
//   nextStep({workers, cap}, sample, baseline, limits) -> {action: 'raise'|'stop'|'hold', workers, cap, breaches}
//   takeSample({siteUrl, repeat, deps}) -> {siteMs, load, freeRamGb, rateLimited}
//
//   node src/farm-ramp.js baseline --site-url <url> [--repeat <n>]
//   node src/farm-ramp.js step --workers <n> [--cap <n>] --baseline-ms <ms> --site-url <url> [--rate-limited]
//
// The command line only PRINTS a decision. It never starts or stops a worker: the owner (or a later piece) applies it. See docs/agents/multi-node-runbook.md.

const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');

const LIMITS = { siteSlowdown: 0.2, load: 3.0, freeRamGb: 3 };

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const round6 = (v) => Math.round(v * 1e6) / 1e6;

// A value that cannot be measured counts as a breach: an unknown is not safe.
function evaluateSample(baseline, sample, limits = LIMITS) {
  if (!baseline || !isNum(baseline.siteMs) || baseline.siteMs <= 0) throw new Error('baseline.siteMs must be a positive number');
  const s = sample || {};
  const breaches = [];
  if (!isNum(s.siteMs) || s.siteMs > round6(baseline.siteMs * (1 + limits.siteSlowdown))) breaches.push('site');
  if (!isNum(s.load) || s.load > limits.load) breaches.push('load');
  if (!isNum(s.freeRamGb) || s.freeRamGb < limits.freeRamGb) breaches.push('ram');
  if (s.rateLimited === true) breaches.push('rate');
  return { ok: breaches.length === 0, breaches };
}

function nextStep(state, sample, baseline, limits = LIMITS) {
  const workers = Math.max(0, Number(state && state.workers) || 0);
  const cap = isNum(state && state.cap) ? state.cap : null;
  const { ok, breaches } = evaluateSample(baseline, sample, limits);
  if (!ok) {
    const newCap = Math.max(0, workers - 1);
    return { action: 'stop', workers: newCap, cap: newCap, breaches };
  }
  if (cap !== null && workers >= cap) return { action: 'hold', workers: cap, cap, breaches };
  return { action: 'raise', workers: workers + 1, cap, breaches };
}

function memAvailableGb(readMeminfo) {
  const m = /^MemAvailable:\s+(\d+)\s+kB/m.exec(readMeminfo());
  return m ? Number(m[1]) / 1024 / 1024 : null;
}

// One timed GET: {ms, status}; rejects on a network error or a 10 second timeout.
function timedGet(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const lib = String(url).startsWith('https:') ? https : http;
    const req = lib.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      res.on('end', () => resolve({ ms: Date.now() - started, status: res.statusCode }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function median(values) {
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// Measures one sample. siteMs is the median of `repeat` timed GETs and is null when any of them fails or answers a 5xx (the site is not measurable).
async function takeSample({ siteUrl, repeat = 1, deps = {} } = {}) {
  const loadavg = deps.loadavg || (() => os.loadavg()[0]);
  const readMeminfo = deps.readMeminfo || (() => fs.readFileSync('/proc/meminfo', 'utf8'));
  const get = deps.timedGet || timedGet;
  let freeRamGb = null;
  try { freeRamGb = memAvailableGb(readMeminfo); } catch (e) { freeRamGb = null; }
  const times = [];
  let ok = Boolean(siteUrl);
  for (let i = 0; ok && i < repeat; i += 1) {
    try {
      const r = await get(siteUrl);
      if (r && isNum(r.ms) && r.status < 500) times.push(r.ms); else ok = false;
    } catch (e) {
      ok = false;
    }
  }
  return { siteMs: ok && times.length ? median(times) : null, load: loadavg(), freeRamGb, rateLimited: false };
}

function flag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

const intFlag = (argv, name) => (flag(argv, name) === undefined ? undefined : Number(flag(argv, name)));

async function main(argv, deps = {}, out = (s) => process.stdout.write(`${s}\n`)) {
  const cmd = argv[0];
  const siteUrl = flag(argv, '--site-url');
  const usage = () => { process.stderr.write('usage: node src/farm-ramp.js baseline --site-url <url> [--repeat <n>] | step --workers <n> [--cap <n>] --baseline-ms <ms> --site-url <url> [--rate-limited]\n'); return 2; };
  if (!siteUrl) return usage();
  if (cmd === 'baseline') {
    const repeat = intFlag(argv, '--repeat') || 3;
    out(JSON.stringify(await takeSample({ siteUrl, repeat, deps })));
    return 0;
  }
  const workers = intFlag(argv, '--workers');
  const cap = intFlag(argv, '--cap');
  const baselineMs = intFlag(argv, '--baseline-ms');
  if (cmd !== 'step' || !Number.isInteger(workers) || workers < 0 || !(baselineMs > 0) || (cap !== undefined && !(Number.isInteger(cap) && cap >= 0))) return usage();
  const sample = await takeSample({ siteUrl, deps });
  sample.rateLimited = argv.includes('--rate-limited');
  out(JSON.stringify({ ...nextStep({ workers, cap: cap === undefined ? null : cap }, sample, { siteMs: baselineMs }), sample }));
  return 0;
}

if (require.main === module) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });

module.exports = { LIMITS, evaluateSample, nextStep, takeSample, memAvailableGb, timedGet, median, main };
