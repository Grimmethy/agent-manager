'use strict';

// pool-projects.js + instances-dir.js: which suite projects an idle lane may borrow from, in what order, with what env; and that the shared
// (lock/heartbeat) instances dir can be pinned. Run: node --test src/pool-projects.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { poolProjects, poolEnvFor, poolEnvArgs, markBorrowed, enabled } = require('./pool-projects.js');
const { sharedInstancesDir } = require('./instances-dir.js');

function fixture(entries) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-projects-'));
  const list = entries.map((e) => {
    const repoRoot = path.join(root, `${e.name}-repo`);
    const pipelineDir = e.pipelineDir || path.join(root, `${e.name}-pipeline`);
    if (e.repo !== false) fs.mkdirSync(repoRoot, { recursive: true });
    if (e.queue !== false) fs.mkdirSync(path.join(pipelineDir, 'queue'), { recursive: true });
    const entry = { repoRoot, pipelineDir, domainsPath: path.join(pipelineDir, 'task-domains.json'), label: e.name };
    if (e.pool !== undefined) entry.pool = e.pool;
    if (e.applyRepoRoot) entry.applyRepoRoot = e.applyRepoRoot;
    if (e.grepDirs) entry.grepDirs = e.grepDirs;
    return entry;
  });
  const projectsPath = path.join(root, 'projects.json');
  fs.writeFileSync(projectsPath, JSON.stringify(list));
  return { root, list, projectsPath, stateFile: path.join(root, 'pool-state.json') };
}

test('only projects that opt in with pool:true are candidates; the active project, missing repos/queues and duplicate registrations are excluded', () => {
  const fx = fixture([
    { name: 'active', pool: true }, { name: 'a', pool: true }, { name: 'b', pool: true },
    { name: 'off' }, { name: 'off2', pool: false }, { name: 'norepo', pool: true, repo: false }, { name: 'noqueue', pool: true, queue: false },
  ]);
  // a duplicate registration of `a` under another repo path but the same pipelineDir
  const dup = { ...fx.list[1], repoRoot: path.join(fx.root, 'a-mirror-repo') };
  fs.mkdirSync(dup.repoRoot);
  fs.writeFileSync(fx.projectsPath, JSON.stringify([...fx.list, dup]));
  const got = poolProjects({ projectsPath: fx.projectsPath, stateFile: fx.stateFile, active: { repoRoot: fx.list[0].repoRoot, pipelineDir: fx.list[0].pipelineDir } });
  assert.deepEqual(got.map((p) => p.label), ['a', 'b']);
});

test('ordered least-recently-borrowed first; never-borrowed keep projects.json order; markBorrowed moves a project to the back', () => {
  const fx = fixture([{ name: 'active' }, { name: 'a', pool: true }, { name: 'b', pool: true }, { name: 'c', pool: true }]);
  const active = { repoRoot: fx.list[0].repoRoot, pipelineDir: fx.list[0].pipelineDir };
  const order = () => poolProjects({ projectsPath: fx.projectsPath, stateFile: fx.stateFile, active }).map((p) => p.label);
  assert.deepEqual(order(), ['a', 'b', 'c']);
  markBorrowed(fx.list[1].pipelineDir, { now: new Date('2026-09-20T10:00:00Z'), file: fx.stateFile });
  assert.deepEqual(order(), ['b', 'c', 'a']);
  markBorrowed(fx.list[2].pipelineDir, { now: new Date('2026-09-20T10:05:00Z'), file: fx.stateFile });
  assert.deepEqual(order(), ['c', 'a', 'b']);
  markBorrowed(fx.list[3].pipelineDir, { now: new Date('2026-09-20T10:06:00Z'), file: fx.stateFile });
  assert.deepEqual(order(), ['a', 'b', 'c'], 'a full rotation returns to the least recent');
});

