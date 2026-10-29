'use strict';

// pool-projects.js + instances-dir.js: which suite projects an idle lane may borrow from, in what order, with what env; and that the shared
// (lock/heartbeat) instances dir can be pinned. Run: node --test src/pool-projects.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// hasPremium reads its stage directories through the RAM cache (queue-cache.js). Keep this file's cache files, and those of the CLI processes it spawns,
// out of the real /dev/shm location.
const CACHE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-projects-cache-'));
process.env.AGENT_MANAGER_QUEUE_CACHE_DIR = CACHE_ROOT;
process.on('exit', () => { try { fs.rmSync(CACHE_ROOT, { recursive: true, force: true }); } catch (_) { /* best-effort */ } });

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
  fs.copyFileSync(path.join(__dirname, 'hub-prerequisites.js'), path.join(dir, 'src', 'hub-prerequisites.js'));   // pool-projects.js requires it
  fs.copyFileSync(path.join(__dirname, 'queue-cache.js'), path.join(dir, 'src', 'queue-cache.js'));   // and so does hasPremium's cache
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

const { registeredProjects, hasPremium, premiumTaskClaimable, dependencyReleased, premiumProjects, markPremiumBorrowed, markPremiumEmpty, premiumReachEnabled } = require('./pool-projects.js');

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
  for (const f of ['pool-projects.js', 'pipeline-history.js', 'hub-prerequisites.js', 'queue-cache.js']) fs.copyFileSync(path.join(__dirname, f), path.join(dir, 'src', f));
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

// --- premium reach counts only premium tasks a lane could actually claim (2026-10-25) ---------------------------------------------------------------
// Six premium stacked hub children in the home adhoc/ were held by unmet dependsOn for 66-69 h, hasPremium counted them, every lane answered "home has
// premium work" and none borrowed another repo's premium task. hasPremium now mirrors the dependsOn / softDependsOn / prerequisiteHubs gates of adhoc/ and derived/.

const premiumFixture = () => {
  const fx = fixture([{ name: 'p' }]);
  const pipe = fx.list[0].pipelineDir;
  return { fx, pipe, counts: () => hasPremium(pipe, { role: 'worker', lane: 'worker-a' }) };
};

test('a premium adhoc task held by an unmet dependsOn does not count, whatever state its dependency is stuck in', () => {
  const { pipe, counts } = premiumFixture();
  writeTask(pipe, 'adhoc', 'child', { id: 'child', premiumPriority: true, dependsOn: ['dep'] });
  assert.equal(counts(), false, 'a dependency with no record at all is unreleased');
  for (const stage of ['needs-clarification', 'blocked', 'adhoc', 'pending', 'review', 'approved', 'drafting/worker-b']) {
    writeTask(pipe, stage, 'dep', { id: 'dep' });
    assert.equal(counts(), false, `a dependency still in ${stage} holds the task`);
    fs.rmSync(path.join(pipe, 'queue', stage, 'dep.json'));
  }
  writeTask(pipe, 'coordinating', 'dep', { id: 'dep', subTasks: [{ status: 'pending-merge' }] });
  assert.equal(counts(), false, 'a coordinating record without a stacked branch is not a built nested hub');
  writeTask(pipe, 'coordinating', 'dep', { id: 'dep', stacked: { branch: 'agent/x' }, subTasks: [{ status: 'done' }, { status: 'drafting' }] });
  assert.equal(counts(), false, 'a nested hub with one open piece is not built');
  writeTask(pipe, 'coordinating', 'dep', { id: 'dep', stacked: { branch: 'agent/x' }, subTasks: [] });
  assert.equal(counts(), false, 'a nested hub with no pieces is not built (fail closed)');
});

