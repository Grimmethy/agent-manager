'use strict';

// local-worker.sh --once + the borrow loop (docs/idle-pool-borrowing.md), run for real in a sandbox: two throwaway projects (A = the lane's
// home, B = a pool project), a private HOME and instances dir, and an Ollama URL that refuses connections so nothing ever touches a model.
// Run: node --test scripts/local-worker-borrow.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'local-worker.sh');

function sandbox({ poolTask = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-borrow-'));
  const mk = (...p) => { const d = path.join(root, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
  const A = mk('A'); const B = mk('B'); mk('repoA'); mk('repoB'); mk('home');
  for (const d of ['pending', 'adhoc', 'drafting', 'review', 'blocked', 'done']) { mk('A', 'queue', d); mk('B', 'queue', d); }
  fs.writeFileSync(path.join(A, 'task-domains.json'), '{}');
  fs.writeFileSync(path.join(B, 'task-domains.json'), '{}');
  const projectsPath = path.join(root, 'projects.json');
  fs.writeFileSync(projectsPath, JSON.stringify([
    { repoRoot: path.join(root, 'repoA'), pipelineDir: A, domainsPath: path.join(A, 'task-domains.json'), label: 'A' },
    { repoRoot: path.join(root, 'repoB'), pipelineDir: B, domainsPath: path.join(B, 'task-domains.json'), label: 'B', pool: true },
  ]));
  if (poolTask) {
    fs.writeFileSync(path.join(B, 'queue', 'pending', 'borrow-me.json'), JSON.stringify({ id: 'borrow-me', domain: 'default', source: 'trouble_log', title: 't', promptContext: {} }));
  }
  const env = {
    ...process.env,
    HOME: path.join(root, 'home'),
    OLLAMA_URL: 'http://127.0.0.1:9', MODEL_URL: 'http://127.0.0.1:9', LOCAL_MODEL: 'x',
    AGENT_MANAGER_TASK_SOURCES: 'none-such', // no source generates anything
    AGENT_MANAGER_PROJECTS_PATH: projectsPath,
    AGENT_MANAGER_POOL_STATE_PATH: path.join(root, 'pool-state.json'),
    ORC_TICK_SECS: '2',
  };
  return { root, A, B, env, stateFile: path.join(root, 'pool-state.json'), instancesDir: path.join(A, 'instances') };
}

const waitFor = async (fn, ms = 60000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 250)); }
  return null;
};

test('--once runs ONE tick in the borrowed project, heartbeats into the lane\'s HOME instances dir with the DAEMON pid, and exits 0 when nothing was found', () => {
  const sb = sandbox();
  const r = spawnSync('bash', [SCRIPT, 'worker-x', '--once'], {
    encoding: 'utf8', timeout: 120000,
    env: { ...sb.env, AGENT_MANAGER_REPO_ROOT: path.join(sb.root, 'repoB'), AGENT_MANAGER_PIPELINE_DIR: sb.B, AGENT_MANAGER_INSTANCES_DIR: sb.instancesDir, AGENT_MANAGER_DAEMON_PID: '424242', AGENT_MANAGER_DOMAINS_PATH: path.join(sb.B, 'task-domains.json'), AGENT_MANAGER_BORROWING_FROM: 'B' },
  });
  assert.equal(r.status, 0, r.stderr);
  const hb = JSON.parse(fs.readFileSync(path.join(sb.instancesDir, 'worker-x.json'), 'utf8'));
  assert.equal(hb.daemonPid, 424242, 'the borrowed child must not put its own pid where the watchdog looks');
  assert.equal(hb.pid, 424242);
  assert.equal(hb.project, 'B');
  assert.ok(!fs.existsSync(path.join(sb.B, 'instances')), 'nothing lane-shared is written into the borrowed project');
});