test('AGENT_MANAGER_POOL_BORROW=false switches the pool off', () => {
  const fx = fixture([{ name: 'active' }, { name: 'a', pool: true }]);
  process.env.AGENT_MANAGER_POOL_BORROW = 'false';
  try {
    assert.equal(enabled(), false);
    assert.deepEqual(poolProjects({ projectsPath: fx.projectsPath, stateFile: fx.stateFile, active: { repoRoot: fx.list[0].repoRoot, pipelineDir: fx.list[0].pipelineDir } }), []);
  } finally { delete process.env.AGENT_MANAGER_POOL_BORROW; }
  assert.equal(enabled(), true);
});

test('poolEnvFor sets the project paths, PINS the lane\'s home instances dir, and UNSETS keys the project does not define', () => {
  const fx = fixture([{ name: 'active' }, { name: 'plain', pool: true }, { name: 'rich', pool: true, applyRepoRoot: '/x/apply', grepDirs: 'src,docs' }]);
  const [plain, rich] = poolProjects({ projectsPath: fx.projectsPath, stateFile: fx.stateFile, active: { repoRoot: fx.list[0].repoRoot, pipelineDir: fx.list[0].pipelineDir } });
  const home = '/home-project/instances';
  const p = poolEnvFor(plain, home);
  assert.equal(p.set.AGENT_MANAGER_PIPELINE_DIR, plain.pipelineDir);
  assert.equal(p.set.AGENT_MANAGER_REPO_ROOT, plain.repoRoot);
  assert.equal(p.set.AGENT_MANAGER_INSTANCES_DIR, home);
  assert.equal(p.set.AGENT_MANAGER_BORROWING_FROM, 'plain');
  assert.deepEqual(p.unset.sort(), ['AGENT_MANAGER_APPLY_REPO_ROOT', 'AGENT_MANAGER_GREP_DIRS']);
  const r = poolEnvFor(rich, home);
  assert.equal(r.set.AGENT_MANAGER_APPLY_REPO_ROOT, '/x/apply');
  assert.equal(r.set.AGENT_MANAGER_GREP_DIRS, 'src,docs');
  assert.deepEqual(r.unset, []);
  const args = poolEnvArgs(plain, home);
  assert.ok(args.includes('-u') && args.includes('AGENT_MANAGER_APPLY_REPO_ROOT') && args.includes(`AGENT_MANAGER_INSTANCES_DIR=${home}`));
});

test('sharedInstancesDir follows the pipeline dir by default and is pinned by AGENT_MANAGER_INSTANCES_DIR', () => {
  delete process.env.AGENT_MANAGER_INSTANCES_DIR;
  assert.equal(sharedInstancesDir('/p/proj'), path.join('/p/proj', 'instances'));
  process.env.AGENT_MANAGER_INSTANCES_DIR = '/home/instances';
  try { assert.equal(sharedInstancesDir('/p/other'), '/home/instances'); } finally { delete process.env.AGENT_MANAGER_INSTANCES_DIR; }
  process.env.AGENT_MANAGER_INSTANCES_DIR = '   ';
  try { assert.equal(sharedInstancesDir('/p/proj'), path.join('/p/proj', 'instances')); } finally { delete process.env.AGENT_MANAGER_INSTANCES_DIR; }
});

test('a borrowed invocation keeps its lock/heartbeat dir in the HOME project: local-client resolves the pinned dir while project artifacts stay local', () => {
  const script = `
    process.env.AGENT_MANAGER_INSTANCES_DIR = '/home/proj/instances';
    const { sharedInstancesDir } = require('./src/instances-dir.js');
    const nextClaim = require('./src/next-claimable-task.js');
    console.log(JSON.stringify({ shared: sharedInstancesDir('/borrowed/pipeline'), hasClaim: typeof nextClaim.pickClaimableTasks }));
  `;
  const out = JSON.parse(execFileSync('node', ['-e', script], { cwd: path.join(__dirname, '..'), encoding: 'utf8' }));
  assert.equal(out.shared, '/home/proj/instances');
  assert.equal(out.hasClaim, 'function');
});