test('the same task counts once its dependency is released, by any of the signals the claim path accepts', () => {
  const { pipe, counts } = premiumFixture();
  writeTask(pipe, 'adhoc', 'child', { id: 'child', premiumPriority: true, dependsOn: ['dep'] });
  writeTask(pipe, 'done', 'dep', { id: 'dep', terminalDisposition: 'pending-merge' });
  assert.equal(counts(), false, 'a done record that is not merged, not stacked and not a no-code outcome is unreleased (fail closed, no git fallback)');
  const released = [
    ['mergedAt', { mergedAt: '2026-10-25T00:00:00Z' }],
    ['applied-direct', { terminalDisposition: 'applied-direct' }],
    ['a no-code disposition', { terminalDisposition: 'noop' }],
    ['a stacked branch', { stacked: { branch: 'agent/decompose-x', seq: 1, total: 3 } }],
  ];
  for (const [label, extra] of released) {
    writeTask(pipe, 'done', 'dep', { id: 'dep', ...extra });
    assert.equal(counts(), true, `released by ${label}`);
  }
  fs.rmSync(path.join(pipe, 'queue', 'done', 'dep.json'));
  writeTask(pipe, 'done/_archived_no_action', 'dep', { id: 'dep', mergedAt: '2026-10-25T00:00:00Z' });
  assert.equal(counts(), true, 'released from the archived-no-action dir too');
  fs.rmSync(path.join(pipe, 'queue', 'done', '_archived_no_action', 'dep.json'));
  writeTask(pipe, 'coordinating', 'dep', { id: 'dep', stacked: { branch: 'agent/x' }, subTasks: [{ status: 'pending-merge' }, { status: 'done' }, { status: 'noop' }] });
  assert.equal(counts(), true, 'released by a nested hub whose pieces are all finished');
});

test('dependsOn needs EVERY dependency released; blank entries block nothing; a non-array dependsOn is ignored', () => {
  const { pipe, counts } = premiumFixture();
  writeTask(pipe, 'done', 'a', { id: 'a', mergedAt: 'x' });
  writeTask(pipe, 'adhoc', 'child', { id: 'child', premiumPriority: true, dependsOn: ['a', 'b'] });
  assert.equal(counts(), false, 'one released and one missing dependency still holds the task');
  writeTask(pipe, 'done', 'b', { id: 'b', mergedAt: 'x' });
  assert.equal(counts(), true, 'all released');
  writeTask(pipe, 'adhoc', 'child', { id: 'child', premiumPriority: true, dependsOn: ['', '   ', null] });
  assert.equal(counts(), true, 'blank or malformed entries are released');
  writeTask(pipe, 'adhoc', 'child', { id: 'child', premiumPriority: true, dependsOn: 'not-an-array' });
  assert.equal(counts(), true, 'a malformed field falls back to counting the task, as before');
  assert.equal(dependencyReleased(pipe, 'a'), true);
  assert.equal(dependencyReleased(pipe, 'zzz'), false);
});

test('softDependsOn is released by any done record, and prerequisiteHubs holds while the hub is open', () => {
  const { pipe, counts } = premiumFixture();
  writeTask(pipe, 'adhoc', 'child', { id: 'child', premiumPriority: true, softDependsOn: ['s'] });
  assert.equal(counts(), false, 'no record');
  writeTask(pipe, 'pending', 's', { id: 's' });
  assert.equal(counts(), false, 'still pending');
  writeTask(pipe, 'done', 's', { id: 's' });
  assert.equal(counts(), true, 'reaching done/ at all releases a soft dependency');
  writeTask(pipe, 'adhoc', 'child', { id: 'child', premiumPriority: true, prerequisiteHubs: ['HUB0006'] });
  assert.equal(counts(), true, 'no open hub with that label');
  writeTask(pipe, 'coordinating', 'hub6', { id: 'hub6', hubLabel: 'HUB0006' });
  assert.equal(counts(), false, 'the prerequisite hub is still open');
  fs.rmSync(path.join(pipe, 'queue', 'coordinating', 'hub6.json'));
  assert.equal(counts(), true, 'the prerequisite hub merged');
});

