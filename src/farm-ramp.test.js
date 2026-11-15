'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { LIMITS, evaluateSample, nextStep, takeSample, memAvailableGb, timedGet, median, main } = require('./farm-ramp.js');

const BASE = { siteMs: 100 };
const GOOD = { siteMs: 100, load: 1, freeRamGb: 8, rateLimited: false };

test('the limits are the plan\'s: site 20 percent, load 3.0, free RAM 3 GB', () => {
  assert.deepEqual(LIMITS, { siteSlowdown: 0.2, load: 3.0, freeRamGb: 3 });
});

test('a healthy sample has no breaches', () => {
  assert.deepEqual(evaluateSample(BASE, GOOD), { ok: true, breaches: [] });
});

test('site: exactly 20 percent slower is fine, one millisecond more is a breach (also with fractional baselines)', () => {
  assert.equal(evaluateSample(BASE, { ...GOOD, siteMs: 120 }).ok, true);
  assert.deepEqual(evaluateSample(BASE, { ...GOOD, siteMs: 121 }).breaches, ['site']);
  assert.equal(evaluateSample({ siteMs: 3 }, { ...GOOD, siteMs: 3.6 }).ok, true, 'no floating point false alarm at exactly +20%');
  assert.deepEqual(evaluateSample({ siteMs: 3 }, { ...GOOD, siteMs: 3.61 }).breaches, ['site']);
  assert.equal(evaluateSample(BASE, { ...GOOD, siteMs: 50 }).ok, true, 'faster than baseline is fine');
});

test('load: 3.0 is fine, above it is a breach', () => {
  assert.equal(evaluateSample(BASE, { ...GOOD, load: 3.0 }).ok, true);
  assert.deepEqual(evaluateSample(BASE, { ...GOOD, load: 3.01 }).breaches, ['load']);
});

test('free RAM: 3 GB is fine, below it is a breach', () => {
  assert.equal(evaluateSample(BASE, { ...GOOD, freeRamGb: 3 }).ok, true);
  assert.deepEqual(evaluateSample(BASE, { ...GOOD, freeRamGb: 2.99 }).breaches, ['ram']);
});

test('a rate limit is a breach only when it is exactly true', () => {
  assert.deepEqual(evaluateSample(BASE, { ...GOOD, rateLimited: true }).breaches, ['rate']);
  assert.equal(evaluateSample(BASE, { ...GOOD, rateLimited: 'yes' }).ok, true);
  assert.equal(evaluateSample(BASE, { siteMs: 100, load: 1, freeRamGb: 8 }).ok, true);
});

test('several breaches are all listed in a fixed order', () => {
  assert.deepEqual(evaluateSample(BASE, { siteMs: 500, load: 9, freeRamGb: 1, rateLimited: true }).breaches, ['site', 'load', 'ram', 'rate']);
});

test('a value that could not be measured counts as a breach; a missing sample breaches everything measurable', () => {
  assert.deepEqual(evaluateSample(BASE, { ...GOOD, siteMs: null }).breaches, ['site']);
  assert.deepEqual(evaluateSample(BASE, { ...GOOD, load: NaN }).breaches, ['load']);
  assert.deepEqual(evaluateSample(BASE, { ...GOOD, freeRamGb: null }).breaches, ['ram']);
  assert.deepEqual(evaluateSample(BASE, null).breaches, ['site', 'load', 'ram']);
});

test('a baseline without a positive siteMs is an error', () => {
  for (const b of [null, {}, { siteMs: 0 }, { siteMs: -5 }, { siteMs: 'x' }, { siteMs: NaN }]) assert.throws(() => evaluateSample(b, GOOD), /baseline\.siteMs/);
});

test('custom limits are honoured', () => {
  const tight = { siteSlowdown: 0.1, load: 1, freeRamGb: 10 };
  assert.deepEqual(evaluateSample(BASE, { siteMs: 111, load: 1.5, freeRamGb: 9, rateLimited: false }, tight).breaches, ['site', 'load', 'ram']);
});

test('no breach and no cap: raise by one', () => {
  assert.deepEqual(nextStep({ workers: 2, cap: null }, GOOD, BASE), { action: 'raise', workers: 3, cap: null, breaches: [] });
  assert.deepEqual(nextStep({ workers: 0 }, GOOD, BASE), { action: 'raise', workers: 1, cap: null, breaches: [] });
});