test('CLI: --list prints the pool as JSON, --env-args prints one env token per line, and an unknown project fails', () => {
  const fx = fixture([{ name: 'active' }, { name: 'a', pool: true, grepDirs: 'src' }]);
  const env = { ...process.env, AGENT_MANAGER_REPO_ROOT: fx.list[0].repoRoot, AGENT_MANAGER_PIPELINE_DIR: fx.list[0].pipelineDir, AGENT_MANAGER_POOL_STATE_PATH: fx.stateFile };
  const script = path.join(__dirname, 'pool-projects.js');
  // the CLI reads the real projects.json next to the package; point it at the fixture by copying the module beside it
  const dir = path.join(fx.root, 'pkg');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.copyFileSync(script, path.join(dir, 'src', 'pool-projects.js'));
  fs.copyFileSync(fx.projectsPath, path.join(dir, 'projects.json'));
  const run = (...args) => execFileSync('node', [path.join(dir, 'src', 'pool-projects.js'), ...args], { env, encoding: 'utf8' });
  const list = JSON.parse(run('--list'));
  assert.deepEqual(list.map((p) => p.label), ['a']);
  const tokens = run('--env-args', 'a', '/home/instances').trim().split('\n');
  assert.ok(tokens.includes('AGENT_MANAGER_INSTANCES_DIR=/home/instances'));
  assert.ok(tokens.includes('AGENT_MANAGER_GREP_DIRS=src'));
  assert.throws(() => run('--env-args', 'nope'), /no pool project/);
  run('--mark', fx.list[1].pipelineDir);
  assert.ok(JSON.parse(fs.readFileSync(fx.stateFile, 'utf8')).lastBorrowedAt);
});

test('markEmpty puts a project on a backoff (excluded until it expires); markBorrowed clears it; includeBackedOff shows it anyway', () => {
  const { markEmpty } = require('./pool-projects.js');
  const fx = fixture([{ name: 'active' }, { name: 'a', pool: true }, { name: 'b', pool: true }]);
  const active = { repoRoot: fx.list[0].repoRoot, pipelineDir: fx.list[0].pipelineDir };
  const t0 = new Date('2026-09-20T10:00:00Z');
  const list = (now, extra = {}) => poolProjects({ projectsPath: fx.projectsPath, stateFile: fx.stateFile, active, now, ...extra }).map((p) => p.label);
  markEmpty(fx.list[1].pipelineDir, { now: t0, file: fx.stateFile, ttlMs: 5 * 60 * 1000 });
  assert.deepEqual(list(new Date(t0.getTime() + 60 * 1000)), ['b'], 'a is backed off');
  assert.deepEqual(list(new Date(t0.getTime() + 60 * 1000), { includeBackedOff: true }), ['a', 'b']);
  assert.deepEqual(list(new Date(t0.getTime() + 6 * 60 * 1000)), ['a', 'b'], 'the backoff expired');
  markEmpty(fx.list[1].pipelineDir, { now: t0, file: fx.stateFile, ttlMs: 5 * 60 * 1000 });
  markBorrowed(fx.list[1].pipelineDir, { now: new Date(t0.getTime() + 1000), file: fx.stateFile });
  assert.deepEqual(list(new Date(t0.getTime() + 60 * 1000)), ['b', 'a'], 'a borrow that did work clears the backoff (and moves it to the back)');
});

