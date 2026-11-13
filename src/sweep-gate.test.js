'use strict';

// Every path points into a temp dir; HOME and the gate's state directory too, so a broken rule can only write there.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const g = require('./sweep-gate.js');
const { SETTLE_MS } = require('./branch-conflict-readmit-sweep.js');

const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sweepgate-')); made.push(d); return d; };
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

const T0 = Date.parse('2026-11-03T12:00:00Z');
const MIN = 60000;
const bump = (p, ms) => { const t = new Date(ms); fs.utimesSync(p, t, t); };

function world(n = 2) {
  const root = tmp();
  const projects = [];
  for (let i = 0; i < n; i += 1) {
    const repo = path.join(root, `repo${i}`);
    const pipe = path.join(root, `pipe${i}`);
    fs.mkdirSync(path.join(repo, '.git', 'refs', 'remotes', 'origin', 'agent'), { recursive: true });
    fs.mkdirSync(path.join(pipe, 'queue', 'done'), { recursive: true });
    fs.writeFileSync(path.join(pipe, 'queue', 'branch-verdicts.json'), '{}');
    projects.push({ repoRoot: repo, pipelineDir: pipe, label: `p${i}`, pool: true });
  }
  const registry = path.join(root, 'projects.json');
  fs.writeFileSync(registry, JSON.stringify(projects));
  const env = { HOME: root, AGENT_MANAGER_PROJECTS_REGISTRY_PATH: registry, AGENT_MANAGER_SWEEP_GATE_DIR: path.join(root, 'gate') };
  return { root, projects, env };
}

test('checkGate: the first call runs and stores, the same call again skips, a changed path runs again', () => {
  const dir = tmp();
  const file = path.join(dir, 'watched');
  fs.writeFileSync(file, 'x');
  const env = { HOME: dir, AGENT_MANAGER_SWEEP_GATE_DIR: path.join(dir, 'gate') };
  const call = (now) => g.checkGate({ name: 'demo', key: dir, paths: [file], now, env });
  assert.deepStrictEqual(call(T0), { run: true, reason: 'first run' });
  assert.deepStrictEqual(call(T0 + MIN), { run: false, reason: 'unchanged' });
  fs.writeFileSync(file, 'xy');
  assert.deepStrictEqual(call(T0 + 2 * MIN), { run: true, reason: 'input changed' });
  assert.deepStrictEqual(call(T0 + 3 * MIN), { run: false, reason: 'unchanged' });
});

test('checkGate: pending always runs, and the safety net runs after the idle limit (default 30 minutes, overridable)', () => {
  const dir = tmp();
  const file = path.join(dir, 'watched');
  fs.writeFileSync(file, 'x');
  const env = { HOME: dir, AGENT_MANAGER_SWEEP_GATE_DIR: path.join(dir, 'gate') };
  const call = (now, extra = {}, e = env) => g.checkGate({ name: 'demo', key: dir, paths: [file], now, env: e, ...extra });
  call(T0);
  assert.deepStrictEqual(call(T0 + MIN, { pending: true }), { run: true, reason: 'a sweep is waiting for its second sighting' });
  assert.strictEqual(call(T0 + 2 * MIN).run, false);
  assert.strictEqual(call(T0 + MIN + 29 * MIN).run, false);          // 29 minutes after the last stored run
  assert.deepStrictEqual(call(T0 + MIN + 30 * MIN), { run: true, reason: 'safety net' });
  assert.strictEqual(call(T0 + MIN + 30 * MIN + 1000).run, false);   // the safety-net run was stored too
  const fast = { ...env, AGENT_MANAGER_SWEEP_GATE_MAX_IDLE_MIN: '5' };
  call(T0 + 100 * MIN, {}, fast);
  assert.strictEqual(call(T0 + 104 * MIN, {}, fast).run, false);
  assert.strictEqual(call(T0 + 105 * MIN, {}, fast).reason, 'safety net');
});

