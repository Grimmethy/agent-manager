'use strict';

// The cloud review-first gate, asserted on claim outcome as well as on the runner's invocation.
// cloud_take_review (scripts/agent-manager-common.sh, called from the local-worker.sh tick) runs ONE
// `review-runner.sh reviewer-<gpu> --once` for an unclaimed item in queue/review/. A live claim, no
// review, `reviews: false` and a non-cloud worker all let the tick go on to claim a pending draft.
// Real --once ticks in a sandbox with a FAKE runner (AGENT_MANAGER_CLOUD_REVIEW_RUNNER) that logs its
// arguments and exits with a code from a file, so no model is ever called. The draft step itself
// points at a closed port, so a claimed task fails fast there; the claim is what each case asserts.
// Run: node --test scripts/local-worker-review.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'local-worker.sh');

function sandbox({ lane = {}, runnerExit = 10 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-gate-'));
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
  fs.writeFileSync(runner, `#!/bin/bash\necho "$*" >> "${runnerLog}"\nexit "$(cat "${exitFile}")"\n`, { mode: 0o755 });
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
  // A draftable task waiting in pending/.
  const pending = (name = 't1') => fs.writeFileSync(path.join(A, 'queue', 'pending', `${name}.json`), JSON.stringify({ id: name, source: 'adhoc', title: name }));
  // A review waiting in review/.
  const item = (name = 'r1.json') => fs.writeFileSync(path.join(A, 'queue', 'review', name), '{"id":"r1"}');
  const claim = (name, owner) => {
    const d = path.join(A, 'instances', 'review-claims', `${name}.d`); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'owner'), owner);
  };
  // Runner invocations, one line per call.
  const calls = () => (fs.existsSync(runnerLog) ? fs.readFileSync(runnerLog, 'utf8').trim().split('\n').filter(Boolean) : []);
  // Claim state: which lane folder holds the draftable task, and whether it is still in pending/.
  const claimedBy = (lane, name = 't1') => fs.existsSync(path.join(A, 'queue', 'drafting', lane, `${name}.json`));
  const stillPending = (name = 't1') => fs.existsSync(path.join(A, 'queue', 'pending', `${name}.json`));
  const tick = (id, extraEnv = {}) => {
    const r = spawnSync('bash', [SCRIPT, id, '--once'], { encoding: 'utf8', env: { ...env, ...extraEnv }, timeout: 120000 });
    return { status: r.status, stderr: r.stderr };
  };
  return { root, A, env, pending, item, claim, calls, claimedBy, stillPending, tick, dialPath };
}

test('an unclaimed review runs first: the runner is invoked once and no pending draft is claimed', () => {
  const s = sandbox();
  s.pending();
  s.item();
  const t = s.tick('worker-cloud3');
  assert.equal(t.status, 10, t.stderr);
  const calls = s.calls();
  assert.equal(calls.length, 1, 'runner invocations');
  assert.match(calls[0], /^reviewer-cloud3 --once/);
  assert.equal(s.claimedBy('worker-cloud3'), false, 'no draft claimed while the review ran');
  assert.equal(s.stillPending(), true, 'draft still sits in pending/');
});

test('a review whose claim is held by a live pid is left alone, and the worker claims the draft', () => {
  const s = sandbox();
  s.pending();
  s.item();
  s.claim('r1.json', `${process.pid} reviewer`);
  s.tick('worker-cloud3');
  assert.equal(s.calls().length, 0, 'runner not invoked');
  assert.equal(s.claimedBy('worker-cloud3'), true, 'draft claimed into drafting/worker-cloud3/');
  assert.equal(s.stillPending(), false, 'draft left pending/');
});

test('no reviews waiting: the runner is not invoked and the worker claims the draft', () => {
  const s = sandbox();
  s.pending();
  s.tick('worker-cloud3');
  assert.equal(s.calls().length, 0, 'runner not invoked');
  assert.equal(s.claimedBy('worker-cloud3'), true, 'draft claimed into drafting/worker-cloud3/');
  assert.equal(s.stillPending(), false, 'draft left pending/');
});

test('reviews:false on the lane never invokes the runner, and the worker claims the draft', () => {
  const s = sandbox({ lane: { reviews: false } });
  s.pending();
  s.item();
  s.tick('worker-cloud3');
  assert.equal(s.calls().length, 0, 'runner not invoked');
  assert.equal(s.claimedBy('worker-cloud3'), true, 'draft claimed into drafting/worker-cloud3/');
  assert.equal(s.stillPending(), false, 'draft left pending/');
});

test('a non-cloud worker never invokes the runner, and it claims the draft', () => {
  const s = sandbox();
  s.pending();
  s.item();
  s.tick('worker-x');
  assert.equal(s.calls().length, 0, 'runner not invoked');
  assert.equal(s.claimedBy('worker-x'), true, 'draft claimed into drafting/worker-x/');
  assert.equal(s.stillPending(), false, 'draft left pending/');
});
