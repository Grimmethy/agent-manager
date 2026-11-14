'use strict';

// scripts/with-test-tmp.js runs a command with TMPDIR on a RAM-backed run directory, removes it however the command ends, caps its size and sweeps leftovers.
// Every test gives the launcher its OWN base directory (AGENT_MANAGER_TEST_TMP) so nothing depends on the real /dev/shm state.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { sweepStale } = require('./with-test-tmp.js');

const LAUNCHER = path.join(__dirname, 'with-test-tmp.js');
const newBase = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wtt-')), 'base');
const run = (base, args, env = {}) => spawnSync('node', [LAUNCHER, ...args], { encoding: 'utf8', env: { ...process.env, AGENT_MANAGER_TEST_TMP: base, AGENT_MANAGER_TEST_TMP_MIN_FREE_MB: '1', ...env } });
const runDirs = (base) => { try { return fs.readdirSync(base).filter((n) => n.startsWith('run-')); } catch { return []; } };

test('the command runs with TMPDIR, TEMP and TMP on a run directory under the base, and node and python both honour it', () => {
  const base = newBase();
  const r = run(base, ['node', '-e', "const os=require('os');console.log(os.tmpdir());console.log(process.env.TEMP);console.log(process.env.TMP)"]);
  assert.equal(r.status, 0, r.stderr);
  const [a, b, c] = r.stdout.trim().split('\n');
  assert.match(a, new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/run-\\d+-\\d+$`));
  assert.equal(a, b);
  assert.equal(a, c);
  const py = run(base, ['python3', '-c', 'import tempfile;print(tempfile.gettempdir())']);
  assert.match(py.stdout.trim(), /\/run-\d+-\d+$/);
});

test('the run directory is removed after the command ends, and its exit code is passed through', () => {
  const base = newBase();
  const ok = run(base, ['node', '-e', "require('fs').writeFileSync(require('os').tmpdir()+'/leftover.txt','x')"]);
  assert.equal(ok.status, 0);
  assert.deepEqual(runDirs(base), []);
  const bad = run(base, ['node', '-e', "require('fs').writeFileSync(require('os').tmpdir()+'/leftover.txt','x');process.exit(7)"]);
  assert.equal(bad.status, 7);
  assert.deepEqual(runDirs(base), []);
});

test('SIGTERM to the launcher stops the command and still removes the run directory', async () => {
  const base = newBase();
  const child = spawn('node', [LAUNCHER, 'node', '-e', "require('fs').writeFileSync(require('os').tmpdir()+'/f','x');setTimeout(()=>{},30000)"], { env: { ...process.env, AGENT_MANAGER_TEST_TMP: base, AGENT_MANAGER_TEST_TMP_MIN_FREE_MB: '1' }, stdio: 'ignore' });
  for (let i = 0; i < 50 && runDirs(base).length === 0; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(runDirs(base).length, 1, 'run directory exists while the command runs');
  child.kill('SIGTERM');
  await new Promise((r) => child.on('exit', r));
  assert.deepEqual(runDirs(base), []);
});

test('a command that writes past the cap is stopped with exit code 3 and cleaned up', () => {
  const base = newBase();
  const r = run(base, ['--max-mb', '1', 'node', '-e', "require('fs').writeFileSync(require('os').tmpdir()+'/big', Buffer.alloc(3*1024*1024));setTimeout(()=>{},20000)"], { AGENT_MANAGER_TEST_TMP_POLL_MS: '200' });
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /grew past 1 MB/);
  assert.deepEqual(runDirs(base), []);
});

test('sweepStale removes run directories of dead launchers that are old enough, and keeps live and recent ones', () => {
  const base = newBase();
  fs.mkdirSync(base, { recursive: true });
  const mk = (name, ageMs) => { const d = path.join(base, name); fs.mkdirSync(d); const t = new Date(Date.now() - ageMs); fs.utimesSync(d, t, t); };
  mk('run-111-1', 3600 * 1000);                 // dead pid, old: removed
  mk('run-222-2', 60 * 1000);                   // dead pid, recent: kept (a launcher may be starting)
  mk(`run-${process.pid}-3`, 3600 * 1000);      // live pid: kept
  mk('not-a-run-dir', 3600 * 1000);             // not ours: kept
  const removed = sweepStale(base, { alive: (pid) => pid === process.pid });
  assert.deepEqual(removed, ['run-111-1']);
  assert.deepEqual(fs.readdirSync(base).sort(), ['not-a-run-dir', 'run-222-2', `run-${process.pid}-3`].sort());
});

test('AGENT_MANAGER_TEST_TMP=off runs the command unchanged', () => {
  const r = spawnSync('node', [LAUNCHER, 'node', '-e', 'console.log(process.env.TMPDIR||"unset")'], { encoding: 'utf8', env: { ...process.env, TMPDIR: '/original', AGENT_MANAGER_TEST_TMP: 'off' } });
  assert.equal(r.stdout.trim(), '/original');
});

test('too little free space on the base filesystem: the command runs unchanged and a notice says why', () => {
  const base = newBase();
  const r = spawnSync('node', [LAUNCHER, 'node', '-e', 'console.log(process.env.TMPDIR||"unset")'], { encoding: 'utf8', env: { ...process.env, TMPDIR: '/original', AGENT_MANAGER_TEST_TMP: base, AGENT_MANAGER_TEST_TMP_MIN_FREE_MB: '999999999' } });
  assert.equal(r.stdout.trim(), '/original');
  assert.match(r.stderr, /free: running without the RAM-backed temp directory/);
});

test('usage error without a command exits 2', () => {
  assert.equal(spawnSync('node', [LAUNCHER], { encoding: 'utf8' }).status, 2);
});
