'use strict';

// A lane that yields to a GPU session (a Forge job, a tuning session) must say so in its heartbeat and reload its model afterwards
// (lane_note_gpu_pause / lane_warm_after_pause in agent-manager-common.sh). A stub `curl` stands in for Ollama: nothing here loads a model or
// touches a GPU.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const laneHealth = require('../src/lane-health.js');

const COMMON = path.join(__dirname, 'agent-manager-common.sh');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-gpu-session-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// A curl that records its arguments and the lane's heartbeat at start and ~2.4 s later, then exits. FAKE_CURL_FAIL=1 makes it exit non-zero at once.
function stubDir(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'instances'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bin', 'curl'), `#!/bin/bash
echo "$@" >> "${dir}/curl-calls.txt"
[[ "$FAKE_CURL_FAIL" == "1" ]] && exit 7
cp "${dir}/instances/worker-x.json" "${dir}/hb-at-start.json"
sleep 2.4
cp "${dir}/instances/worker-x.json" "${dir}/hb-later.json"
`, { mode: 0o755 });
  return dir;
}

function run(dir, script, extraEnv = {}) {
  return spawnSync('bash', ['-c', `source "${COMMON}"; ${script}`], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`, INSTANCES_DIR: path.join(dir, 'instances'),
      OLLAMA_URL: 'http://127.0.0.1:11999', AGENT_MANAGER_WARMUP_BEAT_S: '1', AGENT_MANAGER_WARMUP_TIMEOUT_S: '30', ...extraEnv },
  });
}
const hb = (dir, file = 'instances/worker-x.json') => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
const calls = (dir) => (fs.existsSync(path.join(dir, 'curl-calls.txt')) ? fs.readFileSync(path.join(dir, 'curl-calls.txt'), 'utf8').trim().split('\n') : []);

test('lane_note_gpu_pause writes a "paused" heartbeat with the gpu-session pass and keeps the model', () => {
  const dir = stubDir('pause');
  const r = run(dir, 'lane_note_gpu_pause worker-x ornith:35b 2026-10-31T00:00:00Z');
  assert.equal(r.status, 0, r.stderr);
  const h = hb(dir);
  assert.equal(h.status, 'paused');
  assert.equal(h.currentPass, 'gpu-session');
  assert.equal(h.model, 'ornith:35b');
});

test('after a pause, lane_warm_after_pause warms the lane\'s own model on its own endpoint, shows "warming" and keeps beating while it waits', () => {
  const dir = stubDir('warm');
  const r = run(dir, 'lane_note_gpu_pause worker-x ornith:35b T0; lane_warm_after_pause worker-x ornith:35b T0');
  assert.equal(r.status, 0, r.stderr);
  const [call] = calls(dir);
  assert.match(call, /http:\/\/127\.0\.0\.1:11999\/api\/generate/);
  const body = JSON.parse(call.slice(call.indexOf('-d ') + 3, call.lastIndexOf(' -o ')));
  assert.equal(body.model, 'ornith:35b');
  assert.equal(body.keep_alive, -1, 'resident again, protected like the launch pre-warm');
  assert.equal(body.options.num_ctx, 49152, 'the pinned context, so the next call does not reload it');
  const start = hb(dir, 'hb-at-start.json');
  const later = hb(dir, 'hb-later.json');
  assert.equal(start.status, 'warming');
  assert.equal(start.currentPass, 'model-warmup');
  assert.equal(later.status, 'warming');
  assert.notEqual(later.lastHeartbeat, start.lastHeartbeat, 'a heartbeat was written while the warm-up was still running');
  assert.match(r.stderr, /warm-up finished/);
});

test('a lane context size set for the lane (a small card) is used for the warm-up', () => {
  const dir = stubDir('ctx');
  run(dir, 'lane_note_gpu_pause worker-x m T0; lane_warm_after_pause worker-x m T0', { AGENT_MANAGER_LANE_NUM_CTX: '16384' });
  assert.equal(JSON.parse(calls(dir)[0].replace(/^.*-d /, '').replace(/ -o .*$/, '')).options.num_ctx, 16384);
});

test('lane_warm_after_pause does nothing unless this process was paused, and only once per pause', () => {
  const dir = stubDir('noop');
  assert.equal(run(dir, 'lane_warm_after_pause worker-x ornith:35b T0').status, 0);
  assert.deepEqual(calls(dir), [], 'never paused: no warm-up call');
  run(dir, 'lane_note_gpu_pause worker-x ornith:35b T0; lane_warm_after_pause worker-x ornith:35b T0; lane_warm_after_pause worker-x ornith:35b T0');
  assert.equal(calls(dir).length, 1, 'the flag clears after the warm-up');
});

test('an empty model name or a failing curl never blocks the lane', () => {
  const dir = stubDir('safe');
  assert.equal(run(dir, 'lane_note_gpu_pause worker-x "" T0; lane_warm_after_pause worker-x "" T0').status, 0);
  assert.deepEqual(calls(dir), [], 'no model, nothing to warm');
  const r = run(dir, 'lane_note_gpu_pause worker-x m T0; lane_warm_after_pause worker-x m T0; echo reached', { FAKE_CURL_FAIL: '1' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /reached/);
});

test('both daemons record the pause in the yield branch and warm up right after it, with their own model', () => {
  for (const [file, model] of [['local-worker.sh', '$HEARTBEAT_MODEL'], ['review-runner.sh', '${LOCAL_MODEL:-}']]) {
    const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
    const iLease = src.indexOf('if comfyui_lease_held');
    const iPause = src.indexOf('lane_note_gpu_pause', iLease);
    const iContinue = src.indexOf('continue\n  fi', iLease);
    const iWarm = src.indexOf('lane_warm_after_pause', iLease);
    assert.ok(iLease > 0 && iPause > iLease && iPause < iContinue, `${file}: the pause is recorded inside the lease-yield branch`);
    assert.ok(iWarm > iContinue, `${file}: the warm-up runs after the yield branch, i.e. once the lease is clear`);
    assert.ok(src.slice(iPause, iPause + 120).includes(model) && src.slice(iWarm, iWarm + 120).includes(model), `${file}: uses ${model}`);
  }
});

test('lane-health leaves a paused or warming lane alone (it probes only idle lanes), so no probe lands on a cold model', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'health-'));
  const now = Date.now();
  const write = (id, status) => fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ status, lastHeartbeat: new Date(now).toISOString() }));
  write('worker-a', 'paused'); write('worker-b', 'warming'); write('worker-c', 'idle');
  const lanes = ['a', 'b', 'c'].map((x) => ({ id: `worker-${x}`, model: 'm:1b', env: { OLLAMA_URL: `http://h${x}:11434` } }));
  const probed = [];
  const probe = async (a) => { probed.push(a.url); return { ok: true, tps: 20, totalMs: 100, error: null }; };
  await laneHealth.runDueProbes({ lanes, instancesDir: dir, pipelineDir: dir, env: {}, now, probe, leaseHeldFor: () => false });
  assert.deepEqual(probed, ['http://hc:11434']);
});

test('the Workers tab names both states in words and colours them amber', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'python', 'dashboard', 'static', 'js', 'workers-tab.js'), 'utf8');
  assert.match(src, /status === 'paused' \|\| status === 'warming'\) return 'warn'/);
  assert.match(src, /paused: GPU session/);
  assert.match(src, /resuming: model warming/);
  assert.match(src, /statusLabel\(inst\.status\)/);
});
