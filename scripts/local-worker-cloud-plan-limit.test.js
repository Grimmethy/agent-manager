'use strict';

// local-worker.sh asks cloud_plan_limited (scripts/agent-manager-common.sh) once per tick, right after the cloud-agent dial: a cloud lane whose gateway is at its plan limit claims nothing and
// heartbeats status disabled with pass "planlimit"; a healthy or unreachable gateway ticks normally (fails open). Real --once ticks in a sandbox (a throwaway project, a private HOME and a
// private lanes.json whose cloud lane points at a tiny local http server standing in for the gateway), plus a bash harness for cloud_plan_limited itself.
// Run: node --test scripts/local-worker-cloud-plan-limit.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SCRIPT = path.join(__dirname, 'local-worker.sh');
const COMMON = path.join(__dirname, 'agent-manager-common.sh');
const HOLD_LINE = /gateway is at its plan limit/;

// A stand-in gateway: answers GET /health with `health()` (a JSON object, or a number to answer that HTTP status with no body).
function gateway(health) {
  return new Promise((resolve) => {
    const hits = [];
    const server = http.createServer((req, res) => {
      hits.push(req.url);
      const h = health();
      if (typeof h === 'number') { res.writeHead(h); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(h));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, hits, url: "http://127.0.0.1:" + server.address().port }));
  });
}

function sandbox(gatewayUrl, lane = 'cloud') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-plan-limit-worker-'));
  const mk = (...p) => { const d = path.join(root, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
  const A = mk('A'); mk('repoA'); mk('home'); mk('tmp');
  for (const d of ['pending', 'adhoc', 'drafting', 'review', 'blocked', 'done']) mk('A', 'queue', d);
  fs.writeFileSync(path.join(A, 'task-domains.json'), '{}');
  const projectsPath = path.join(root, 'projects.json');
  fs.writeFileSync(projectsPath, JSON.stringify([{ repoRoot: path.join(root, 'repoA'), pipelineDir: A, domainsPath: path.join(A, 'task-domains.json'), label: 'A' }]));
  const lanesPath = path.join(root, 'lanes.json');
  fs.writeFileSync(lanesPath, JSON.stringify([{ gpu: lane, ollamaUrl: gatewayUrl, model: 'haiku', provider: 'cloud', preempt: 'never' }]));
  const env = {
    ...process.env,
    HOME: path.join(root, 'home'), TMPDIR: path.join(root, 'tmp'), TEMP_DIR: path.join(root, 'tmp'),
    OLLAMA_URL: gatewayUrl, MODEL_URL: gatewayUrl, LOCAL_MODEL: 'x',
    AGENT_MANAGER_LANES_PATH: lanesPath, AGENT_MANAGER_CLOUD_DIAL_PATH: path.join(root, 'state', 'cloud-dial.json'), AGENT_MANAGER_LOCAL_GPU: 'testgpu',
    AGENT_MANAGER_DISABLED_WORKERS_DIR: path.join(root, 'switch'),
    AGENT_MANAGER_TASK_SOURCES: 'none-such', AGENT_MANAGER_PROJECTS_PATH: projectsPath, AGENT_MANAGER_POOL_STATE_PATH: path.join(root, 'pool-state.json'),
    ORC_TICK_SECS: '2', AGENT_MANAGER_ENDPOINT_PROBE: 'off', AGENT_MANAGER_POOL_BORROW: 'false',
    AGENT_MANAGER_REPO_ROOT: path.join(root, 'repoA'), AGENT_MANAGER_PIPELINE_DIR: A, AGENT_MANAGER_INSTANCES_DIR: path.join(A, 'instances'), AGENT_MANAGER_DOMAINS_PATH: path.join(A, 'task-domains.json'),
  };
  delete env.AGENT_MANAGER_INSTANCE_ID;
  // One --once tick of one worker. Async, so the stand-in gateway in this same process can answer while the worker runs.
  const tick = (id) => new Promise((resolve, reject) => {
    const child = spawn('bash', [SCRIPT, id, '--once'], { env });
    let out = '';
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { out += b; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('tick timed out\n' + out)); }, 120000);
    child.on('close', (code) => {
      clearTimeout(timer);
      assert.equal(code, 0, out);
      let hb = {};
      try { hb = JSON.parse(fs.readFileSync(path.join(A, 'instances', `${id}.json`), 'utf8')); } catch (e) { /* none written */ }
      resolve({ held: HOLD_LINE.test(out), status: hb.status, pass: hb.currentPass, out });
    });
  });
  return { root, A, env, tick };
}

