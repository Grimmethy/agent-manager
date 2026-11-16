'use strict';

// local-worker.sh calls reload_lane_rules (scripts/agent-manager-common.sh) once per tick, so a lanes.json edit to a lane's taskClasses reaches the running worker
// without a restart, and an unchanged lanes.json costs no re-read. Run for real in a sandbox like local-worker-task-sources-dedupe.test.js: a throwaway project, a private
// HOME and TMPDIR (the per-instance stamp lives in TMPDIR), an Ollama URL that refuses connections, and a private lanes.json.
// Run: node --test scripts/local-worker-lane-rules.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'local-worker.sh');
const ID = 'worker-cloud';
const LINE = /lane rules: taskClasses=([^ ]*) reviews=/g;

function lanesJson(taskClasses) {
  return JSON.stringify([{ gpu: 'cloud', ollamaUrl: 'http://127.0.0.1:9', model: 'haiku', provider: 'cloud', preempt: 'never', taskClasses }]);
}

function sandbox(taskClasses = ['adhoc']) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-rules-'));
  const mk = (...p) => { const d = path.join(root, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
  const A = mk('A'); mk('repoA'); mk('home'); mk('tmp'); mk('switch');
  for (const d of ['pending', 'adhoc', 'drafting', 'review', 'blocked', 'done']) mk('A', 'queue', d);
  fs.writeFileSync(path.join(A, 'task-domains.json'), '{}');
  const projectsPath = path.join(root, 'projects.json');
  fs.writeFileSync(projectsPath, JSON.stringify([{ repoRoot: path.join(root, 'repoA'), pipelineDir: A, domainsPath: path.join(A, 'task-domains.json'), label: 'A' }]));
  const lanesPath = path.join(root, 'lanes.json');
  fs.writeFileSync(lanesPath, lanesJson(taskClasses));
  const env = {
    ...process.env,
    HOME: path.join(root, 'home'), TMPDIR: path.join(root, 'tmp'), TEMP_DIR: path.join(root, 'tmp'),
    OLLAMA_URL: 'http://127.0.0.1:9', MODEL_URL: 'http://127.0.0.1:9', LOCAL_MODEL: 'x',
    AGENT_MANAGER_LANES_PATH: lanesPath, AGENT_MANAGER_LOCAL_GPU: 'testgpu', AGENT_MANAGER_DISABLED_WORKERS_DIR: path.join(root, 'switch'),
    AGENT_MANAGER_TASK_SOURCES: 'none-such', AGENT_MANAGER_PROJECTS_PATH: projectsPath, AGENT_MANAGER_POOL_STATE_PATH: path.join(root, 'pool-state.json'),
    ORC_TICK_SECS: '2', AGENT_MANAGER_ENDPOINT_PROBE: 'off', AGENT_MANAGER_POOL_BORROW: 'false',
    AGENT_MANAGER_REPO_ROOT: path.join(root, 'repoA'), AGENT_MANAGER_PIPELINE_DIR: A, AGENT_MANAGER_INSTANCES_DIR: path.join(A, 'instances'), AGENT_MANAGER_DOMAINS_PATH: path.join(A, 'task-domains.json'),
  };
  delete env.AGENT_MANAGER_INSTANCE_ID;
  // One tick; returns the taskClasses values of the "lane rules:" lines it printed.
  const tick = () => {
    const r = spawnSync('bash', [SCRIPT, ID, '--once'], { encoding: 'utf8', env, timeout: 120000 });
    assert.equal(r.status, 0, r.stderr);
    return [...(`${r.stderr}\n${r.stdout}`).matchAll(LINE)].map((m) => m[1]);
  };
  // Rewrites lanes.json after ageing the stamp 10 s into the past, so the edit is newer than the stamp without relying on timestamp granularity or a future mtime.
  const rewrite = (classes) => {
    const stamp = path.join(root, 'tmp', `lane-rules-${ID}.stamp`);
    const past = new Date(Date.now() - 10000);
    fs.utimesSync(stamp, past, past);
    fs.writeFileSync(lanesPath, lanesJson(classes));
  };
  return { root, env, tick, rewrite, lanesPath };
}

test('first tick reads the lane rules once and logs them', () => {
  const s = sandbox(['adhoc']);
  assert.deepEqual(s.tick(), ['adhoc']);
});

test('a second tick with lanes.json untouched does not re-read it', () => {
  const s = sandbox(['adhoc']);
  assert.deepEqual(s.tick(), ['adhoc']);
  assert.deepEqual(s.tick(), []);
  assert.deepEqual(s.tick(), []);
});

test('editing lanes.json changes the rules on the next tick, without a restart', () => {
  const s = sandbox(['adhoc']);
  assert.deepEqual(s.tick(), ['adhoc']);
  s.rewrite(['adhoc', 'change_review']);
  assert.deepEqual(s.tick(), ['adhoc,change_review']);
  assert.deepEqual(s.tick(), []);
});

test('a worker switched off reads no lane rules', () => {
  const s = sandbox(['adhoc']);
  fs.writeFileSync(path.join(s.root, 'switch', ID), '{}');
  const r = spawnSync('bash', [SCRIPT, ID, '--once'], { encoding: 'utf8', env: s.env, timeout: 120000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /switched off/);
  assert.doesNotMatch(`${r.stderr}${r.stdout}`, /lane rules:/);
  fs.rmSync(path.join(s.root, 'switch', ID));
  assert.deepEqual(s.tick(), ['adhoc'], 'switched back on, the first tick that runs reads the rules');
});
