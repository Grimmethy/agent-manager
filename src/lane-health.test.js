'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('./lane-health.js');

const CFG = H.healthConfig({});
const ok = (tps, at = new Date().toISOString()) => ({ at, ok: true, tps, totalMs: 1000, error: null });

test('assess: no baseline until 3 good samples; then a probe under half the 75th percentile is degraded', () => {
  assert.equal(H.assess([ok(26), ok(1)], CFG).degraded, false, 'too few samples to call a baseline');
  const good = [ok(26), ok(27), ok(25), ok(26)];
  assert.equal(H.assess(good, CFG).degraded, false);
  assert.equal(H.assess([...good, ok(0.6)], CFG).degraded, true);
  assert.equal(H.assess([...good, ok(20)], CFG).degraded, false, 'a modest dip is not degraded');
  assert.equal(H.assess([...good, { at: 'x', ok: false, tps: 0, error: 'timeout' }], CFG).degraded, true, 'a failed probe is degraded');
  assert.equal(H.assess([], CFG).degraded, false);
});

test('a lane that has always been slow is not degraded (baseline is its own)', () => {
  assert.equal(H.assess([ok(9), ok(10), ok(9.5), ok(10), ok(9)], CFG).degraded, false);
});

test('runDueProbes: probes only idle, due lanes; records samples; throttles; does not double a probe in flight', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-health-'));
  const now = Date.now();
  const hb = (id, status) => fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ status, lastHeartbeat: new Date(now).toISOString() }));
  hb('worker-rx580', 'idle'); hb('worker-3090', 'working');
  const lanes = [{ id: 'worker-rx580', model: 'small:8b', env: { OLLAMA_URL: 'http://g:11434' } }, { id: 'worker-3090', model: 'big:27b', env: {} }];
  const calls = [];
  const probe = async (a) => { calls.push(a.url); return { ok: true, tps: 26, totalMs: 500, error: null }; };
  const first = await H.runDueProbes({ lanes, instancesDir: dir, pipelineDir: dir, env: {}, now, probe });
  assert.deepEqual(first.map((r) => r.lane), ['worker-rx580'], 'the busy lane is not probed');
  assert.deepEqual(calls, ['http://g:11434']);
  const again = await H.runDueProbes({ lanes, instancesDir: dir, pipelineDir: dir, env: {}, now: now + 1000, probe });
  assert.equal(again.length, 0, 'throttled by the interval');
  fs.writeFileSync(path.join(dir, 'lane-health.worker-rx580.json'), JSON.stringify({ samples: [], probingSince: new Date(now).toISOString() }));
  assert.equal((await H.runDueProbes({ lanes, instancesDir: dir, pipelineDir: dir, env: {}, now: now + 5000, probe })).length, 0, 'a probe in flight is not doubled');
  assert.equal((await H.runDueProbes({ lanes, instancesDir: dir, pipelineDir: dir, env: { AGENT_MANAGER_LANE_HEALTH: 'off' }, now: now + 99999999, probe })).length, 0, 'off switch');
});

test('laneDegraded reads the latest fresh verdict; stale or unknown never blocks', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-health-deg-'));
  const now = Date.now();
  const write = (samples) => fs.writeFileSync(path.join(dir, 'lane-health.worker-rx580.json'), JSON.stringify({ samples }));
  const base = [ok(26, new Date(now - 4000000).toISOString()), ok(27, new Date(now - 3000000).toISOString()), ok(25, new Date(now - 2000000).toISOString())];
  write([...base, ok(0.6, new Date(now - 60000).toISOString())]);
  assert.equal(H.laneDegraded(dir, 'worker-rx580', { now }), true);
  write([...base, ok(0.6, new Date(now - 3600000).toISOString())]);
  assert.equal(H.laneDegraded(dir, 'worker-rx580', { now }), false, 'a stale verdict is not trusted');
  assert.equal(H.laneDegraded(dir, 'worker-none', { now }), false);
  write([...base, ok(0.6, new Date(now - 60000).toISOString())]);
  assert.equal(H.laneDegradedBetween(dir, 'worker-rx580', new Date(now - 120000).toISOString(), new Date(now).toISOString()), true);
  assert.equal(H.laneDegradedBetween(dir, 'worker-rx580', new Date(now - 9000000).toISOString(), new Date(now - 8000000).toISOString()), false);
});

test('probeEndpoint turns Ollama timing into tokens/s and fails soft', async () => {
  const good = await H.probeEndpoint({ url: 'http://x', model: 'm', post: async () => ({ eval_count: 52, eval_duration: 2e9 }) });
  assert.equal(good.ok, true);
  assert.equal(Math.round(good.tps), 26);
  const bad = await H.probeEndpoint({ url: 'http://x', model: 'm', post: async () => { throw new Error('timed out'); } });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /timed out/);
});
