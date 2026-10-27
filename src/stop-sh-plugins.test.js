'use strict';

// Regression (2026-10-14): POST /api/pipeline/stop shells out to `scripts/stop.sh --keep-dashboard`, which
// killed EVERY pidfile in the pids folder -- including the plugin servers' plugin-<name>.pid (promptforge,
// characterforge, storyforge, videoforge...), which are not launch.sh daemons. `--keep-plugins` leaves them
// (and their pidfiles) alone; without the flag a bare `scripts/stop.sh` still stops everything.
//
// SAFETY: stop.sh ends with a system-wide `pgrep -f` stray sweep that SIGKILLs any local-worker.sh /
// review-runner.sh not in its pidfile list. Every test here points that sweep (AGENT_MANAGER_STOP_STRAY_PATTERN)
// and the orphan sweep (AGENT_MANAGER_STOP_ORPHAN_PATTERN) at private markers so a real pipeline running on
// the same machine can never be matched.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const STOP_SH = path.join(__dirname, '..', 'scripts', 'stop.sh');
const SKIP = { skip: process.platform === 'win32' };

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function sandbox() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-plugins-'));
  const pidDir = path.join(tmp, '.local', 'state', 'agent-manager', 'pids');
  fs.mkdirSync(pidDir, { recursive: true });
  const marker = `private-marker-${process.pid}-${Date.now()}`;
  const spawned = [];
  // A long-lived fake daemon with a pidfile, in its own session so stop.sh's SIGTERM reaches only it.
  function daemon(pidfileName, scriptName = 'fake-daemon.js') {
    const script = path.join(tmp, scriptName);
    fs.writeFileSync(script, 'setInterval(() => {}, 1000);\n');
    const child = spawn('node', [script], { detached: true, stdio: 'ignore' });
    child.unref();
    spawned.push(child.pid);
    fs.writeFileSync(path.join(pidDir, pidfileName), String(child.pid));
    return child.pid;
  }
  function runStop(args) {
    return spawnSync('bash', [STOP_SH, ...args], {
      env: { ...process.env, HOME: tmp, AGENT_MANAGER_STOP_GRACE_SEC: '5',
        AGENT_MANAGER_STOP_ORPHAN_PATTERN: marker, AGENT_MANAGER_STOP_STRAY_PATTERN: marker },
      encoding: 'utf8', timeout: 30000,
    });
  }
  function cleanup() {
    for (const pid of spawned) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return { tmp, pidDir, marker, daemon, runStop, cleanup };
}

const settle = () => new Promise((r) => setTimeout(r, 400));

test('keep-plugins flag: a plugin process and its pidfile survive; a pipeline daemon is still stopped and its pidfile removed', SKIP, async () => {
  const s = sandbox();
  try {
    const plugin = s.daemon('plugin-fakeforge.pid');
    const worker = s.daemon('worker-fake.pid');
    const res = s.runStop(['--keep-dashboard', '--keep-plugins']);
    assert.equal(res.status, 0, res.stderr);
    await settle();
    assert.equal(alive(plugin), true, 'plugin process must survive --keep-plugins');
    assert.ok(fs.existsSync(path.join(s.pidDir, 'plugin-fakeforge.pid')), 'plugin pidfile must remain');
    assert.match(res.stdout, /skipping plugin-fakeforge/);
    assert.equal(alive(worker), false, 'worker-style daemon must still be stopped');
    assert.equal(fs.existsSync(path.join(s.pidDir, 'worker-fake.pid')), false, 'worker pidfile must be removed');
  } finally { s.cleanup(); }
});

test('without --keep-plugins a bare stop still stops plugins too (CLI behaviour unchanged)', SKIP, async () => {
  const s = sandbox();
  try {
    const plugin = s.daemon('plugin-fakeforge.pid');
    const worker = s.daemon('worker-fake.pid');
    const res = s.runStop(['--keep-dashboard']);
    assert.equal(res.status, 0, res.stderr);
    await settle();
    assert.equal(alive(plugin), false, 'plugin must be stopped without the flag');
    assert.equal(alive(worker), false);
    assert.equal(fs.existsSync(path.join(s.pidDir, 'plugin-fakeforge.pid')), false);
  } finally { s.cleanup(); }
});

test('keep-plugins flag with ONLY plugin pidfiles present is a clean no-op (empty pid list)', SKIP, async () => {
  const s = sandbox();
  try {
    const plugin = s.daemon('plugin-fakeforge.pid');
    const res = s.runStop(['--keep-dashboard', '--keep-plugins']);
    assert.equal(res.status, 0, res.stderr);
    await settle();
    assert.equal(alive(plugin), true);
    assert.ok(fs.existsSync(path.join(s.pidDir, 'plugin-fakeforge.pid')));
  } finally { s.cleanup(); }
});

test('the stray-sweep pattern is overridable: a decoy local-worker.sh survives when the override names a private marker', SKIP, async () => {
  const s = sandbox();
  try {
    // A pidfile is required to get past the "no pidfiles" early exit and reach the stray sweep.
    s.daemon('worker-fake.pid');
    // Decoy: untracked by any pidfile, with scripts/local-worker.sh in its command line -- exactly what the
    // DEFAULT stray pattern kills. With the override pointing elsewhere it must be left alone.
    const decoyDir = path.join(s.tmp, 'scripts');
    fs.mkdirSync(decoyDir);
    const decoyScript = path.join(decoyDir, 'local-worker.sh');
    fs.writeFileSync(decoyScript, '#!/usr/bin/env bash\nsleep 300\n');
    const decoy = spawn('bash', [decoyScript, 'decoy'], { detached: true, stdio: 'ignore' });   // NOT containing the marker, or the overridden sweep would match it
    decoy.unref();
    assert.ok(alive(decoy.pid));
    try {
      const res = s.runStop(['--keep-dashboard', '--keep-plugins']);
      assert.equal(res.status, 0, res.stderr);
      await settle();
      assert.equal(alive(decoy.pid), true, 'override must keep the stray sweep away from the decoy');
      assert.doesNotMatch(res.stdout, /killed stray daemon/);
    } finally { try { process.kill(decoy.pid, 'SIGKILL'); } catch { /* gone */ } }
  } finally { s.cleanup(); }
});

test('the default stray-sweep patterns are unchanged when the override is not set', () => {
  // Cannot be proven by RUNNING stop.sh without the override (that would kill a real pipeline's workers on a
  // dev machine), so pin the exact original patterns in the script text instead.
  const text = fs.readFileSync(STOP_SH, 'utf8');
  assert.ok(text.includes(String.raw`pgrep -f 'scripts/(local-worker|review-runner)\.sh|python/dashboard/app\.py'`), 'dashboard-included default pattern');
  assert.ok(text.includes(String.raw`pgrep -f 'scripts/(local-worker|review-runner)\.sh' 2>/dev/null`), '--keep-dashboard default pattern');
  // and the override only applies when explicitly set and non-empty
  assert.match(text, /if \[\[ -n "\$\{AGENT_MANAGER_STOP_STRAY_PATTERN:-\}" \]\]; then/);
});