test('a breach stops the ramp with the cap one step below the worker count that broke it', () => {
  assert.deepEqual(nextStep({ workers: 4, cap: null }, { ...GOOD, load: 3.5 }, BASE), { action: 'stop', workers: 3, cap: 3, breaches: ['load'] });
  assert.deepEqual(nextStep({ workers: 1, cap: null }, { ...GOOD, freeRamGb: 1 }, BASE), { action: 'stop', workers: 0, cap: 0, breaches: ['ram'] });
  assert.deepEqual(nextStep({ workers: 0, cap: null }, { ...GOOD, rateLimited: true }, BASE), { action: 'stop', workers: 0, cap: 0, breaches: ['rate'] });
  assert.equal(nextStep({ workers: 5, cap: 5 }, { ...GOOD, siteMs: 400 }, BASE).cap, 4, 'a breach at the cap lowers the cap');
});

test('with a cap: raise below it, hold at it', () => {
  assert.deepEqual(nextStep({ workers: 2, cap: 4 }, GOOD, BASE), { action: 'raise', workers: 3, cap: 4, breaches: [] });
  assert.deepEqual(nextStep({ workers: 4, cap: 4 }, GOOD, BASE), { action: 'hold', workers: 4, cap: 4, breaches: [] });
  assert.deepEqual(nextStep({ workers: 6, cap: 4 }, GOOD, BASE), { action: 'hold', workers: 4, cap: 4, breaches: [] });
  assert.deepEqual(nextStep({ workers: 0, cap: 0 }, GOOD, BASE), { action: 'hold', workers: 0, cap: 0, breaches: [] });
});

test('memAvailableGb reads MemAvailable in GB and gives null without it', () => {
  assert.equal(memAvailableGb(() => 'MemTotal: 16000000 kB\nMemAvailable:    6291456 kB\nMemFree: 1 kB\n'), 6);
  assert.equal(memAvailableGb(() => 'MemTotal: 16000000 kB\n'), null);
});

test('median of odd and even lists', () => {
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([7]), 7);
});

const meminfo = () => 'MemAvailable: 4194304 kB\n';

test('takeSample uses the load, MemAvailable and the median of the timed gets', async () => {
  const times = [30, 10, 20];
  const s = await takeSample({ siteUrl: 'http://x', repeat: 3, deps: { loadavg: () => 1.5, readMeminfo: meminfo, timedGet: async () => ({ ms: times.shift(), status: 200 }) } });
  assert.deepEqual(s, { siteMs: 20, load: 1.5, freeRamGb: 4, rateLimited: false });
});

test('takeSample: a failing, 5xx or malformed get makes siteMs null; a missing url never calls the site; unreadable meminfo gives null RAM', async () => {
  const base = { loadavg: () => 0.5, readMeminfo: meminfo };
  assert.equal((await takeSample({ siteUrl: 'http://x', deps: { ...base, timedGet: async () => { throw new Error('down'); } } })).siteMs, null);
  assert.equal((await takeSample({ siteUrl: 'http://x', deps: { ...base, timedGet: async () => ({ ms: 5, status: 503 }) } })).siteMs, null);
  assert.equal((await takeSample({ siteUrl: 'http://x', deps: { ...base, timedGet: async () => ({ ms: 5, status: 404 }) } })).siteMs, 5, 'a 404 is still a measurable answer');
  assert.equal((await takeSample({ siteUrl: 'http://x', deps: { ...base, timedGet: async () => null } })).siteMs, null);
  let calls = 0;
  const none = await takeSample({ deps: { ...base, timedGet: async () => { calls += 1; return { ms: 1, status: 200 }; } } });
  assert.equal(none.siteMs, null);
  assert.equal(calls, 0);
  assert.equal((await takeSample({ siteUrl: 'http://x', deps: { ...base, readMeminfo: () => { throw new Error('no /proc'); }, timedGet: async () => ({ ms: 1, status: 200 }) } })).freeRamGb, null);
});

async function site(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => { server.close(); server.closeAllConnections(); } };
}

