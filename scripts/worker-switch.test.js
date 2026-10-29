'use strict';

// The operator on/off switch (src/worker-switch.js) against the REAL scripts/local-worker.sh, in a sandbox in the style of scripts/local-worker-borrow.test.js:
// a throwaway project, a private HOME and instances dir, and an Ollama URL that refuses connections so nothing ever touches a model.
// Run: node --test scripts/worker-switch.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'local-worker.sh');
const SWITCH = path.join(__dirname, '..', 'src', 'worker-switch.js');

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-switch-'));
  const mk = (...p) => { const d = path.join(root, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
  const A = mk('A'); mk('repoA'); mk('home'); const switchDir = mk('switches'); const instancesDir = mk('instances');
  for (const d of ['pending', 'adhoc', 'drafting', 'review', 'blocked', 'done']) mk('A', 'queue', d);
  fs.writeFileSync(path.join(A, 'task-domains.json'), '{}');
  const projectsPath = path.join(root, 'projects.json');
  fs.writeFileSync(projectsPath, JSON.stringify([{ repoRoot: path.join(root, 'repoA'), pipelineDir: A, domainsPath: path.join(A, 'task-domains.json'), label: 'A' }]));
  const taskFile = path.join(A, 'queue', 'pending', 'waiting-task.json');
  fs.writeFileSync(taskFile, JSON.stringify({ id: 'waiting-task', domain: 'default', source: 'trouble_log', title: 't', promptContext: {} }));
  const env = {
    ...process.env,
    HOME: path.join(root, 'home'),
    OLLAMA_URL: 'http://127.0.0.1:9', MODEL_URL: 'http://127.0.0.1:9', LOCAL_MODEL: 'x',
    AGENT_MANAGER_TASK_SOURCES: 'none-such',
    AGENT_MANAGER_PROJECTS_PATH: projectsPath,
    AGENT_MANAGER_POOL_STATE_PATH: path.join(root, 'pool-state.json'),
    AGENT_MANAGER_REPO_ROOT: path.join(root, 'repoA'),
    AGENT_MANAGER_PIPELINE_DIR: A,
    AGENT_MANAGER_DOMAINS_PATH: path.join(A, 'task-domains.json'),
    AGENT_MANAGER_INSTANCES_DIR: instancesDir,
    AGENT_MANAGER_DISABLED_WORKERS_DIR: switchDir,
    AGENT_MANAGER_SWITCHED_OFF_PAUSE_S: '1',
    AGENT_MANAGER_ENDPOINT_PROBE: 'off',
    AGENT_MANAGER_POOL_BORROW: 'false',
  };
  const cli = (...args) => spawnSync(process.execPath, [SWITCH, ...args], { env, encoding: 'utf8' });
  return { root, A, env, instancesDir, taskFile, switchDir, cli, heartbeat: () => { try { return JSON.parse(fs.readFileSync(path.join(instancesDir, 'worker-x.json'), 'utf8')); } catch { return null; } } };
}

const waitFor = async (fn, ms = 60000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 250)); }
  return null;
};

function startDaemon(sb, logPath) {
  const log = fs.openSync(logPath, 'a');
  return spawn('bash', [SCRIPT, 'worker-x'], { detached: true, stdio: ['ignore', log, log], env: sb.env });
}
const killGroup = (child) => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } };

test('a --once tick on a switched-off worker exits 0 quickly, claims nothing, heartbeats disabled and says so', () => {
  const sb = sandbox();
  assert.equal(sb.cli('disable', 'worker-x').status, 0);
  const r = spawnSync('bash', [SCRIPT, 'worker-x', '--once'], { encoding: 'utf8', timeout: 60000, env: sb.env });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /\[worker-worker-x\] switched off by the operator \(Workers tab\) -- claiming nothing until it is switched back on\./);
  assert.equal(sb.heartbeat().status, 'disabled');
  assert.ok(fs.existsSync(sb.taskFile), 'the waiting task was not claimed');
  assert.deepEqual(fs.readdirSync(path.join(sb.A, 'queue', 'drafting')), []);
});

test('a daemon switched off keeps heartbeating disabled and claims nothing across several ticks, then claims once it is switched back on', async () => {
  const sb = sandbox();
  const logPath = path.join(sb.root, 'worker.log');
  assert.equal(sb.cli('disable', 'worker-x').status, 0);
  const child = startDaemon(sb, logPath);
  try {
    assert.ok(await waitFor(() => sb.heartbeat() && sb.heartbeat().status === 'disabled'), 'it reports disabled');
    await new Promise((r) => setTimeout(r, 3500));
    assert.equal(sb.heartbeat().status, 'disabled', 'still disabled after several ticks');
    assert.ok(fs.existsSync(sb.taskFile), 'nothing was claimed while off');
    assert.deepEqual(fs.readdirSync(path.join(sb.A, 'queue', 'drafting')), []);
    const log = fs.readFileSync(logPath, 'utf8');
    assert.equal((log.match(/switched off by the operator/g) || []).length, 1, 'the off line prints once, not every tick');
    assert.ok(!/claiming waiting-task/.test(log));

    assert.equal(sb.cli('enable', 'worker-x').status, 0);
    assert.ok(await waitFor(() => /switched back on after \d+ tick\(s\) off; resuming\./.test(fs.readFileSync(logPath, 'utf8'))), 'it says it is back on');
    assert.ok(await waitFor(() => /claiming waiting-task/.test(fs.readFileSync(logPath, 'utf8'))), 'it claims the waiting task once on');
    assert.notEqual(sb.heartbeat().status, 'disabled');
  } finally {
    killGroup(child);
  }
});

test('a worker that was never switched off claims normally (the guard is inert), and switching one worker off does not affect another id', async () => {
  const sb = sandbox();
  const logPath = path.join(sb.root, 'worker.log');
  assert.equal(sb.cli('disable', 'worker-other').status, 0);
  const child = startDaemon(sb, logPath);
  try {
    assert.ok(await waitFor(() => /claiming waiting-task/.test(fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '')), 'worker-x is unaffected by worker-other being off');
    assert.ok(!/switched off by the operator/.test(fs.readFileSync(logPath, 'utf8')));
  } finally {
    killGroup(child);
  }
});

test('a broken switch never stalls a worker: with node unable to run the switch the worker is treated as on', () => {
  const sb = sandbox();
  const r = spawnSync('/bin/bash', ['-c', 'source "$1"; worker_switched_off worker-x; echo "exit=$?"', 'bash', path.join(__dirname, 'agent-manager-common.sh')], {
    encoding: 'utf8', env: { ...sb.env, PATH: '/nonexistent-bin' },
  });
  const code = Number((r.stdout.match(/exit=(\d+)/) || [])[1]);
  assert.ok(Number.isInteger(code) && code !== 0, `any failure to read the switch must be a non-zero exit (only 0 means switched off), got ${r.stdout}`);
});