test('checkGate: the off switch always runs and stores nothing; a corrupt or unreadable state file means no state', () => {
  const dir = tmp();
  const file = path.join(dir, 'watched');
  fs.writeFileSync(file, 'x');
  const gateDir = path.join(dir, 'gate');
  const env = { HOME: dir, AGENT_MANAGER_SWEEP_GATE_DIR: gateDir };
  const off = { ...env, AGENT_MANAGER_SWEEP_GATE: ' OFF ' };
  assert.deepStrictEqual(g.checkGate({ name: 'demo', key: dir, paths: [file], now: T0, env: off }), { run: true, reason: 'gate off' });
  assert.strictEqual(fs.existsSync(gateDir), false);
  g.checkGate({ name: 'demo', key: dir, paths: [file], now: T0, env });
  const state = g.statePath('demo', dir, env);
  fs.writeFileSync(state, '{broken');
  assert.deepStrictEqual(g.checkGate({ name: 'demo', key: dir, paths: [file], now: T0 + MIN, env }), { run: true, reason: 'first run' });
  fs.writeFileSync(state, JSON.stringify({ sig: 5, at: 1 }));
  assert.strictEqual(g.checkGate({ name: 'demo', key: dir, paths: [file], now: T0 + 2 * MIN, env }).reason, 'first run');
  fs.writeFileSync(state, JSON.stringify({ sig: g.signature([file]) }));
  assert.strictEqual(g.checkGate({ name: 'demo', key: dir, paths: [file], now: T0 + 3 * MIN, env }).reason, 'safety net');   // no usable time: run
});

test('checkGate never throws: an unwritable state directory answers run', () => {
  const dir = tmp();
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'a file where the state directory should be');
  const env = { HOME: dir, AGENT_MANAGER_SWEEP_GATE_DIR: path.join(blocker, 'gate') };
  const a = g.checkGate({ name: 'demo', key: dir, paths: [dir], now: T0, env });
  assert.strictEqual(a.run, true);
  assert.match(a.reason, /^gate error:/);
  assert.strictEqual(g.checkGate().run, true);
});

test('signature: stable, changes with mtime, size or a missing path appearing', () => {
  const dir = tmp();
  const f = path.join(dir, 'a');
  fs.writeFileSync(f, 'x');
  const s0 = g.signature([f, path.join(dir, 'missing')]);
  assert.strictEqual(g.signature([f, path.join(dir, 'missing')]), s0);
  bump(f, 1000);
  const s1 = g.signature([f, path.join(dir, 'missing')]);
  assert.notStrictEqual(s1, s0);
  fs.writeFileSync(path.join(dir, 'missing'), '');
  assert.notStrictEqual(g.signature([f, path.join(dir, 'missing')]), s1);
  assert.notStrictEqual(g.signature([f]), g.signature([f, path.join(dir, 'zzz')]));
});

test('signature also changes with the size or the inode alone, when the mtime is put back', () => {
  const dir = tmp();
  const f = path.join(dir, 'a');
  fs.writeFileSync(f, 'x');
  bump(f, 5000);
  const before = g.signature([f]);
  fs.writeFileSync(f, 'xyz');
  bump(f, 5000);                                        // same mtime, other size
  const sized = g.signature([f]);
  assert.notStrictEqual(sized, before);
  fs.writeFileSync(`${f}.new`, 'xyz');
  bump(`${f}.new`, 5000);
  fs.renameSync(`${f}.new`, f);                         // same mtime and size, other inode
  assert.notStrictEqual(g.signature([f]), sized);
});

test('the state is written through a temp file and renamed, and no temp file is left behind', (t) => {
  const dir = tmp();
  const env = { HOME: dir, AGENT_MANAGER_SWEEP_GATE_DIR: path.join(dir, 'gate') };
  const renames = [];
  const real = fs.renameSync;
  t.mock.method(fs, 'renameSync', (a, b) => { renames.push([a, b]); return real(a, b); });
  g.checkGate({ name: 'demo', key: dir, paths: [dir], now: T0, env });
  const state = g.statePath('demo', dir, env);
  assert.strictEqual(renames.length, 1);
  assert.strictEqual(renames[0][1], state);
  assert.notStrictEqual(renames[0][0], state);
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'gate')), [path.basename(state)]);
});