test('a cloud lane whose gateway is at the plan limit claims nothing and heartbeats disabled with pass planlimit', async () => {
  const gw = await gateway(() => ({ ok: true, planLimit: { window: 'five-hour', resetsAt: '2999-01-01T00:00:00.000Z' } }));
  try {
    const s = sandbox(gw.url);
    const task = path.join(s.A, 'queue', 'adhoc', 'adhoc-waiting-1.json');
    fs.writeFileSync(task, JSON.stringify({ id: 'adhoc-waiting-1', title: 'waiting', status: 'pending', domain: 'default', source: 'manual', premiumPriority: true }));
    const t = await s.tick('worker-cloud');
    assert.equal(t.held, true, t.out);
    assert.equal(t.status, 'disabled');
    assert.equal(t.pass, 'planlimit');
    assert.match(t.out, /2999-01-01T00:00:00\.000Z/);
    assert.ok(fs.existsSync(task), 'the task stays where it was: nothing was claimed');
    assert.equal(fs.readdirSync(path.join(s.A, 'queue', 'drafting')).length, 0);
    assert.ok(gw.hits.includes('/health'));
  } finally { gw.server.close(); }
});

test('a limit with no resetsAt still holds the lane and says until unknown', async () => {
  const gw = await gateway(() => ({ planLimit: { window: 'five-hour' } }));
  try {
    const t = await sandbox(gw.url).tick('worker-cloud2');
    assert.equal(t.held, true, t.out);
    assert.equal(t.pass, 'planlimit');
    assert.match(t.out, /until unknown/);
  } finally { gw.server.close(); }
});

test('a healthy gateway (no planLimit) ticks normally', async () => {
  const gw = await gateway(() => ({ ok: true, provider: 'claude-subscription' }));
  try {
    const t = await sandbox(gw.url).tick('worker-cloud');
    assert.equal(t.held, false, t.out);
    assert.notEqual(t.pass, 'planlimit');
    assert.notEqual(t.status, 'disabled');
  } finally { gw.server.close(); }
});

test('a past resetsAt (the limit already lifted) ticks normally', async () => {
  const gw = await gateway(() => ({ planLimit: { resetsAt: '2000-01-01T00:00:00.000Z' } }));
  try {
    const t = await sandbox(gw.url).tick('worker-cloud');
    assert.equal(t.held, false, t.out);
    assert.notEqual(t.pass, 'planlimit');
  } finally { gw.server.close(); }
});

test('a gateway answering HTTP 500 fails open: the lane ticks normally', async () => {
  const gw = await gateway(() => 500);
  try {
    const t = await sandbox(gw.url).tick('worker-cloud');
    assert.equal(t.held, false, t.out);
    assert.notEqual(t.pass, 'planlimit');
  } finally { gw.server.close(); }
});

test('an unreachable gateway fails open: the lane is not held', async () => {
  const gw = await gateway(() => ({}));
  const url = gw.url;
  await new Promise((r) => gw.server.close(r)); // nothing listens on this port any more
  const t = await sandbox(url).tick('worker-cloud');
  assert.equal(t.held, false, t.out);
  assert.notEqual(t.pass, 'planlimit');
});

test('a worker that is not a cloud lane is never asked and never held, even when OLLAMA_URL names a limited gateway', async () => {
  const gw = await gateway(() => ({ planLimit: { resetsAt: '2999-01-01T00:00:00.000Z' } }));
  try {
    const s = sandbox(gw.url);
    const t = await s.tick('worker-3090');
    assert.equal(t.held, false, t.out);
    assert.notEqual(t.pass, 'planlimit');
    assert.equal(gw.hits.length, 0, 'no probe for a non-cloud instance');
  } finally { gw.server.close(); }
});

test('cloud_plan_limited: empty url is not limited and spawns no probe; a limited cloud gateway returns 0 and sets the note', async () => {
  const gw = await gateway(() => ({ planLimit: { resetsAt: '2999-01-01T00:00:00.000Z' } }));
  try {
    const s = sandbox(gw.url);
    const run = (arg) => new Promise((resolve) => {
      const child = spawn('bash', ['-c', `source "${COMMON}"; cloud_plan_limited "$1"; echo "rc=$? note=$CLOUD_PLAN_LIMIT_NOTE"`, 'x', arg], { env: s.env });
      let out = '';
      child.stdout.on('data', (b) => { out += b; });
      child.on('close', () => resolve(out.trim().split('\n').pop()));
    });
    assert.equal(await run(''), 'rc=1 note=');
    assert.equal(gw.hits.length, 0);
    assert.equal(await run(gw.url), 'rc=0 note=2999-01-01T00:00:00.000Z');
    assert.equal(await run('http://127.0.0.1:1'), 'rc=1 note=');
  } finally { gw.server.close(); }
});
