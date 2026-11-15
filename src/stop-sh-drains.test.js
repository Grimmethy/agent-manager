'use strict';

// scripts/stop.sh and scripts/launch.sh and the plugin drains (2026-11-12): after POST /api/pipeline/stop eleven detached drains (pipeline-ops, context-ops, pf-loops workers) kept running
// because nothing told them the pipeline was stopped. A drain writes ~/.local/state/agent-manager/pids/drain-<name>.pid; stop.sh already loops over every pidfile, so a drain is stopped like
// any daemon, and it must NEVER be skipped by --keep-plugins (only plugin-<name>.pid is). stop.sh now also creates the pipeline-stopped marker (drains and the watchdog triggers read it),
// and launch.sh removes it at the start of a launch.
//
// SAFETY: stop.sh ends with a system-wide `pgrep -f` stray sweep. Every test points that sweep (AGENT_MANAGER_STOP_STRAY_PATTERN) and the orphan sweep
// (AGENT_MANAGER_STOP_ORPHAN_PATTERN) at private markers, and uses a temp HOME, so a real pipeline on this machine is never matched or touched.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const STOP_SH = path.join(__dirname, '..', 'scripts', 'stop.sh');
const LAUNCH_SH = path.join(__dirname, '..', 'scripts', 'launch.sh');
const SKIP = { skip: process.platform === 'win32' };

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const settle = () => new Promise((r) => setTimeout(r, 400));
// A killed child of this test process is gone only once libuv has reaped it: wait for that (up to 5 s) instead of a fixed pause, which flakes on a loaded host.
async function gone(pid) { for (let i = 0; i < 50 && alive(pid); i += 1) await new Promise((r) => setTimeout(r, 100)); return !alive(pid); }

function sandbox({ withPidDir = true } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-drains-'));
  const stateDir = path.join(tmp, '.local', 'state', 'agent-manager');
  const pidDir = path.join(stateDir, 'pids');
  if (withPidDir) fs.mkdirSync(pidDir, { recursive: true });
  const marker = `private-marker-${process.pid}-${Date.now()}`;
  const spawned = [];
  // A long-lived fake daemon with a pidfile, in its own session so stop.sh's signals reach only it. ignoreTerm: it survives SIGTERM (only --force kills it).
  function daemon(pidfileName, { ignoreTerm = false } = {}) {
    const script = path.join(tmp, `fake-${pidfileName}.js`);
    fs.writeFileSync(script, `${ignoreTerm ? "process.on('SIGTERM', () => {});\n" : ''}setInterval(() => {}, 1000);\n`);
    const child = spawn('node', [script], { detached: true, stdio: 'ignore' });
    child.unref();
    spawned.push(child.pid);
    fs.writeFileSync(path.join(pidDir, pidfileName), String(child.pid));
    return child.pid;
  }
  const runStop = (args) => spawnSync('bash', [STOP_SH, ...args], {
    env: { ...process.env, HOME: tmp, AGENT_MANAGER_STOP_GRACE_SEC: '5', AGENT_MANAGER_STOP_ORPHAN_PATTERN: marker, AGENT_MANAGER_STOP_STRAY_PATTERN: marker },
    encoding: 'utf8', timeout: 30000,
  });
  const cleanup = () => {
    for (const pid of spawned) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    fs.rmSync(tmp, { recursive: true, force: true });
  };
  return { tmp, stateDir, pidDir, markerFile: path.join(stateDir, 'pipeline-stopped'), daemon, runStop, cleanup };
}

