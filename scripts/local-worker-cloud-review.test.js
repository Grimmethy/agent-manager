'use strict';

// A cloud worker reviews before it drafts (cloud_take_review in scripts/agent-manager-common.sh, called from the local-worker.sh tick): an item in queue/review/ with no live claim
// is reviewed first, by ONE `review-runner.sh reviewer-<gpu> --once`; a review that is already claimed, no review at all, `reviews: false`, a non-cloud worker, a dial-off lane and a
// premium-only borrowed tick all go on to the normal draft path. Real --once ticks in a sandbox with a FAKE runner (AGENT_MANAGER_CLOUD_REVIEW_RUNNER) that logs its arguments and
// exits with a code from a file, so no model is ever called.
// Run: node --test scripts/local-worker-cloud-review.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'local-worker.sh');
const COMMON = path.join(__dirname, 'agent-manager-common.sh');

function sandbox({ lane = {}, runnerExit = 10 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-review-'));
  const mk = (...p) => { const d = path.join(root, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
  const A = mk('A'); mk('repoA'); mk('home'); mk('tmp');
  for (const d of ['pending', 'adhoc', 'drafting', 'review', 'blocked', 'done']) mk('A', 'queue', d);
  fs.writeFileSync(path.join(A, 'task-domains.json'), '{}');
  const projectsPath = path.join(root, 'projects.json');
  fs.writeFileSync(projectsPath, JSON.stringify([{ repoRoot: path.join(root, 'repoA'), pipelineDir: A, domainsPath: path.join(A, 'task-domains.json'), label: 'A' }]));
  const lanesPath = path.join(root, 'lanes.json');
  // One endpoint per lane: the registry refuses two lanes on one.
  fs.writeFileSync(lanesPath, JSON.stringify(['cloud', 'cloud2', 'cloud3'].map((gpu, i) => ({ gpu, ollamaUrl: `http://127.0.0.1:${9 - i}`, model: 'haiku', provider: 'cloud', preempt: 'never', ...(gpu === 'cloud3' ? lane : {}) }))));
  const runnerLog = path.join(root, 'runner.log');
  const exitFile = path.join(root, 'runner.exit');
  fs.writeFileSync(exitFile, String(runnerExit));
  const runner = path.join(root, 'fake-runner.sh');
  fs.writeFileSync(runner, `#!/bin/bash\necho "$* | OLLAMA_URL=\${OLLAMA_URL:-} LOCAL_MODEL=\${LOCAL_MODEL:-}" >> "${runnerLog}"\nexit "$(cat "${exitFile}")"\n`, { mode: 0o755 });
  const dialPath = path.join(root, 'state', 'cloud-dial.json');
  const env = {
    ...process.env,
    HOME: path.join(root, 'home'), TMPDIR: path.join(root, 'tmp'), TEMP_DIR: path.join(root, 'tmp'),
    OLLAMA_URL: 'http://127.0.0.1:9', MODEL_URL: 'http://127.0.0.1:9', LOCAL_MODEL: 'x',
    AGENT_MANAGER_LANES_PATH: lanesPath, AGENT_MANAGER_CLOUD_DIAL_PATH: dialPath, AGENT_MANAGER_LOCAL_GPU: 'testgpu',
    AGENT_MANAGER_CLOUD_REVIEW_RUNNER: runner, AGENT_MANAGER_DISABLED_WORKERS_DIR: path.join(root, 'switch'),
    AGENT_MANAGER_TASK_SOURCES: 'none-such', AGENT_MANAGER_PROJECTS_PATH: projectsPath, AGENT_MANAGER_POOL_STATE_PATH: path.join(root, 'pool-state.json'),
    ORC_TICK_SECS: '2', AGENT_MANAGER_ENDPOINT_PROBE: 'off', AGENT_MANAGER_POOL_BORROW: 'false',
    AGENT_MANAGER_REPO_ROOT: path.join(root, 'repoA'), AGENT_MANAGER_PIPELINE_DIR: A, AGENT_MANAGER_INSTANCES_DIR: path.join(A, 'instances'), AGENT_MANAGER_DOMAINS_PATH: path.join(A, 'task-domains.json'),
  };
  delete env.AGENT_MANAGER_INSTANCE_ID;
  const item = (name = 'r1.json') => fs.writeFileSync(path.join(A, 'queue', 'review', name), '{"id":"r1"}');
  const claim = (name, owner) => {
    const d = path.join(A, 'instances', 'review-claims', `${name}.d`); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'owner'), owner);
  };
  const calls = () => (fs.existsSync(runnerLog) ? fs.readFileSync(runnerLog, 'utf8').trim().split('\n').filter(Boolean) : []);
  const tick = (id, extraEnv = {}) => {
    const r = spawnSync('bash', [SCRIPT, id, '--once'], { encoding: 'utf8', env: { ...env, ...extraEnv }, timeout: 120000 });
    let hb = {};
    try { hb = JSON.parse(fs.readFileSync(path.join(A, 'instances', `${id}.json`), 'utf8')); } catch (e) { /* none */ }
    return { status: r.status, stderr: r.stderr, hb };
  };
  return { root, A, env, item, claim, calls, tick, dialPath };
}

test('an unclaimed review is reviewed first: one runner call as reviewer-<gpu> --once under the lane env, the tick ends with exit 10 and a review heartbeat', () => {
  const s = sandbox();
  s.item();
  const t = s.tick('worker-cloud3');
  assert.equal(t.status, 10, t.stderr);
  const calls = s.calls();
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^reviewer-cloud3 --once \| OLLAMA_URL=http:\/\/127\.0\.0\.1:\d LOCAL_MODEL=/);
  assert.equal(t.hb.currentPass, 'review');
});

