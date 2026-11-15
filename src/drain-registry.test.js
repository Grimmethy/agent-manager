'use strict';

// src/drain-registry.js: the watchdog side of the drain registration (2026-11-12). With a temp HOME and injected kill/alive no test signals a real process, except the one test that
// runs the CLI against a real sleeping child of its own.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const dr = require('./drain-registry.js');

const WATCHER = path.join(__dirname, '..', 'scripts', 'queue-watcher.sh');

function world() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'drain-reg-'));
  const state = path.join(home, '.local', 'state', 'agent-manager');
  const pids = path.join(state, 'pids');
  fs.mkdirSync(pids, { recursive: true });
  const env = { HOME: home };
  const pidfile = (name, text) => fs.writeFileSync(path.join(pids, name), `${text}\n`);
  const marker = () => fs.writeFileSync(path.join(state, 'pipeline-stopped'), '');
  const files = () => fs.readdirSync(pids).sort();
  return { home, env, pids, pidfile, marker, files };
}
const aliveSet = (...pids) => (pid) => pids.includes(pid);

test('listDrains: drain-<name>.pid files with a valid pid, sorted by name, running from the alive check; garbled and non-drain pidfiles are ignored', () => {
  const w = world();
  w.pidfile('drain-verify.pid', 111);
  w.pidfile('drain-hub.pid', 222);
  w.pidfile('drain-junk.pid', 'abc');
  w.pidfile('drain-zero.pid', 0);
  w.pidfile('plugin-x.pid', 333);
  w.pidfile('worker-1.pid', 444);
  w.pidfile('dashboard.pid', 555);
  assert.deepStrictEqual(dr.listDrains(w.env, aliveSet(222)), [{ name: 'hub', pid: 222, running: true }, { name: 'verify', pid: 111, running: false }]);
});

test('listDrains: a missing pids folder is no drains, never an error', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'drain-reg-'));
  assert.deepStrictEqual(dr.listDrains({ HOME: home }), []);
  assert.equal(dr.pipelineStopped({ HOME: home }), false);
});

test('sweep with the marker: SIGTERM only the running drains, one log line each, never a dead one, no file removed', () => {
  const w = world();
  w.pidfile('drain-hub.pid', 222);
  w.pidfile('drain-verify.pid', 111);
  w.pidfile('plugin-x.pid', 333);
  w.marker();
  const killed = []; const lines = [];
  const r = dr.sweep({ env: w.env, kill: (pid) => killed.push(pid), alive: aliveSet(222, 333), log: (l) => lines.push(l) });
  assert.deepStrictEqual(r, { stopped: ['hub'], removed: [] });
  assert.deepStrictEqual(killed, [222]);
  assert.deepStrictEqual(lines, ['[watchdog] stopped drain hub (pid 222): pipeline stopped']);
  assert.deepStrictEqual(w.files(), ['drain-hub.pid', 'drain-verify.pid', 'plugin-x.pid']);
});

test('sweep without the marker: remove only the pidfiles of dead drains, never signal anything, leave every other pidfile', () => {
  const w = world();
  w.pidfile('drain-hub.pid', 222);
  w.pidfile('drain-verify.pid', 111);
  w.pidfile('plugin-x.pid', 999999);
  w.pidfile('worker-1.pid', 888888);
  w.pidfile('drain-junk.pid', 'abc');
  const killed = []; const lines = [];
  const r = dr.sweep({ env: w.env, kill: (pid) => killed.push(pid), alive: aliveSet(222), log: (l) => lines.push(l) });
  assert.deepStrictEqual(r, { stopped: [], removed: ['verify'] });
  assert.deepStrictEqual(killed, []);
  assert.deepStrictEqual(lines, ['[watchdog] removed stale drain pidfile verify']);
  assert.deepStrictEqual(w.files(), ['drain-hub.pid', 'drain-junk.pid', 'plugin-x.pid', 'worker-1.pid']);
});