test('a lane whose own project is empty borrows from a pool project: the task is claimed in the POOL project, the lane\'s heartbeat stays in the home dir, and the borrow is recorded', async () => {
  const sb = sandbox({ poolTask: true });
  const child = spawn('bash', [SCRIPT, 'worker-x'], {
    detached: true, stdio: 'ignore',
    env: { ...sb.env, AGENT_MANAGER_REPO_ROOT: path.join(sb.root, 'repoA'), AGENT_MANAGER_PIPELINE_DIR: sb.A, AGENT_MANAGER_DOMAINS_PATH: path.join(sb.A, 'task-domains.json') },
  });
  try {
    const state = await waitFor(() => { try { const s = JSON.parse(fs.readFileSync(sb.stateFile, 'utf8')); return s.lastBorrowedAt && Object.keys(s.lastBorrowedAt).length ? s : null; } catch { return null; } });
    assert.ok(state, 'the borrow (a claimed pool task) was recorded for the least-recently-borrowed ordering');
    assert.ok(fs.existsSync(path.join(sb.B, 'queue', 'drafting', 'worker-x')), 'the pool task was claimed into the POOL project, under this lane');
    assert.deepEqual(fs.readdirSync(path.join(sb.A, 'queue', 'drafting')), [], 'the home project was not touched');
    const hb = JSON.parse(fs.readFileSync(path.join(sb.instancesDir, 'worker-x.json'), 'utf8'));
    assert.equal(hb.daemonPid, child.pid, 'the lane daemon, not a borrowed child, owns the heartbeat');
    assert.ok(!fs.existsSync(path.join(sb.B, 'instances')));
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
});

test('a pool project with nothing to do is put on a short backoff instead of being re-ticked every cycle', async () => {
  const sb = sandbox();
  const child = spawn('bash', [SCRIPT, 'worker-x'], {
    detached: true, stdio: 'ignore',
    env: { ...sb.env, AGENT_MANAGER_REPO_ROOT: path.join(sb.root, 'repoA'), AGENT_MANAGER_PIPELINE_DIR: sb.A, AGENT_MANAGER_DOMAINS_PATH: path.join(sb.A, 'task-domains.json'), AGENT_MANAGER_POOL_EMPTY_BACKOFF_SECS: '600' },
  });
  try {
    const state = await waitFor(() => { try { const s = JSON.parse(fs.readFileSync(sb.stateFile, 'utf8')); return s.emptyUntil && Object.keys(s.emptyUntil).length ? s : null; } catch { return null; } });
    assert.ok(state, 'the empty project was marked');
    const until = Date.parse(Object.values(state.emptyUntil)[0]);
    assert.ok(until - Date.now() > 300000, 'backed off for the configured window');
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
});

test('AGENT_MANAGER_POOL_BORROW=false: an idle lane never borrows', async () => {
  const sb = sandbox({ poolTask: true });
  const child = spawn('bash', [SCRIPT, 'worker-x'], {
    detached: true, stdio: 'ignore',
    env: { ...sb.env, AGENT_MANAGER_REPO_ROOT: path.join(sb.root, 'repoA'), AGENT_MANAGER_PIPELINE_DIR: sb.A, AGENT_MANAGER_DOMAINS_PATH: path.join(sb.A, 'task-domains.json'), AGENT_MANAGER_POOL_BORROW: 'false' },
  });
  try {
    await new Promise((r) => setTimeout(r, 12000)); // several ticks
    assert.ok(fs.existsSync(path.join(sb.B, 'queue', 'pending', 'borrow-me.json')), 'the pool task is untouched');
    assert.ok(!fs.existsSync(sb.stateFile));
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
});

// --- reviewer + apply loop (step 3) -----------------------------------------------------------------------------------------------------------

test('a reviewer whose own review/ is empty borrows a review from a pool project: the item is reviewed in the POOL project, locks/heartbeat stay home, tracked under the reviewer role', async () => {
  const sb = sandbox();
  fs.writeFileSync(path.join(sb.B, 'queue', 'review', 'r1.json'), JSON.stringify({ id: 'r1', domain: 'default', source: 'trouble_log', title: 't', status: 'needs-review', promptContext: {}, planResponse: 'p', implementResponse: 'i' }));
  const child = spawn('bash', [path.join(__dirname, 'review-runner.sh'), 'review-x'], {
    detached: true, stdio: 'ignore',
    env: { ...sb.env, AGENT_MANAGER_REPO_ROOT: path.join(sb.root, 'repoA'), AGENT_MANAGER_PIPELINE_DIR: sb.A, AGENT_MANAGER_DOMAINS_PATH: path.join(sb.A, 'task-domains.json') },
  });
  try {
    const state = await waitFor(() => { try { const s = JSON.parse(fs.readFileSync(sb.stateFile, 'utf8')); return Object.keys(s.lastBorrowedAt || {}).some((k) => k.startsWith('reviewer|')) ? s : null; } catch { return null; } }, 90000);
    assert.ok(state, 'the review borrow was recorded under the reviewer role');
    assert.ok(!Object.keys(state.lastBorrowedAt).some((k) => !k.startsWith('reviewer|')), 'and NOT under the worker role');
    assert.deepEqual(fs.readdirSync(path.join(sb.A, 'queue', 'review')), [], 'the home project was not touched');
    const hb = JSON.parse(fs.readFileSync(path.join(sb.instancesDir, 'review-x.json'), 'utf8'));
    assert.equal(hb.daemonPid, child.pid);
    assert.ok(!fs.existsSync(path.join(sb.B, 'instances')));
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
});

// A throwaway package dir so apply-task.sh finds an agent-manager.env that describes the ACTIVE project (A), exactly like production.
function packageWithEnvFile(sb) {
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-pkg-'));
  fs.mkdirSync(path.join(pkg, 'scripts'));
  for (const f of fs.readdirSync(__dirname)) if (f.endsWith('.sh')) fs.copyFileSync(path.join(__dirname, f), path.join(pkg, 'scripts', f));
  fs.symlinkSync(path.join(__dirname, '..', 'src'), path.join(pkg, 'src'));
  fs.symlinkSync(path.join(__dirname, '..', 'node_modules'), path.join(pkg, 'node_modules'));
  fs.writeFileSync(path.join(pkg, 'agent-manager.env'), [
    `AGENT_MANAGER_REPO_ROOT=${path.join(sb.root, 'repoA')}`, `AGENT_MANAGER_PIPELINE_DIR=${sb.A}`,
    `AGENT_MANAGER_APPLY_REPO_ROOT=${path.join(sb.root, 'active-apply-clone')}`, 'AGENT_MANAGER_GREP_DIRS=active,dirs',
    `AGENT_MANAGER_PROJECTS_PATH=${path.join(sb.root, 'projects.json')}`,
  ].join('\n') + '\n');
  fs.copyFileSync(path.join(sb.root, 'projects.json'), path.join(pkg, 'projects.json'));
  return pkg;
}

test('apply-loop applies approved tasks of a pool project under THAT project\'s env, not the active project\'s (the env file must not override it)', () => {
  const sb = sandbox();
  const pkg = packageWithEnvFile(sb);
  fs.mkdirSync(path.join(sb.B, 'queue', 'approved'), { recursive: true });
  fs.mkdirSync(path.join(sb.A, 'queue', 'approved'), { recursive: true });
  fs.writeFileSync(path.join(sb.B, 'queue', 'approved', 'a1.json'), JSON.stringify({ id: 'a1', domain: 'default', source: 'trouble_log', title: 't', status: 'approved', promptContext: {} }));
  const r = spawnSync('bash', [path.join(pkg, 'scripts', 'apply-loop.sh'), '--once'], { encoding: 'utf8', timeout: 120000, env: { ...process.env, HOME: path.join(sb.root, 'home'), ORC_TICK_SECS: '1' } });
  assert.match(r.stdout, /applying approved tasks of borrowed project/, r.stderr);
  assert.deepEqual(fs.readdirSync(path.join(sb.B, 'queue', 'approved')), [], 'the pool project\'s approved task was picked up (moved on to done/blocked/...)');
  assert.deepEqual(fs.readdirSync(path.join(sb.A, 'queue', 'approved')), [], 'the active project had none, and nothing was mis-filed there');
  const landed = ['done', 'blocked', 'awaiting-confirm', 'coordinating'].some((d) => fs.existsSync(path.join(sb.B, 'queue', d, 'a1.json')));
  assert.ok(landed, 'the task landed in the POOL project\'s own queue');
  assert.ok(!['done', 'blocked'].some((d) => fs.existsSync(path.join(sb.A, 'queue', d, 'a1.json'))));
});