test('borrowing is tracked per role: a worker finding a project empty does not hide it from the reviewer, and orderings are independent', () => {
  const { markEmpty } = require('./pool-projects.js');
  const fx = fixture([{ name: 'active' }, { name: 'a', pool: true }, { name: 'b', pool: true }]);
  const active = { repoRoot: fx.list[0].repoRoot, pipelineDir: fx.list[0].pipelineDir };
  const t0 = new Date('2026-09-20T10:00:00Z');
  const list = (role) => poolProjects({ projectsPath: fx.projectsPath, stateFile: fx.stateFile, active, now: new Date(t0.getTime() + 1000), role }).map((p) => p.label);
  markEmpty(fx.list[1].pipelineDir, { now: t0, file: fx.stateFile, ttlMs: 300000, role: 'worker' });
  assert.deepEqual(list('worker'), ['b']);
  assert.deepEqual(list('reviewer'), ['a', 'b'], 'the reviewer still sees a');
  markBorrowed(fx.list[1].pipelineDir, { now: t0, file: fx.stateFile, role: 'reviewer' });
  assert.deepEqual(list('reviewer'), ['b', 'a']);
  assert.deepEqual(list('worker'), ['b'], 'the worker ordering/backoff is untouched by reviewer borrows');
});

// --- premium reach (2026-10-18): every registered project, premium work only -----------------------------------------------------------

const { registeredProjects, hasPremium, premiumProjects, markPremiumBorrowed, markPremiumEmpty, premiumReachEnabled } = require('./pool-projects.js');

const writeTask = (pipelineDir, stage, name, task, compact = false) => {
  const dir = path.join(pipelineDir, 'queue', stage);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), compact ? JSON.stringify(task) : JSON.stringify(task, null, 2));
};

test('registeredProjects includes non-pool projects with the same dedupe / active / missing-dir rules; poolProjects still needs pool:true', () => {
  const fx = fixture([
    { name: 'active', pool: true }, { name: 'a', pool: true }, { name: 'plain' }, { name: 'off', pool: false },
    { name: 'norepo', repo: false }, { name: 'noqueue', queue: false },
  ]);
  const dup = { ...fx.list[2], repoRoot: path.join(fx.root, 'plain-mirror-repo'), label: 'plain-dup' };
  fs.mkdirSync(dup.repoRoot);
  fs.writeFileSync(fx.projectsPath, JSON.stringify([...fx.list, dup]));
  const active = { repoRoot: fx.list[0].repoRoot, pipelineDir: fx.list[0].pipelineDir };
  assert.deepEqual(registeredProjects({ projectsPath: fx.projectsPath, active }).map((p) => p.label), ['a', 'plain', 'off']);
  assert.deepEqual(poolProjects({ projectsPath: fx.projectsPath, stateFile: fx.stateFile, active }).map((p) => p.label), ['a']);
  const plain = registeredProjects({ projectsPath: fx.projectsPath, active }).find((p) => p.label === 'plain');
  assert.deepEqual(Object.keys(plain).sort(), ['applyRepoRoot', 'domainsPath', 'grepDirs', 'label', 'pipelineDir', 'repoRoot']);
});

