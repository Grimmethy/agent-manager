'use strict';

// local-worker.sh asks cloud_dial_off (scripts/agent-manager-common.sh) once per tick: a cloud lane ranked past the cloud-agent dial count claims nothing and heartbeats
// status disabled with pass "dial". Real --once ticks in a sandbox (a throwaway project, a private HOME, a private lanes.json with three cloud lanes and a private dial file),
// plus a bash harness for the no-respawn rule of cloud_dial_off itself.
// Run: node --test scripts/local-worker-cloud-dial.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'local-worker.sh');
const COMMON = path.join(__dirname, 'agent-manager-common.sh');
const OFF_LINE = /turned off by the cloud-agent dial/;

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-dial-worker-'));
  const mk = (...p) => { const d = path.join(root, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
  const A = mk('A'); mk('repoA'); mk('home'); mk('tmp');
  for (const d of ['pending', 'adhoc', 'drafting', 'review', 'blocked', 'done']) mk('A', 'queue', d);
  fs.writeFileSync(path.join(A, 'task-domains.json'), '{}');
  const projectsPath = path.join(root, 'projects.json');
  fs.writeFileSync(projectsPath, JSON.stringify([{ repoRoot: path.join(root, 'repoA'), pipelineDir: A, domainsPath: path.join(A, 'task-domains.json'), label: 'A' }]));
  const lanesPath = path.join(root, 'lanes.json');
  // The registry refuses two lanes on one endpoint, so each cloud lane gets its own port.
  fs.writeFileSync(lanesPath, JSON.stringify(['cloud', 'cloud2', 'cloud3'].map((gpu, i) => ({ gpu, ollamaUrl: `http://127.0.0.1:${9 - i}`, model: 'haiku', provider: 'cloud', preempt: 'never' }))));
  const dialPath = path.join(root, 'state', 'cloud-dial.json');
  const env = {
    ...process.env,
    HOME: path.join(root, 'home'), TMPDIR: path.join(root, 'tmp'), TEMP_DIR: path.join(root, 'tmp'),
    OLLAMA_URL: 'http://127.0.0.1:9', MODEL_URL: 'http://127.0.0.1:9', LOCAL_MODEL: 'x',
    AGENT_MANAGER_LANES_PATH: lanesPath, AGENT_MANAGER_CLOUD_DIAL_PATH: dialPath, AGENT_MANAGER_LOCAL_GPU: 'testgpu',
    AGENT_MANAGER_DISABLED_WORKERS_DIR: path.join(root, 'switch'),
    AGENT_MANAGER_TASK_SOURCES: 'none-such', AGENT_MANAGER_PROJECTS_PATH: projectsPath, AGENT_MANAGER_POOL_STATE_PATH: path.join(root, 'pool-state.json'),
    ORC_TICK_SECS: '2', AGENT_MANAGER_ENDPOINT_PROBE: 'off', AGENT_MANAGER_POOL_BORROW: 'false',
    AGENT_MANAGER_REPO_ROOT: path.join(root, 'repoA'), AGENT_MANAGER_PIPELINE_DIR: A, AGENT_MANAGER_INSTANCES_DIR: path.join(A, 'instances'), AGENT_MANAGER_DOMAINS_PATH: path.join(A, 'task-domains.json'),
  };
  delete env.AGENT_MANAGER_INSTANCE_ID;
  const setDial = (count) => { fs.mkdirSync(path.dirname(dialPath), { recursive: true }); fs.writeFileSync(dialPath, JSON.stringify({ count, mode: 'manual' })); };
  // One tick of one worker. Returns whether the dial turned it off and its heartbeat.
  const tick = (id) => {
    const r = spawnSync('bash', [SCRIPT, id, '--once'], { encoding: 'utf8', env, timeout: 120000 });
    assert.equal(r.status, 0, r.stderr);
    let hb = {};
    try { hb = JSON.parse(fs.readFileSync(path.join(A, 'instances', `${id}.json`), 'utf8')); } catch (e) { /* none written */ }
    return { off: OFF_LINE.test(r.stderr + r.stdout), status: hb.status, pass: hb.currentPass, stderr: r.stderr };
  };
  return { root, env, setDial, tick, dialPath };
}

test('no dial file: every cloud worker ticks normally and is never turned off', () => {
  const s = sandbox();
  for (const id of ['worker-cloud', 'worker-cloud2', 'worker-cloud3']) {
    const t = s.tick(id);
    assert.equal(t.off, false, id);
    assert.notEqual(t.status, 'disabled', id);
  }
});

test('count 2: worker-cloud and worker-cloud2 run, worker-cloud3 heartbeats disabled with pass dial', () => {
  const s = sandbox();
  s.setDial(2);
  assert.equal(s.tick('worker-cloud').off, false);
  assert.equal(s.tick('worker-cloud2').off, false);
  const t = s.tick('worker-cloud3');
  assert.equal(t.off, true);
  assert.equal(t.status, 'disabled');
  assert.equal(t.pass, 'dial');
});

test('count 0 turns every cloud worker off; raising the count lets the next tick run again', () => {
  const s = sandbox();
  s.setDial(0);
  for (const id of ['worker-cloud', 'worker-cloud2', 'worker-cloud3']) assert.equal(s.tick(id).off, true, id);
  s.setDial(3);
  for (const id of ['worker-cloud', 'worker-cloud2', 'worker-cloud3']) {
    const t = s.tick(id);
    assert.equal(t.off, false, id);
    assert.notEqual(t.status, 'disabled', id);
  }
});

test('a worker that is not a cloud lane ignores the dial', () => {
  const s = sandbox();
  s.setDial(0);
  const t = s.tick('worker-x');
  assert.equal(t.off, false);
  assert.notEqual(t.pass, 'dial');
});

test('a malformed dial file never turns a lane off', () => {
  const s = sandbox();
  fs.mkdirSync(path.dirname(s.dialPath), { recursive: true });
  fs.writeFileSync(s.dialPath, '{not json');
  assert.equal(s.tick('worker-cloud3').off, false);
});

// cloud_dial_off in one shell across several "ticks", with a stub node on PATH that counts how often src/cloud-dial.js is asked.
test('cloud_dial_off with a dial file: one spawn for three steady ticks, a second after the file changes', () => {
  const s = sandbox();
  s.setDial(1);
  const bin = path.join(s.root, 'bin'); fs.mkdirSync(bin);
  const log = path.join(s.root, 'node-calls.log');
  fs.writeFileSync(path.join(bin, 'node'), `#!/bin/bash\necho "$@" >> "${log}"\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
  const script = `source "${COMMON}"
    for i in 1 2 3; do cloud_dial_off worker-cloud3 && echo off || echo on; done
    sleep 1.1
    echo '{"count":3}' > "${s.dialPath}"
    for i in 1 2; do cloud_dial_off worker-cloud3 && echo off || echo on; done`;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...s.env, PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n'), ['off', 'off', 'off', 'on', 'on']);
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').filter((l) => /cloud-dial\.js is-off/.test(l));
  assert.equal(calls.length, 2, 'one ask for the first three ticks, one after the dial file changed');
});

test('cloud_dial_off spawns no node for a non-cloud worker, nor for a cloud worker when there is no dial file', () => {
  const s = sandbox();
  const bin = path.join(s.root, 'bin'); fs.mkdirSync(bin);
  const log = path.join(s.root, 'node-calls.log');
  fs.writeFileSync(path.join(bin, 'node'), `#!/bin/bash\necho "$@" >> "${log}"\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
  const run = (body) => spawnSync('bash', ['-c', `source "${COMMON}"; ${body}`], { encoding: 'utf8', env: { ...s.env, PATH: `${bin}:${process.env.PATH}` } });
  const asks = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter((l) => /cloud-dial\.js/.test(l)).length : 0);
  let r = run('for i in 1 2 3; do cloud_dial_off worker-cloud3 && echo off || echo on; done');
  assert.deepEqual(r.stdout.trim().split('\n'), ['on', 'on', 'on']);
  assert.equal(asks(), 0, 'no dial file: no spawn');
  s.setDial(0);
  r = run('for id in worker-3090 worker-p40 worker-cloudy worker-x; do cloud_dial_off $id && echo off || echo on; done');
  assert.deepEqual(r.stdout.trim().split('\n'), ['on', 'on', 'on', 'on']);
  assert.equal(asks(), 0, 'non-cloud workers: no spawn even with a dial file');
});
