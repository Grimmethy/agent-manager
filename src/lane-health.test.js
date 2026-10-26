'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
// hermetic: the default lease check reads this file (a real KaggleForge/Forge lease on the machine must not change these tests)
process.env.AGENT_MANAGER_COMFY_LEASE_PATH = path.join(os.tmpdir(), 'lane-health-test-no-such-lease.json');
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

test('the probe request matches the lane\'s own calls (same num_ctx / num_batch / keep_alive) so it never evicts the resident model', async () => {
  let body = null;
  await H.probeEndpoint({ url: 'http://x', model: 'm', numCtx: 16384, numBatch: 1024, keepAlive: '30m', post: async (u, b) => { body = b; return { eval_count: 40, eval_duration: 1e9 }; } });
  assert.equal(body.options.num_ctx, 16384);
  assert.equal(body.options.num_batch, 1024);
  assert.equal(body.keep_alive, '30m');
  await H.probeEndpoint({ url: 'http://x', model: 'm', post: async (u, b) => { body = b; return { eval_count: 40, eval_duration: 1e9 }; } });
  assert.equal(body.options.num_ctx, 49152, 'default lanes use the pinned 49152');
  assert.equal(body.options.num_batch, undefined);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-health-ctx-'));
  const now = Date.now();
  fs.writeFileSync(path.join(dir, 'worker-rx580.json'), JSON.stringify({ status: 'idle', lastHeartbeat: new Date(now).toISOString() }));
  let args = null;
  await H.runDueProbes({ lanes: [{ id: 'worker-rx580', model: 'small:8b', numCtx: 16384, numBatch: 1024, env: { OLLAMA_URL: 'http://g:11434' } }], instancesDir: dir, pipelineDir: dir, env: {}, now, probe: async (a) => { args = a; return { ok: true, tps: 25, totalMs: 1 }; } });
  assert.equal(args.numCtx, 16384);
  assert.equal(args.numBatch, 1024);
  assert.equal(args.keepAlive, '30m');
});

test('runDueProbes: a leased card is not probed (a probe would reload the model the lease holder evicted); the other lanes still are', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-health-lease-'));
  const now = Date.now();
  const hb = (id) => fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ status: 'idle', lastHeartbeat: new Date(now).toISOString() }));
  hb('worker-p40'); hb('worker-rx580');
  const lanes = [
    { id: 'worker-p40', model: 'q:27b', env: { OLLAMA_URL: 'http://192.168.122.29:11434' } },
    { id: 'worker-rx580', model: 'small:8b', env: { OLLAMA_URL: 'http://g:11434' } },
  ];
  const probed = [];
  const probe = async (a) => { probed.push(a.url); return { ok: true, tps: 20, totalMs: 500, error: null }; };
  const leaseHeldFor = (url) => url === 'http://192.168.122.29:11434';
  const out = await H.runDueProbes({ lanes, instancesDir: dir, pipelineDir: dir, env: {}, now, probe, leaseHeldFor });
  assert.deepEqual(probed, ['http://g:11434'], 'only the un-leased card was probed');
  assert.deepEqual(out.map((r) => r.lane), ['worker-rx580']);
  assert.equal(fs.existsSync(path.join(dir, 'lane-health.worker-p40.json')), false, 'no probe state was written for the leased lane');
});

test('runDueProbes: a cloud lane is never probed (no tokens/s to judge, and each probe would be a billed call); GPU lanes still are', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-health-cloud-'));
  const now = Date.now();
  const hb = (id) => fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ status: 'idle', lastHeartbeat: new Date(now).toISOString() }));
  hb('worker-cloud'); hb('worker-rx580');
  const lanes = [
    { id: 'worker-cloud', cloud: true, provider: 'cloud', model: 'claude-haiku-5-5', env: { OLLAMA_URL: 'http://127.0.0.1:7450' } },
    { id: 'worker-rx580', model: 'small:8b', env: { OLLAMA_URL: 'http://g:11434' } },
  ];
  const probed = [];
  const probe = async (a) => { probed.push(a.url); return { ok: true, tps: 20, totalMs: 500, error: null }; };
  const out = await H.runDueProbes({ lanes, instancesDir: dir, pipelineDir: dir, env: {}, now, probe });
  assert.deepEqual(probed, ['http://g:11434']);
  assert.deepEqual(out.map((r) => r.lane), ['worker-rx580']);
  assert.equal(H.laneDegraded(dir, 'worker-cloud'), false, 'a cloud lane with no samples is never degraded');
});