test('a review whose claim is held by a live pid is left alone and the worker goes on to its normal tick', () => {
  const s = sandbox();
  s.item();
  s.claim('r1.json', `${process.pid} reviewer`);
  const t = s.tick('worker-cloud3');
  assert.equal(t.status, 0, t.stderr);
  assert.equal(s.calls().length, 0);
});

test('a stale claim (dead pid) does not hide the review', () => {
  const s = sandbox();
  s.item();
  s.claim('r1.json', '2147483646 reviewer');
  assert.equal(s.tick('worker-cloud3').status, 10);
  assert.equal(s.calls().length, 1);
});

test('when the runner finds nothing to review (exit 0) the worker carries on to draft in the same tick', () => {
  const s = sandbox({ runnerExit: 0 });
  s.item();
  const t = s.tick('worker-cloud3');
  assert.equal(t.status, 0, t.stderr);
  assert.equal(s.calls().length, 1);
});

test('no review waiting: the runner is not called', () => {
  const s = sandbox();
  const t = s.tick('worker-cloud3');
  assert.equal(t.status, 0, t.stderr);
  assert.equal(s.calls().length, 0);
});

test('reviews:false on the lane never reviews', () => {
  const s = sandbox({ lane: { reviews: false } });
  s.item();
  const t = s.tick('worker-cloud3');
  assert.equal(t.status, 0, t.stderr);
  assert.equal(s.calls().length, 0);
});

test('a non-cloud worker never reviews', () => {
  const s = sandbox();
  s.item();
  const t = s.tick('worker-x');
  assert.equal(t.status, 0, t.stderr);
  assert.equal(s.calls().length, 0);
});

test('a lane the dial turned off does not review, and a premium-only borrowed tick does not review', () => {
  const s = sandbox();
  s.item();
  fs.mkdirSync(path.dirname(s.dialPath), { recursive: true });
  fs.writeFileSync(s.dialPath, JSON.stringify({ count: 0, mode: 'manual' }));
  assert.equal(s.tick('worker-cloud3').status, 0);
  assert.equal(s.calls().length, 0, 'dial off');
  fs.rmSync(s.dialPath);
  const t = s.tick('worker-cloud3', { AGENT_MANAGER_PREMIUM_ONLY_TICK: 'true' });
  assert.equal(t.status, 0, t.stderr);
  assert.equal(s.calls().length, 0, 'premium-only tick');
});

test('cloud_take_review spawns no node when queue/review/ holds no .json file, and exactly one when it does', () => {
  const s = sandbox({ runnerExit: 0 });
  const bin = path.join(s.root, 'bin'); fs.mkdirSync(bin);
  const log = path.join(s.root, 'node-calls.log');
  fs.writeFileSync(path.join(bin, 'node'), `#!/bin/bash\necho "$@" >> "${log}"\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
  const run = () => spawnSync('bash', ['-c', `source "${COMMON}"; PIPELINE_DIR="${s.A}"; QUEUE_DIR="${s.A}/queue"; INSTANCES_DIR="${s.A}/instances"; HEARTBEAT_MODEL=m; cloud_take_review worker-cloud3 && echo took || echo skipped`], { encoding: 'utf8', env: { ...s.env, PATH: `${bin}:${process.env.PATH}` } });
  const asks = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter((l) => /review-unclaimed\.js/.test(l)).length : 0);
  assert.equal(run().stdout.trim(), 'skipped');
  assert.equal(asks(), 0, 'empty review/: no node');
  s.item();
  const r = run();
  assert.equal(asks(), 1, 'one ask when a .json waits: ' + r.stderr);
  assert.equal(r.stdout.trim(), 'skipped', 'the fake runner exited 0, so nothing was reviewed');
});