test('a second sweep right after the first is a no-op', () => {
  const w = world();
  w.pidfile('drain-verify.pid', 111);
  const first = dr.sweep({ env: w.env, alive: aliveSet(), log: () => {} });
  assert.deepStrictEqual(first, { stopped: [], removed: ['verify'] });
  const lines = [];
  assert.deepStrictEqual(dr.sweep({ env: w.env, alive: aliveSet(), log: (l) => lines.push(l) }), { stopped: [], removed: [] });
  assert.deepStrictEqual(lines, []);
});

test('with the marker a kill that throws is skipped (the drain may have just exited) and the others are still signalled', () => {
  const w = world();
  w.pidfile('drain-a.pid', 1);
  w.pidfile('drain-b.pid', 2);
  w.marker();
  const killed = [];
  const r = dr.sweep({ env: w.env, kill: (pid) => { if (pid === 1) throw new Error('ESRCH'); killed.push(pid); }, alive: aliveSet(1, 2), log: () => {} });
  assert.deepStrictEqual(r, { stopped: ['b'], removed: [] });
  assert.deepStrictEqual(killed, [2]);
});

test('the marker is read from HOME at call time: removing it switches sweep from stopping to cleaning', () => {
  const w = world();
  w.pidfile('drain-hub.pid', 222);
  w.marker();
  const killed = [];
  dr.sweep({ env: w.env, kill: (pid) => killed.push(pid), alive: aliveSet(222), log: () => {} });
  fs.unlinkSync(path.join(w.home, '.local', 'state', 'agent-manager', 'pipeline-stopped'));
  const r = dr.sweep({ env: w.env, kill: (pid) => killed.push(pid), alive: aliveSet(222), log: () => {} });
  assert.deepStrictEqual(killed, [222]);
  assert.deepStrictEqual(r, { stopped: [], removed: [] });
});

test('CLI: prints one JSON line and exits 0, also when the pids folder does not exist', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'drain-reg-cli-'));
  const r = spawnSync(process.execPath, [path.join(__dirname, 'drain-registry.js'), 'sweep'], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.deepStrictEqual(JSON.parse(r.stdout), { stopped: [], removed: [] });
});

test('CLI with a real sleeping child: with the marker the drain gets SIGTERM and the line goes to stderr; without it a dead drain pidfile is removed', async () => {
  const w = world();
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => { console.log('got-term'); process.exit(0); }); setInterval(() => {}, 1000);"], { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  try {
    await new Promise((r) => setTimeout(r, 300));
    w.pidfile('drain-sleeper.pid', child.pid);
    w.marker();
    const run = () => spawnSync(process.execPath, [path.join(__dirname, 'drain-registry.js'), 'sweep'], { env: { ...process.env, HOME: w.home }, encoding: 'utf8' });
    const r = run();
    assert.equal(r.status, 0);
    assert.deepStrictEqual(JSON.parse(r.stdout), { stopped: ['sleeper'], removed: [] });
    assert.match(r.stderr, /\[watchdog\] stopped drain sleeper/);
    await new Promise((resolve) => child.on('close', resolve));
    assert.match(out, /got-term/);
    fs.unlinkSync(path.join(w.home, '.local', 'state', 'agent-manager', 'pipeline-stopped'));
    const r2 = run();
    assert.deepStrictEqual(JSON.parse(r2.stdout), { stopped: [], removed: ['sleeper'] });
    assert.deepStrictEqual(w.files(), []);
  } finally { child.kill('SIGKILL'); }
});

test('queue-watcher.sh runs the sweep each tick and ignores its failure (structural)', () => {
  const src = fs.readFileSync(WATCHER, 'utf8');
  assert.match(src, /node "\$\{PACKAGE_SRC_DIR\}\/drain-registry\.js" sweep >\/dev\/null \|\| true/);
  const apply = src.indexOf('apply-retry-check.js');
  const sweepAt = src.indexOf('drain-registry.js');
  assert.ok(sweepAt > apply, 'the drain sweep runs in the same foreground tick, after the apply retry check');
  assert.equal((src.match(/drain-registry\.js/g) || []).length, 1, 'one call per tick');
});