test('hasPremium looks only at the stages a role works from, and only at this lane\'s drafting dir', () => {
  const fx = fixture([{ name: 'p' }]);
  const pipe = fx.list[0].pipelineDir;
  const has = (role, lane) => hasPremium(pipe, { role, lane });
  assert.equal(has('worker', 'worker-a'), false, 'empty queue');
  writeTask(pipe, 'pending', 'plain', { id: 'plain', premiumPriority: false });
  writeTask(pipe, 'pending', 'nested', { id: 'nested', promptContext: { premiumPriority: true }, premiumPriority: 'true' });
  writeTask(pipe, 'blocked', 'stuck', { id: 'stuck', premiumPriority: true });
  fs.writeFileSync(path.join(pipe, 'queue', 'pending', 'partial.json'), '{"id":"partial","premiumPriority":tr');
  assert.equal(has('worker', 'worker-a'), false, 'premiumPriority:false, a nested or string flag, a corrupt file and a premium task in blocked/ do not count');
  writeTask(pipe, 'drafting/worker-b', 'theirs', { id: 'theirs', premiumPriority: true });
  assert.equal(has('worker', 'worker-a'), false, 'another lane\'s drafting dir is not this lane\'s');
  assert.equal(has('worker', 'worker-b'), true, 'the lane\'s own drafting dir counts');
  assert.equal(has('worker', '../x'), false, 'a malformed lane is ignored, not joined into a path');
  writeTask(pipe, 'derived', 'child', { id: 'child', premiumPriority: true });
  assert.equal(has('worker', 'worker-a'), true, 'derived/ counts for the worker');
  fs.rmSync(path.join(pipe, 'queue', 'derived', 'child.json'));
  writeTask(pipe, 'adhoc', 'waiting', { id: 'waiting', premiumPriority: true }, true);
  assert.equal(has('worker', 'worker-a'), true, 'adhoc/ counts for the worker (compact JSON too)');
  assert.equal(has('reviewer'), false);
  assert.equal(has('apply'), false);
  writeTask(pipe, 'review', 'r', { id: 'r', premiumPriority: true });
  writeTask(pipe, 'approved', 'ap', { id: 'ap', premiumPriority: true });
  assert.equal(has('reviewer'), true);
  assert.equal(has('apply'), true);
  assert.equal(has('worker-seed'), true, 'worker-seed sees the premium adhoc/ task');
  fs.rmSync(path.join(pipe, 'queue', 'adhoc', 'waiting.json'));
  writeTask(pipe, 'pending', 'queued', { id: 'queued', premiumPriority: true });
  assert.equal(has('worker', 'worker-a'), true, 'pending/ counts for the worker');
  assert.equal(has('worker-seed'), false, 'but worker-seed looks only at adhoc/ and derived/');
  writeTask(pipe, 'derived', 'child2', { id: 'child2', premiumPriority: true });
  assert.equal(has('worker-seed'), true, 'derived/ counts for worker-seed');
  assert.equal(has('nobody'), false, 'unknown role has no stages');
  assert.equal(hasPremium(path.join(fx.root, 'missing')), false, 'a missing pipeline dir is not an error');
});

test('premiumProjects: premium-holding registered projects only, least-recently-premium-borrowed first, per-lane backoff, kill switch, separate from idle borrowing', () => {
  const fx = fixture([{ name: 'active' }, { name: 'a', pool: true }, { name: 'b' }, { name: 'c' }]);
  const [act, a, b, c] = fx.list;
  const active = { repoRoot: act.repoRoot, pipelineDir: act.pipelineDir };
  writeTask(act.pipelineDir, 'pending', 'home', { id: 'home', premiumPriority: true });
  writeTask(a.pipelineDir, 'pending', 'pa', { id: 'pa', premiumPriority: true });
  writeTask(b.pipelineDir, 'adhoc', 'pb', { id: 'pb', premiumPriority: true });
  writeTask(c.pipelineDir, 'pending', 'pc', { id: 'pc' });
  const t0 = new Date('2026-10-18T09:00:00Z');
  const list = (lane = 'worker-x', now = new Date(t0.getTime() + 1000), role = 'worker') => premiumProjects({ projectsPath: fx.projectsPath, stateFile: fx.stateFile, active, role, lane, now }).map((p) => p.label);
  assert.deepEqual(list(), ['a', 'b'], 'the active project and the premium-free c are excluded');
  markPremiumBorrowed(a.pipelineDir, { lane: 'worker-x', now: t0, file: fx.stateFile, projectsPath: fx.projectsPath });
  assert.deepEqual(list(), ['b', 'a'], 'a borrow moves the project to the back');
  assert.deepEqual(list('worker-y'), ['a', 'b'], 'another lane has its own order');
  markPremiumEmpty(b.pipelineDir, { lane: 'worker-x', now: t0, file: fx.stateFile, ttlMs: 300000 });
  assert.deepEqual(list(), ['a'], 'b is backed off for worker-x');
  assert.deepEqual(list('worker-y'), ['a', 'b'], 'but not for worker-y');
  assert.deepEqual(list('worker-x', new Date(t0.getTime() + 301000)), ['b', 'a'], 'the backoff expires');
  const pooled = poolProjects({ projectsPath: fx.projectsPath, stateFile: fx.stateFile, active }).map((p) => p.label);
  assert.deepEqual(pooled, ['a'], 'idle borrowing still sees only the pool project and its order is untouched by premium borrows');
  const state = JSON.parse(fs.readFileSync(fx.stateFile, 'utf8'));
  assert.equal(state.lastBorrowedAt[fs.realpathSync(a.pipelineDir)], undefined, 'no idle-borrowing (worker) key was written');
  writeTask(a.pipelineDir, 'review', 'ra', { id: 'ra', premiumPriority: true });
  assert.deepEqual(list(null, undefined, 'reviewer'), ['a'], 'the reviewer role looks at review/');
  process.env.AGENT_MANAGER_PREMIUM_REACH = 'false';
  try {
    assert.equal(premiumReachEnabled(), false);
    assert.deepEqual(list(), []);
    assert.deepEqual(poolProjects({ projectsPath: fx.projectsPath, stateFile: fx.stateFile, active }).map((p) => p.label), ['a'], 'idle borrowing is not affected by the premium switch');
  } finally { delete process.env.AGENT_MANAGER_PREMIUM_REACH; }
});