test('the gates apply to adhoc/ and derived/ only; pending/, drafting/<lane>, review/ and approved/ keep counting on the flag alone', () => {
  const { pipe, fx } = premiumFixture();
  const gated = { premiumPriority: true, dependsOn: ['missing'] };
  const has = (role, lane) => hasPremium(pipe, { role, lane });
  writeTask(pipe, 'derived', 'd', { id: 'd', ...gated });
  assert.equal(has('worker', 'worker-a'), false, 'derived/ is gated too');
  assert.equal(has('worker-seed'), false, 'and worker-seed sees the same filter');
  writeTask(pipe, 'pending', 'pend', { id: 'pend', ...gated });
  assert.equal(has('worker', 'worker-a'), true, 'pending/ has no dependency gate in its claim path');
  fs.rmSync(path.join(pipe, 'queue', 'pending', 'pend.json'));
  writeTask(pipe, 'drafting/worker-a', 'mine', { id: 'mine', ...gated });
  assert.equal(has('worker', 'worker-a'), true, 'a resume of this lane\'s own drafting file always counts');
  writeTask(pipe, 'review', 'r', { id: 'r', ...gated });
  writeTask(pipe, 'approved', 'ap', { id: 'ap', ...gated });
  assert.equal(has('reviewer'), true);
  assert.equal(has('apply'), true);
  writeTask(pipe, 'adhoc', 'free', { id: 'free', premiumPriority: true });
  assert.equal(has('worker-seed'), true, 'a gate-free premium adhoc task still counts');
  assert.equal(premiumTaskClaimable(pipe, { dependsOn: ['missing'] }), false);
  assert.equal(premiumTaskClaimable(pipe, {}), true);
  assert.ok(fx.root);
});

test('premiumProjects: gated home premium tasks no longer hide other repos\' claimable premium work (the 2026-10-22 to 10-25 stall)', () => {
  const fx = fixture([{ name: 'home' }, { name: 'core', pool: true }, { name: 'gatedonly', pool: true }]);
  const [home, core, gatedonly] = fx.list;
  const active = { repoRoot: home.repoRoot, pipelineDir: home.pipelineDir };
  // the six real shapes in the home queue: premium stacked hub children whose dependency is stuck elsewhere
  const stuck = [['HUB0006-06', 'needs-clarification'], ['HUB0009-10', 'coordinating'], ['HUB0024-03', 'blocked']];
  for (const [dep, stage] of stuck) writeTask(home.pipelineDir, stage, dep, { id: dep });
  writeTask(home.pipelineDir, 'adhoc', 'HUB0006-07', { id: 'HUB0006-07', premiumPriority: true, stacked: { branch: 'agent/h', seq: 7, total: 7 }, dependsOn: ['HUB0006-06'] });
  writeTask(home.pipelineDir, 'adhoc', 'HUB0009-11', { id: 'HUB0009-11', premiumPriority: true, stacked: { branch: 'agent/h', seq: 11, total: 13 }, dependsOn: ['HUB0009-10'] });
  writeTask(home.pipelineDir, 'adhoc', 'HUB0009-12', { id: 'HUB0009-12', premiumPriority: true, stacked: { branch: 'agent/h', seq: 12, total: 13 }, dependsOn: ['HUB0009-11'] });
  writeTask(home.pipelineDir, 'adhoc', 'HUB0024-04', { id: 'HUB0024-04', premiumPriority: true, stacked: { branch: 'agent/i', seq: 4, total: 5 }, dependsOn: ['HUB0024-03'] });
  assert.equal(hasPremium(home.pipelineDir, { role: 'worker', lane: 'worker-3090' }), false, 'the home project holds no CLAIMABLE premium work, so it does not win the tie');
  writeTask(core.pipelineDir, 'pending', 'fix', { id: 'fix', premiumPriority: true });
  writeTask(gatedonly.pipelineDir, 'adhoc', 'waiting', { id: 'waiting', premiumPriority: true, dependsOn: ['nobody'] });
  const labels = premiumProjects({ role: 'worker', lane: 'worker-3090', projectsPath: fx.projectsPath, active, stateFile: fx.stateFile }).map((p) => p.label);
  assert.deepEqual(labels, ['core'], 'the foreign project with claimable premium work is reached; the one whose only premium task is gated is not');
  // and a CLAIMABLE home premium task still wins the tie
  writeTask(home.pipelineDir, 'done', 'HUB0024-03', { id: 'HUB0024-03', mergedAt: '2026-10-25T00:00:00Z' });
  fs.rmSync(path.join(home.pipelineDir, 'queue', 'blocked', 'HUB0024-03.json'));
  assert.equal(hasPremium(home.pipelineDir, { role: 'worker', lane: 'worker-3090' }), true, 'once HUB0024-04 is claimable the home project wins the tie again');
});