test('statePath: one file per group and project realpath; two spellings of one directory share it', () => {
  const dir = tmp();
  const alias = path.join(dir, 'alias');
  fs.mkdirSync(path.join(dir, 'real'));
  fs.symlinkSync(path.join(dir, 'real'), alias);
  const env = { AGENT_MANAGER_SWEEP_GATE_DIR: path.join(dir, 'gate') };
  assert.strictEqual(g.statePath('project', path.join(dir, 'real'), env), g.statePath('project', alias, env));
  assert.notStrictEqual(g.statePath('project', path.join(dir, 'real'), env), g.statePath('global-redo', path.join(dir, 'real'), env));
  assert.ok(g.statePath('project', dir, { HOME: '/h' }).startsWith('/h/.local/state/agent-manager/sweep-gate/project-'));
  assert.strictEqual(g.stateDir({ HOME: '/h', AGENT_MANAGER_SWEEP_GATE_DIR: '  ' }), '/h/.local/state/agent-manager/sweep-gate');
});

test('gateProject: runs first, skips while nothing moved, and runs again for each of its inputs', () => {
  const w = world(2);
  const [a, b] = w.projects;
  const call = (p, now) => g.gateProject(p.pipelineDir, { env: w.env, now });
  assert.strictEqual(call(a, T0).run, true);
  assert.strictEqual(call(b, T0).run, true);
  assert.strictEqual(call(a, T0 + MIN).run, false);
  assert.strictEqual(call(b, T0 + MIN).run, false);
  fs.writeFileSync(path.join(a.pipelineDir, 'queue', 'done', 't.json'), '{}');                       // a task lands in a's done/
  assert.strictEqual(call(a, T0 + 2 * MIN).reason, 'input changed');
  assert.strictEqual(call(b, T0 + 2 * MIN).run, false);                                           // b is unaffected
  fs.writeFileSync(path.join(b.pipelineDir, 'queue', 'branch-verdicts.json'), '{"x":1}');         // a verdict is recorded
  assert.strictEqual(call(b, T0 + 3 * MIN).reason, 'input changed');
  fs.writeFileSync(path.join(a.repoRoot, '.git', 'packed-refs'), '# pack-refs\n');                // someone fetched
  assert.strictEqual(call(a, T0 + 4 * MIN).reason, 'input changed');
  fs.mkdirSync(path.join(b.repoRoot, '.git', 'refs', 'remotes', 'origin', 'main'), { recursive: true });
  assert.strictEqual(call(b, T0 + 4 * MIN).reason, 'input changed');
  assert.strictEqual(call(a, T0 + 5 * MIN).run, false);
});

test('gateProject: a settling sweep entry keeps it running until the entry is older than SETTLE_MS', () => {
  const w = world(1);
  const p = w.projects[0];
  const stateFile = path.join(p.pipelineDir, 'queue', 'branch-defect-readmit-state.json');
  const call = (now) => g.gateProject(p.pipelineDir, { env: w.env, now });
  call(T0);
  fs.writeFileSync(stateFile, JSON.stringify({ 'agent/x': { sha: 's', firstSeenAt: new Date(T0).toISOString() } }));
  assert.strictEqual(call(T0 + 5 * MIN).reason, 'a sweep is waiting for its second sighting');
  assert.strictEqual(call(T0 + 9 * MIN).run, true);
  assert.strictEqual(call(T0 + SETTLE_MS + 1).run, false);                                        // decided: nothing to wait for
  const conflict = path.join(p.pipelineDir, 'queue', 'branch-conflict-readmit-state.json');
  fs.writeFileSync(conflict, JSON.stringify({ 'agent/y': { firstSeenAt: new Date(T0 + 20 * MIN).toISOString() } }));
  assert.strictEqual(call(T0 + 21 * MIN).run, true);                                              // the conflict sweep's own entry counts too
  fs.writeFileSync(conflict, JSON.stringify({ 'agent/y': {} }));
  assert.strictEqual(call(T0 + 22 * MIN).run, true);                                              // no readable time: still waiting
  fs.writeFileSync(conflict, '{broken');
  assert.strictEqual(g.hasPendingEntry(path.join(p.pipelineDir, 'queue'), T0 + 40 * MIN, SETTLE_MS), false);
});

