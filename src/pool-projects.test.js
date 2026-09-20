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