// --- hasPremium reads its stage directories through the RAM cache (queue-cache.js) ---------------------------------------------------------------

const withCacheEnv = (name, value, fn) => {
  const prev = process.env[name];
  process.env[name] = value;
  try { return fn(); } finally { if (prev === undefined) delete process.env[name]; else process.env[name] = prev; }
};

// Every directory under queue/ made an hour old: a directory untouched for a while is what lets the cache's fast path apply from the second call on
// (a freshly changed directory is always re-scanned).
const ageQueueDirs = (pipelineDir) => {
  const old = new Date(Date.now() - 3600 * 1000);
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) walk(path.join(dir, e.name));
    fs.utimesSync(dir, old, old);
  };
  walk(path.join(pipelineDir, 'queue'));
};

const askBoth = (pipe, role = 'worker', lane = 'worker-a') => [
  hasPremium(pipe, { role, lane }),
  withCacheEnv('AGENT_MANAGER_QUEUE_CACHE', 'false', () => hasPremium(pipe, { role, lane })),
  hasPremium(pipe, { role, lane }),
];

test('hasPremium gives the expected answer, with the cache on (cold and cached) and off, for each shape of queue', () => {
  const cases = [];
  const fresh = () => { const fx = fixture([{ name: 'p' }]); return fx.list[0].pipelineDir; };
  { const pipe = fresh(); cases.push(['an empty queue', pipe, false]); }
  { const pipe = fresh(); writeTask(pipe, 'pending', 'plain', { id: 'plain', premiumPriority: false }); cases.push(['only non-premium tasks', pipe, false]); }
  { const pipe = fresh(); writeTask(pipe, 'pending', 'hot', { id: 'hot', premiumPriority: true }); cases.push(['a premium task in pending', pipe, true]); }
  { const pipe = fresh(); writeTask(pipe, 'adhoc', 'held', { id: 'held', premiumPriority: true, dependsOn: ['missing-dep'] }); cases.push(['a premium adhoc task held by an unmet dependency', pipe, false]); }
  { const pipe = fresh(); fs.mkdirSync(path.join(pipe, 'queue', 'pending'), { recursive: true }); fs.writeFileSync(path.join(pipe, 'queue', 'pending', 'bad.json'), '{ not json'); cases.push(['a corrupt file only', pipe, false]); }
  { const pipe = fresh(); fs.mkdirSync(path.join(pipe, 'queue', 'pending'), { recursive: true }); fs.writeFileSync(path.join(pipe, 'queue', 'pending', 'bad.json'), '{ not json'); writeTask(pipe, 'pending', 'later', { id: 'later', premiumPriority: true }); cases.push(['a corrupt file next to a premium task', pipe, true]); }
  { const pipe = fresh(); writeTask(pipe, 'pending', 'str', { id: 'str', premiumPriority: 'true' }); cases.push(['a string flag', pipe, false]); }
  cases.push(['a pipeline directory that does not exist', path.join(os.tmpdir(), `no-such-pipeline-${process.pid}-${Date.now()}`), false]);
  for (const [label, pipe, want] of cases) assert.deepEqual(askBoth(pipe), [want, want, want], label);
});