test('gateProject fails open: an unregistered project, an unreadable registry and a missing queue all run', () => {
  const w = world(1);
  assert.deepStrictEqual(g.gateProject(path.join(w.root, 'elsewhere'), { env: w.env, now: T0 }), { run: true, reason: 'project not registered' });
  const bad = { ...w.env, AGENT_MANAGER_PROJECTS_REGISTRY_PATH: path.join(w.root, 'none.json') };
  assert.strictEqual(g.gateProject(w.projects[0].pipelineDir, { env: bad, now: T0 }).reason, 'project not registered');
  fs.rmSync(path.join(w.projects[0].pipelineDir, 'queue'), { recursive: true });
  assert.strictEqual(g.gateProject(w.projects[0].pipelineDir, { env: w.env, now: T0 }).run, true);
});

test('gateGlobalRedo: one group for every registered project; any project\'s done/ or verdict file wakes it; duplicates by realpath count once', () => {
  const w = world(3);
  const call = (now) => g.gateGlobalRedo({ env: w.env, now });
  assert.strictEqual(call(T0).run, true);
  assert.ok(fs.existsSync(g.statePath('global-redo', 'all', w.env)));
  assert.ok(!fs.existsSync(g.statePath('project', 'all', w.env)));
  assert.strictEqual(call(T0 + MIN).run, false);
  fs.writeFileSync(path.join(w.projects[2].pipelineDir, 'queue', 'done', 'merged-redo.json'), '{}');
  assert.strictEqual(call(T0 + 2 * MIN).reason, 'input changed');
  assert.strictEqual(call(T0 + 3 * MIN).run, false);
  fs.writeFileSync(path.join(w.projects[0].pipelineDir, 'queue', 'branch-verdicts.json'), '{"y":1}');
  assert.strictEqual(call(T0 + 4 * MIN).run, true);
  // the same pipeline registered twice (two mounts) is one path set
  const dup = [...w.projects, { ...w.projects[0], repoRoot: path.join(w.root, 'repo-alias') }];
  fs.writeFileSync(path.join(w.root, 'projects.json'), JSON.stringify(dup));
  fs.mkdirSync(path.join(w.root, 'repo-alias'));
  assert.strictEqual(g.gateGlobalRedo({ env: w.env, now: T0 + 5 * MIN }).run, false);          // the watched set is identical, so nothing changed
  assert.strictEqual(g.gateGlobalRedo({ env: w.env, now: T0 + 6 * MIN }).run, false);
});

test('gateGlobalRedo runs when there is no registry at all (fail open)', () => {
  const w = world(1);
  const bad = { ...w.env, AGENT_MANAGER_PROJECTS_REGISTRY_PATH: path.join(w.root, 'none.json') };
  assert.deepStrictEqual(g.gateGlobalRedo({ env: bad, now: T0 }), { run: true, reason: 'no registered projects' });
});

test('the CLI prints exactly run or skip and exits 0, for both forms and for bad arguments', () => {
  const w = world(1);
  const env = { PATH: process.env.PATH, ...w.env };
  const cli = (...args) => spawnSync(process.execPath, [path.join(__dirname, 'sweep-gate.js'), ...args], { env, encoding: 'utf8' });
  const pipe = w.projects[0].pipelineDir;
  for (const [args, expected] of [[['project', pipe], 'run\n'], [['project', pipe], 'skip\n'], [['global-redo'], 'run\n'], [['global-redo'], 'skip\n'], [['project'], 'run\n'], [['nonsense'], 'run\n'], [[], 'run\n']]) {
    const r = cli(...args);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout, expected, args.join(' '));
  }
  fs.writeFileSync(path.join(pipe, 'queue', 'done', 'x.json'), '{}');
  assert.strictEqual(cli('project', pipe).stdout, 'run\n');
  const off = spawnSync(process.execPath, [path.join(__dirname, 'sweep-gate.js'), 'project', pipe], { env: { ...env, AGENT_MANAGER_SWEEP_GATE: 'off' }, encoding: 'utf8' });
  assert.strictEqual(off.stdout, 'run\n');
  assert.deepStrictEqual(fs.readdirSync(w.root).sort(), ['gate', 'pipe0', 'projects.json', 'repo0']);
});
