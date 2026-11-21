'use strict';

// A worker that yields its tick because host RAM is exhausted (mem_pressure_high) now records that in its heartbeat: status paused, pass ram. Before this the hold was only a log line,
// so nothing could count lanes "held for RAM" (feature cloud-agent-pool, the cloud-dial counts). Real --once ticks in a sandbox; the memory-pressure marker is a private file.
// Run: node --test scripts/local-worker-ram-hold.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'local-worker.sh');

function sandbox(markerState) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ram-hold-'));
  const mk = (...p) => { const d = path.join(root, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
  const A = mk('A'); mk('repoA'); mk('home'); mk('tmp');
  for (const d of ['pending', 'adhoc', 'drafting', 'review', 'blocked', 'done']) mk('A', 'queue', d);
  fs.writeFileSync(path.join(A, 'task-domains.json'), '{}');
  const projectsPath = path.join(root, 'projects.json');
  fs.writeFileSync(projectsPath, JSON.stringify([{ repoRoot: path.join(root, 'repoA'), pipelineDir: A, domainsPath: path.join(A, 'task-domains.json'), label: 'A' }]));
  const marker = path.join(root, 'mem-marker.json');
  if (markerState) fs.writeFileSync(marker, JSON.stringify({ state: markerState, reason: 'test' }));
  const env = {
    ...process.env,
    HOME: path.join(root, 'home'), TMPDIR: path.join(root, 'tmp'), TEMP_DIR: path.join(root, 'tmp'),
    OLLAMA_URL: 'http://127.0.0.1:9', MODEL_URL: 'http://127.0.0.1:9', LOCAL_MODEL: 'x',
    AGENT_MANAGER_MEM_PRESSURE_MARKER: marker, AGENT_MANAGER_LOCAL_GPU: 'testgpu',
    AGENT_MANAGER_DISABLED_WORKERS_DIR: path.join(root, 'switch'),
    AGENT_MANAGER_TASK_SOURCES: 'none-such', AGENT_MANAGER_PROJECTS_PATH: projectsPath, AGENT_MANAGER_POOL_STATE_PATH: path.join(root, 'pool-state.json'),
    ORC_TICK_SECS: '2', AGENT_MANAGER_ENDPOINT_PROBE: 'off', AGENT_MANAGER_POOL_BORROW: 'false',
    AGENT_MANAGER_REPO_ROOT: path.join(root, 'repoA'), AGENT_MANAGER_PIPELINE_DIR: A, AGENT_MANAGER_INSTANCES_DIR: path.join(A, 'instances'), AGENT_MANAGER_DOMAINS_PATH: path.join(A, 'task-domains.json'),
  };
  delete env.AGENT_MANAGER_INSTANCE_ID;
  const tick = (id) => {
    const r = spawnSync('bash', [SCRIPT, id, '--once'], { encoding: 'utf8', env, timeout: 120000 });
    assert.equal(r.status, 0, r.stderr);
    let hb = {};
    try { hb = JSON.parse(fs.readFileSync(path.join(A, 'instances', `${id}.json`), 'utf8')); } catch (e) { /* none */ }
    return { stderr: r.stderr, hb };
  };
  return { tick };
}

test('critical memory pressure: the worker yields and its heartbeat says paused with pass ram', () => {
  const t = sandbox('critical').tick('worker-cloud3');
  assert.match(t.stderr, /yielding this tick -- host RAM pressure/);
  assert.equal(t.hb.status, 'paused');
  assert.equal(t.hb.currentPass, 'ram');
  assert.equal(t.hb.currentTaskId, null);
});

test('no memory pressure: no yield line and the heartbeat is not a RAM hold', () => {
  const t = sandbox('ok').tick('worker-cloud3');
  assert.doesNotMatch(t.stderr, /yielding this tick -- host RAM pressure/);
  assert.notEqual(t.hb.currentPass, 'ram');
});

test('every worker lane records the hold, cloud or not', () => {
  const s = sandbox('critical');
  for (const id of ['worker-cloud', 'worker-x']) {
    const t = s.tick(id);
    assert.equal(t.hb.status, 'paused', id);
    assert.equal(t.hb.currentPass, 'ram', id);
  }
});