test('a cached hasPremium call reads and stats no task file', (t) => {
  const fx = fixture([{ name: 'p' }]);
  const pipe = fx.list[0].pipelineDir;
  for (let i = 0; i < 25; i++) writeTask(pipe, 'pending', `plain-${i}`, { id: `plain-${i}`, premiumPriority: false });
  writeTask(pipe, 'adhoc', 'other', { id: 'other' });
  ageQueueDirs(pipe);
  assert.equal(hasPremium(pipe, { role: 'worker', lane: 'worker-a' }), false);
  const touched = [];
  const realRead = fs.readFileSync;
  const realStat = fs.statSync;
  t.mock.method(fs, 'readFileSync', function (p, ...rest) {
    if (String(p).startsWith(pipe) && String(p).endsWith('.json')) touched.push(`read ${path.basename(String(p))}`);
    return realRead.call(fs, p, ...rest);
  });
  t.mock.method(fs, 'statSync', function (p, ...rest) {
    if (String(p).startsWith(pipe) && String(p).endsWith('.json')) touched.push(`stat ${path.basename(String(p))}`);
    return realStat.call(fs, p, ...rest);
  });
  assert.equal(hasPremium(pipe, { role: 'worker', lane: 'worker-a' }), false);
  assert.deepEqual(touched, []);
});

test('a premium task added after a cached call is found by the next call, and found no more once it is gone', () => {
  const fx = fixture([{ name: 'p' }]);
  const pipe = fx.list[0].pipelineDir;
  writeTask(pipe, 'pending', 'plain', { id: 'plain' });
  ageQueueDirs(pipe);
  const counts = () => hasPremium(pipe, { role: 'worker', lane: 'worker-a' });
  assert.equal(counts(), false);
  assert.equal(counts(), false);
  writeTask(pipe, 'pending', 'late', { id: 'late', premiumPriority: true });
  assert.equal(counts(), true, 'added after the cache was filled');
  fs.rmSync(path.join(pipe, 'queue', 'pending', 'late.json'));
  assert.equal(counts(), false, 'removed again');
});

test('a task edited in place is re-read once its directory is re-validated', () => {
  const fx = fixture([{ name: 'p' }]);
  const pipe = fx.list[0].pipelineDir;
  writeTask(pipe, 'pending', 'edited', { id: 'edited', premiumPriority: false });
  ageQueueDirs(pipe);
  const counts = () => hasPremium(pipe, { role: 'worker', lane: 'worker-a' });
  assert.equal(counts(), false);
  writeTask(pipe, 'pending', 'edited', { id: 'edited', premiumPriority: true, note: 'made premium in place' });
  const bumped = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(pipe, 'queue', 'pending'), bumped, bumped);
  assert.equal(counts(), true);
});

test('the dependency gate is judged afresh on every call even while the premium task itself is served from the cache', () => {
  const { pipe, counts } = premiumFixture();
  writeTask(pipe, 'adhoc', 'child', { id: 'child', premiumPriority: true, dependsOn: ['dep'] });
  ageQueueDirs(pipe);
  assert.equal(counts(), false, 'its dependency has no record yet');
  assert.equal(counts(), false, 'still held, now from the cache');
  writeTask(pipe, 'done', 'dep', { id: 'dep', mergedAt: '2026-10-25T00:00:00Z' });
  assert.equal(counts(), true, 'the dependency was released without the adhoc/ directory or the task file changing');
});

test('if the cache layer itself breaks, hasPremium reads the stage directly and still answers correctly', (t) => {
  const fx = fixture([{ name: 'p' }]);
  const pipe = fx.list[0].pipelineDir;
  writeTask(pipe, 'pending', 'plain', { id: 'plain' });
  const counts = () => hasPremium(pipe, { role: 'worker', lane: 'worker-a' });
  t.mock.method(require('crypto'), 'createHash', () => { throw new Error('the cache layer cannot name its file'); });
  assert.equal(counts(), false);
  writeTask(pipe, 'pending', 'hot', { id: 'hot', premiumPriority: true });
  assert.equal(counts(), true, 'a premium task is still found when the cache layer throws');
  writeTask(pipe, 'adhoc', 'held', { id: 'held', premiumPriority: true, dependsOn: ['missing-dep'] });
  fs.rmSync(path.join(pipe, 'queue', 'pending', 'hot.json'));
  assert.equal(counts(), false, 'the dependency gate still applies on the direct path');
  assert.equal(hasPremium(path.join(os.tmpdir(), `no-such-pipeline-${process.pid}-${Date.now()}`), { role: 'worker' }), false);
});