test('timedGet times a real local request and reports its status; a closed port rejects and a silent server times out', async () => {
  const s = await site((req, res) => { res.writeHead(200); res.end('ok'); });
  try {
    const r = await timedGet(s.url);
    assert.equal(r.status, 200);
    assert.ok(r.ms >= 0 && r.ms < 5000);
  } finally { s.close(); }
  await assert.rejects(timedGet(s.url));
  const slow = await site(() => {});
  try { await assert.rejects(timedGet(slow.url, 150), /timeout/); } finally { slow.close(); }
});

test('main step prints the decision with the sample; a stop on a breach; usage errors exit 2', async () => {
  const out = [];
  const deps = { loadavg: () => 1, readMeminfo: meminfo, timedGet: async () => ({ ms: 100, status: 200 }) };
  const errs = process.stderr.write;
  process.stderr.write = () => true;
  try {
    assert.equal(await main(['step', '--workers', '2', '--baseline-ms', '100', '--site-url', 'http://x'], deps, (s) => out.push(JSON.parse(s))), 0);
    assert.deepEqual(out.pop(), { action: 'raise', workers: 3, cap: null, breaches: [], sample: { siteMs: 100, load: 1, freeRamGb: 4, rateLimited: false } });
    assert.equal(await main(['step', '--workers', '3', '--cap', '3', '--baseline-ms', '100', '--site-url', 'http://x'], deps, (s) => out.push(JSON.parse(s))), 0);
    assert.equal(out.pop().action, 'hold');
    assert.equal(await main(['step', '--workers', '3', '--baseline-ms', '100', '--site-url', 'http://x', '--rate-limited'], deps, (s) => out.push(JSON.parse(s))), 0);
    const stop = out.pop();
    assert.deepEqual([stop.action, stop.cap, stop.breaches], ['stop', 2, ['rate']]);
    assert.equal(await main(['baseline', '--site-url', 'http://x', '--repeat', '2'], deps, (s) => out.push(JSON.parse(s))), 0);
    assert.deepEqual(out.pop(), { siteMs: 100, load: 1, freeRamGb: 4, rateLimited: false });
    let gets = 0;
    const counting = { ...deps, timedGet: async () => { gets += 1; return { ms: 100, status: 200 }; } };
    assert.equal(await main(['baseline', '--site-url', 'http://x'], counting, (x) => out.push(JSON.parse(x))), 0);
    assert.equal(gets, 3, 'the baseline takes three timed gets unless --repeat says otherwise');
    out.pop();
    for (const argv of [[], ['baseline'], ['step', '--workers', '2', '--baseline-ms', '100'], ['step', '--site-url', 'http://x', '--baseline-ms', '100'], ['step', '--workers', 'x', '--baseline-ms', '100', '--site-url', 'u'], ['step', '--workers', '-1', '--baseline-ms', '100', '--site-url', 'u'], ['step', '--workers', '2', '--baseline-ms', '0', '--site-url', 'u'], ['step', '--workers', '2', '--cap', '-3', '--baseline-ms', '100', '--site-url', 'u'], ['bogus', '--site-url', 'u']]) {
      assert.equal(await main(argv, deps, () => assert.fail('no output on usage errors')), 2, JSON.stringify(argv));
    }
  } finally { process.stderr.write = errs; }
});

test('the real CLI as a child process against a real local server prints a baseline and a decision and never touches workers', async () => {
  const s = await site((req, res) => { res.writeHead(200); res.end('ok'); });
  const runCli = (args) => new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(__dirname, 'farm-ramp.js'), ...args]);
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('close', (code) => resolve({ code, out }));
  });
  try {
    const base = await runCli(['baseline', '--site-url', s.url, '--repeat', '2']);
    assert.equal(base.code, 0);
    const b = JSON.parse(base.out);
    assert.deepEqual(Object.keys(b), ['siteMs', 'load', 'freeRamGb', 'rateLimited']);
    assert.ok(b.siteMs >= 0 && b.load >= 0 && b.freeRamGb > 0);
    const step = await runCli(['step', '--workers', '1', '--baseline-ms', '60000', '--site-url', s.url]);
    assert.equal(step.code, 0);
    const d = JSON.parse(step.out);
    assert.ok(['raise', 'stop'].includes(d.action));
    assert.equal(d.sample.siteMs < 60000, true);
    assert.equal((await runCli([])).code, 2);
  } finally { s.close(); }
});