test('a drain pidfile is stopped like any daemon and removed, also with --keep-plugins, while a plugin server and its pidfile survive', SKIP, async () => {
  const s = sandbox();
  try {
    const drain = s.daemon('drain-hub.pid');
    const plugin = s.daemon('plugin-fakeforge.pid');
    const res = s.runStop(['--keep-dashboard', '--keep-plugins']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(await gone(drain), true, 'the drain must be stopped even with --keep-plugins');
    assert.equal(fs.existsSync(path.join(s.pidDir, 'drain-hub.pid')), false, 'the drain pidfile is removed');
    assert.match(res.stdout, /sent SIGTERM to drain-hub/);
    await settle();
    assert.equal(alive(plugin), true, 'the plugin server survives --keep-plugins');
    assert.ok(fs.existsSync(path.join(s.pidDir, 'plugin-fakeforge.pid')));
  } finally { s.cleanup(); }
});

test('the pipeline-stopped marker exists after a normal stop (and --keep-dashboard does not skip it)', SKIP, async () => {
  const s = sandbox();
  try {
    s.daemon('worker-fake.pid');
    assert.equal(fs.existsSync(s.markerFile), false);
    const res = s.runStop(['--keep-dashboard', '--keep-plugins']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(fs.existsSync(s.markerFile), true, 'the marker must exist once the daemons were signalled');
  } finally { s.cleanup(); }
});

test('the marker is created when there is nothing to stop: an empty pids folder and a missing pids folder', SKIP, () => {
  const empty = sandbox();
  try {
    assert.equal(empty.runStop(['--keep-dashboard']).status, 0);
    assert.equal(fs.existsSync(empty.markerFile), true, 'no pidfiles: the pipeline is stopped all the same');
  } finally { empty.cleanup(); }
  const missing = sandbox({ withPidDir: false });
  try {
    assert.equal(missing.runStop(['--keep-dashboard']).status, 0);
    assert.equal(fs.existsSync(missing.markerFile), true, 'no pids folder: the pipeline is stopped all the same');
  } finally { missing.cleanup(); }
});

test('the marker is created even when only plugin pidfiles exist (--keep-plugins)', SKIP, () => {
  const s = sandbox();
  try {
    s.daemon('plugin-fakeforge.pid');
    assert.equal(s.runStop(['--keep-dashboard', '--keep-plugins']).status, 0);
    assert.equal(fs.existsSync(s.markerFile), true);
  } finally { s.cleanup(); }
});

test('--force kills a drain that ignores SIGTERM at once, and the marker exists', SKIP, async () => {
  const s = sandbox();
  try {
    const stubborn = s.daemon('drain-stubborn.pid', { ignoreTerm: true });
    const res = s.runStop(['--keep-dashboard', '--keep-plugins', '--force']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(await gone(stubborn), true);
    assert.match(res.stdout, /force-killed drain-stubborn/);
    assert.equal(fs.existsSync(s.markerFile), true);
  } finally { s.cleanup(); }
});

test('a graceful stop leaves a drain that ignores SIGTERM until the grace period ends, then force-kills it (it is a daemon like the rest)', SKIP, async () => {
  const s = sandbox();
  try {
    const stubborn = s.daemon('drain-stubborn.pid', { ignoreTerm: true });
    const res = spawnSync('bash', [STOP_SH, '--keep-dashboard', '--keep-plugins'], {
      env: { ...process.env, HOME: s.tmp, AGENT_MANAGER_STOP_GRACE_SEC: '2', AGENT_MANAGER_STOP_ORPHAN_PATTERN: 'x-private', AGENT_MANAGER_STOP_STRAY_PATTERN: 'x-private' }, encoding: 'utf8', timeout: 30000,
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(await gone(stubborn), true);
    assert.match(res.stdout, /still alive after 2s grace/);
  } finally { s.cleanup(); }
});

test('launch.sh removes the marker as one of its first actions, before any daemon is started', SKIP, () => {
  const src = fs.readFileSync(LAUNCH_SH, 'utf8');
  const lines = src.split('\n');
  const rm = lines.findIndex((l) => l.trim() === 'rm -f "${STATE_DIR}/pipeline-stopped"');
  assert.ok(rm > 0, 'launch.sh has the marker removal line');
  assert.ok(lines.findIndex((l) => /^STATE_DIR=/.test(l)) < rm, 'STATE_DIR is defined before the removal');
  const firstStart = lines.findIndex((l) => /^\s*start_bg\b/.test(l) && !/^\s*start_bg\(\)/.test(l));
  assert.ok(firstStart > rm, 'the removal comes before the first start_bg');
  assert.ok(lines.findIndex((l) => l.includes('agent-manager-common.sh')) > rm, 'and before the common helpers that start things');
  // Run exactly that line in bash against a temp HOME: it removes an existing marker and does nothing (and does not fail) when there is none.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-marker-'));
  try {
    const state = path.join(tmp, 'state');
    fs.mkdirSync(state);
    fs.writeFileSync(path.join(state, 'pipeline-stopped'), '');
    const run = () => spawnSync('bash', ['-c', `set -u; STATE_DIR='${state}'; ${lines[rm].trim()}`], { encoding: 'utf8' });
    assert.equal(run().status, 0);
    assert.equal(fs.existsSync(path.join(state, 'pipeline-stopped')), false);
    assert.equal(run().status, 0, 'removing an absent marker is fine');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('stop.sh creates the marker only after signalling the daemons (an early failure to find pidfiles never skips signalling)', SKIP, () => {
  const lines = fs.readFileSync(STOP_SH, 'utf8').split('\n');
  const loopDone = lines.findIndex((l) => l.includes('# Poll for actual exit'));
  const before = lines.slice(0, loopDone).join('\n');
  const signal = before.lastIndexOf('kill -TERM');
  const mark = before.lastIndexOf('\nmark_stopped\n');
  assert.ok(signal > 0 && mark > signal, 'mark_stopped comes after the SIGTERM/force loop and before the wait');
  assert.equal((fs.readFileSync(STOP_SH, 'utf8').match(/^\s*mark_stopped$/gm) || []).length, 3, 'two early exits and the main path');
});