test('CLI: --env-args resolves a non-pool project, --has-premium exits 0/1, --premium-projects lists, --mark-premium writes one home history event', () => {
  const fx = fixture([{ name: 'active' }, { name: 'plain', grepDirs: 'src' }]);
  const [act, plain] = fx.list;
  writeTask(plain.pipelineDir, 'pending', 'p1', { id: 'p1', premiumPriority: true });
  const env = { ...process.env, AGENT_MANAGER_REPO_ROOT: act.repoRoot, AGENT_MANAGER_PIPELINE_DIR: act.pipelineDir, AGENT_MANAGER_POOL_STATE_PATH: fx.stateFile };
  delete env.AGENT_MANAGER_PREMIUM_REACH;
  const dir = path.join(fx.root, 'pkg');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  for (const f of ['pool-projects.js', 'pipeline-history.js']) fs.copyFileSync(path.join(__dirname, f), path.join(dir, 'src', f));
  fs.copyFileSync(fx.projectsPath, path.join(dir, 'projects.json'));
  const cli = path.join(dir, 'src', 'pool-projects.js');
  const run = (...args) => execFileSync('node', [cli, ...args], { env, encoding: 'utf8' });
  const status = (...args) => spawnSyncStatus(cli, args, env);
  const tokens = run('--env-args', 'plain', '/home/instances').trim().split('\n');
  assert.ok(tokens.includes(`AGENT_MANAGER_PIPELINE_DIR=${plain.pipelineDir}`) && tokens.includes('AGENT_MANAGER_GREP_DIRS=src'));
  assert.throws(() => run('--env-args', 'nope'), /no pool project/);
  assert.equal(status('--has-premium', plain.pipelineDir, 'worker', 'worker-x'), 0);
  assert.equal(status('--has-premium', plain.pipelineDir, 'reviewer'), 1);
  assert.deepEqual(run('--premium-projects', 'worker', 'worker-x').trim().split('\n'), [plain.pipelineDir]);
  assert.equal(run('--premium-projects', 'reviewer').trim(), '');
  run('--mark-premium', plain.pipelineDir, 'worker', act.pipelineDir, 'worker-x');
  const log = path.join(act.pipelineDir, 'instances', 'pipeline-history.log');
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].type, 'premium-borrow');
  assert.equal(lines[0].role, 'worker');
  assert.equal(lines[0].lane, 'worker-x');
  assert.equal(lines[0].project, 'plain');
  assert.ok(!fs.existsSync(path.join(plain.pipelineDir, 'instances')), 'the event goes to the HOME project, not the borrowed one');
  assert.ok(JSON.parse(fs.readFileSync(fx.stateFile, 'utf8')).lastBorrowedAt[`premium-worker:worker-x|${fs.realpathSync(plain.pipelineDir)}`]);
});

function spawnSyncStatus(cli, args, env) {
  return require('child_process').spawnSync('node', [cli, ...args], { env, encoding: 'utf8' }).status;
}
