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

// --- watchdog housekeeping for a borrowed project (step 4) -------------------------------------------------------------------------------------

function borrowedEnv(sb) {
  return { ...sb.env, AGENT_MANAGER_REPO_ROOT: path.join(sb.root, 'repoB'), AGENT_MANAGER_PIPELINE_DIR: sb.B, AGENT_MANAGER_INSTANCES_DIR: sb.instancesDir, AGENT_MANAGER_DOMAINS_PATH: path.join(sb.B, 'task-domains.json'), AGENT_MANAGER_BORROWING_FROM: 'B' };
}

test('pool-sweeps.sh runs the project-scoped sweeps under the BORROWED project: a blocked review rejection in B is retried in B, A is untouched, and it is due at most once per interval', () => {
  const sb = sandbox();
  fs.writeFileSync(path.join(sb.B, 'queue', 'blocked', 'b1.json'), JSON.stringify({ id: 'b1', domain: 'default', source: 'trouble_log', title: 't', status: 'blocked', blockedStage: 'review', blockedReason: 'rejected: needs work', localRejectCount: 0, history: [], promptContext: {} }));
  const run = () => spawnSync('bash', [path.join(__dirname, 'pool-sweeps.sh')], { encoding: 'utf8', timeout: 180000, env: borrowedEnv(sb) });
  const r1 = run();
  assert.equal(r1.status, 0, r1.stderr);
  assert.match(r1.stdout, /\[pool-sweeps:B\] reject-retry-check:/);
  assert.ok(!fs.existsSync(path.join(sb.B, 'queue', 'blocked', 'b1.json')), 'retried: it left B\'s blocked/');
  assert.ok(['pending', 'adhoc'].some((d) => fs.existsSync(path.join(sb.B, 'queue', d, 'b1.json'))), 'and was requeued inside B');
  assert.deepEqual([...fs.readdirSync(path.join(sb.A, 'queue', 'blocked')), ...fs.readdirSync(path.join(sb.A, 'queue', 'pending'))], [], 'nothing was filed into the home project');
  assert.ok(fs.existsSync(path.join(sb.B, 'instances', '.pool-sweeps-last')), 'the project-local due marker');
  const r2 = run();
  assert.equal(r2.stdout.trim(), '', 'a second run inside the interval does nothing');
});

test('pool-sweeps.sh skips a project with nothing in any housekeeping stage, and refuses to run outside a borrowed context', () => {
  const sb = sandbox();
  const r = spawnSync('bash', [path.join(__dirname, 'pool-sweeps.sh')], { encoding: 'utf8', timeout: 60000, env: borrowedEnv(sb) });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '', 'an idle project costs no sweeps');
  const home = { ...borrowedEnv(sb) }; delete home.AGENT_MANAGER_BORROWING_FROM;
  const bad = spawnSync('bash', [path.join(__dirname, 'pool-sweeps.sh')], { encoding: 'utf8', timeout: 60000, env: home });
  assert.equal(bad.status, 64);
  assert.match(bad.stderr, /refusing to run outside a borrowed-project context/);
});

// --- a borrowed tick is ONE item, and the lane returns HOME between tasks (2026-09-20) ----------------------------------------------------------
// Live: a borrowed --once tick drained the borrowed project's whole pending/ list (3 tasks, 14-25 min per lane), so PF's newly eligible work
// waited. The lane must re-check its home project after EVERY borrowed task, and go on borrowing without an idle gap while home stays empty.

// A throwaway package whose src/ is symlinks to the real one except local-draft.js, which is a stub that "drafts" successfully after a delay --
// so several tasks can be processed for real without a model.
function packageWithStubDraft(sb, draftMs, strayStdout = null) {
  const pkg = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-pkg-'));
  fs.mkdirSync(path.join(pkg, 'scripts')); fs.mkdirSync(path.join(pkg, 'src'));
  for (const f of fs.readdirSync(__dirname)) if (fs.statSync(path.join(__dirname, f)).isFile()) fs.copyFileSync(path.join(__dirname, f), path.join(pkg, 'scripts', f));
  const realSrc = path.join(__dirname, '..', 'src');
  for (const f of fs.readdirSync(realSrc)) if (f !== 'local-draft.js') fs.symlinkSync(path.join(realSrc, f), path.join(pkg, 'src', f));
  fs.writeFileSync(path.join(pkg, 'src', 'local-draft.js'), `${strayStdout ? `console.log(${JSON.stringify(strayStdout)});` : ''}setTimeout(() => console.log(JSON.stringify({ succeeded: true })), ${draftMs});\n`);
  fs.symlinkSync(path.join(__dirname, '..', 'node_modules'), path.join(pkg, 'node_modules'));
  for (const f of ['package.json', 'task-domains.json']) if (fs.existsSync(path.join(__dirname, '..', f))) fs.copyFileSync(path.join(__dirname, '..', f), path.join(pkg, f));
  return pkg;
}

const taskFile = (dir, id) => fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, domain: 'default', source: 'trouble_log', title: id, promptContext: {} }));

test('a borrowed tick takes ONE item; the lane re-checks HOME before the next borrowed one, and borrows again with no idle gap while home is empty', async () => {
  const sb = sandbox();
  const pkg = packageWithStubDraft(sb, 4000);
  taskFile(path.join(sb.B, 'queue', 'pending'), 'b1');
  taskFile(path.join(sb.B, 'queue', 'pending'), 'b2');
  const logFile = path.join(sb.root, 'lane.log');
  const out = fs.openSync(logFile, 'w');
  const child = spawn('bash', [path.join(pkg, 'scripts', 'local-worker.sh'), 'worker-x'], {
    detached: true, stdio: ['ignore', out, out],
    // ORC_TICK_SECS 60: an idle gap between borrowed tasks would blow the wait budget below.
    env: { ...sb.env, ORC_TICK_SECS: '60', AGENT_MANAGER_REPO_ROOT: path.join(sb.root, 'repoA'), AGENT_MANAGER_PIPELINE_DIR: sb.A, AGENT_MANAGER_DOMAINS_PATH: path.join(sb.A, 'task-domains.json') },
  });
  const claims = () => [...fs.readFileSync(logFile, 'utf8').matchAll(/\] claimed \S+\/queue\/pending\/(\w+)\.json/g)].map((m) => m[1]);
  try {
    assert.ok(await waitFor(() => claims().length >= 1, 60000), 'a borrowed task was claimed');
    assert.equal(claims()[0][0], 'b', 'the first claim is a borrowed one (home was empty)');
    // Active-project work arrives WHILE the first borrowed task is being drafted (the stub takes 4s).
    taskFile(path.join(sb.A, 'queue', 'pending'), 'a1');
    assert.ok(await waitFor(() => claims().length >= 3, 40000), `all three tasks were claimed without an idle gap; claims so far: ${claims().join(',')}`);
    const order = claims();
    assert.equal(order[1], 'a1', `home work is taken between the two borrowed tasks, not after both; order: ${order.join(',')}`);
    assert.equal(order[2][0], 'b');
    assert.deepEqual(new Set([order[0], order[2]]), new Set(['b1', 'b2']));
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    fs.closeSync(out);
  }
});

test('a borrowing reviewer reviews ONE item per borrowed tick', () => {
  const sb = sandbox();
  for (const id of ['r1', 'r2']) fs.writeFileSync(path.join(sb.B, 'queue', 'review', `${id}.json`), JSON.stringify({ id, domain: 'default', source: 'trouble_log', title: 't', status: 'needs-review', promptContext: {}, planResponse: 'p', implementResponse: 'i' }));
  const r = spawnSync('bash', [path.join(__dirname, 'review-runner.sh'), 'review-x', '--once'], { encoding: 'utf8', timeout: 120000, env: borrowedEnv(sb) });
  const reviewed = (r.stdout + r.stderr).match(/\[review-review-x\] reviewing /g) || [];
  assert.equal(reviewed.length, 1, `exactly one item is reviewed per borrowed tick; ${r.stderr}`);
  assert.equal(r.status, 10, 'and it reports that it did work');
});

// A stray stdout line from a module local-draft.js loads must not turn a SUCCESSFUL draft into "draft call failed" (2026-09-20, the [draft-sandbox] line).
test('the worker takes the JSON result line even when a stray line precedes it on stdout: the draft reaches review/, not a retry loop', async () => {
  const sb = sandbox();
  const pkg = packageWithStubDraft(sb, 500, '[draft-sandbox] copied node_modules into some-worktree (196 MB, 3253 ms)');
  taskFile(path.join(sb.A, 'queue', 'pending'), 'h1');
  const logFile = path.join(sb.root, 'lane.log');
  const out = fs.openSync(logFile, 'w');
  const child = spawn('bash', [path.join(pkg, 'scripts', 'local-worker.sh'), 'worker-x'], {
    detached: true, stdio: ['ignore', out, out],
    env: { ...sb.env, ORC_TICK_SECS: '60', AGENT_MANAGER_POOL_BORROW: 'false', AGENT_MANAGER_REPO_ROOT: path.join(sb.root, 'repoA'), AGENT_MANAGER_PIPELINE_DIR: sb.A, AGENT_MANAGER_DOMAINS_PATH: path.join(sb.A, 'task-domains.json') },
  });
  try {
    const inReview = await waitFor(() => fs.existsSync(path.join(sb.A, 'queue', 'review', 'h1.json')), 60000);
    assert.ok(inReview, `the draft succeeded and moved to review/; log:\n${fs.readFileSync(logFile, 'utf8').slice(-600)}`);
    assert.doesNotMatch(fs.readFileSync(logFile, 'utf8'), /draft call failed/);
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    fs.closeSync(out);
  }
});
