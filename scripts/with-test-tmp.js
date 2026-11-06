#!/usr/bin/env node
'use strict';

// with-test-tmp.js -- run a command (normally the test suite) with TMPDIR on a RAM-backed directory instead of /tmp (ADR-0024: fewer disk calls).
//
// Why: /tmp is on the shared HDD. Test suites create thousands of throwaway git repos and temp dirs there; every `git init` / `git clone` fsyncs, and during one
// 150 s sample on 2026-11-03 that drove the disk to ~4,600 write IOPS at 100% busy and stalled every lane. Node's os.tmpdir() and Python's tempfile both read
// TMPDIR, so ONE redirect covers the suites without editing them (67 of the 69 git-fixture test files use os.tmpdir()/mkdtemp).
//
//   node scripts/with-test-tmp.js [--max-mb N] [--] <command> [args...]       e.g.  node scripts/with-test-tmp.js node --test src/foo.test.js
//
// The command gets TMPDIR/TEMP/TMP = <base>/run-<pid>-<start>/ , removed when it exits, is interrupted (SIGINT/SIGTERM/SIGHUP) or is killed for exceeding the cap.
//   AGENT_MANAGER_TEST_TMP            base directory (default /dev/shm/agent-manager-test); "off" runs the command unchanged
//   AGENT_MANAGER_TEST_TMP_MAX_MB     cap for one run's directory (default 1024). Over the cap the command is stopped with exit code 3: a fixture that
//                                     writes a gigabyte is a bug, and /dev/shm is RAM on a box with 19.9 GB
//   AGENT_MANAGER_TEST_TMP_MIN_FREE_MB  free space the base's filesystem must have to be used (default 1024); below it the command runs unchanged, with a notice
//   AGENT_MANAGER_TEST_TMP_POLL_MS    how often the cap is checked (default 10000)
// Run directories left by a crashed launcher (their pid is gone and they are over 5 minutes old) are removed at the next start.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_BASE = '/dev/shm/agent-manager-test';
const STALE_AGE_MS = 5 * 60 * 1000;

function num(v, d) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; }

function freeMb(dir, statfs = fs.statfsSync) {
  try { const s = statfs(dir); return (Number(s.bavail) * Number(s.bsize)) / (1024 * 1024); } catch { return 0; }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Removes run-<pid>-<start> directories whose launcher is gone. -> names removed.
function sweepStale(base, { now = Date.now(), alive = pidAlive, fsImpl = fs } = {}) {
  const removed = [];
  let names = [];
  try { names = fsImpl.readdirSync(base); } catch { return removed; }
  for (const name of names) {
    const m = /^run-(\d+)-(\d+)$/.exec(name);
    if (!m || alive(Number(m[1]))) continue;
    try {
      const st = fsImpl.statSync(path.join(base, name));
      if (now - st.mtimeMs < STALE_AGE_MS) continue;
      fsImpl.rmSync(path.join(base, name), { recursive: true, force: true });
      removed.push(name);
    } catch { /* gone already */ }
  }
  return removed;
}

// Size of a directory tree in bytes, stopping early once it passes `limit`.
function dirBytes(dir, limit = Infinity) {
  let total = 0;
  const stack = [dir];
  while (stack.length && total <= limit) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      try {
        if (e.isDirectory()) stack.push(p);
        else total += fs.lstatSync(p).size;
      } catch { /* vanished */ }
    }
  }
  return total;
}

function parseArgs(argv) {
  const out = { maxMb: null, cmd: [] };
  let i = 0;
  while (i < argv.length) {
    if (argv[i] === '--max-mb') { out.maxMb = Number(argv[i + 1]); i += 2; continue; }
    if (argv[i] === '--') { i++; break; }
    break;
  }
  out.cmd = argv.slice(i);
  return out;
}

function main(argv = process.argv.slice(2), env = process.env) {
  const { maxMb, cmd } = parseArgs(argv);
  if (!cmd.length) { console.error('usage: with-test-tmp.js [--max-mb N] [--] <command> [args...]'); return 2; }
  const baseRaw = env.AGENT_MANAGER_TEST_TMP;
  let runDir = null;
  const childEnv = { ...env };
  if (String(baseRaw).toLowerCase() !== 'off') {
    const base = baseRaw || DEFAULT_BASE;
    const parent = fs.existsSync(base) ? base : path.dirname(base);
    const need = num(env.AGENT_MANAGER_TEST_TMP_MIN_FREE_MB, 1024);
    if (freeMb(parent) < need) {
      console.error(`[with-test-tmp] ${parent} has under ${need} MB free: running without the RAM-backed temp directory`);
    } else {
      try {
        fs.mkdirSync(base, { recursive: true, mode: 0o700 });
        sweepStale(base);
        runDir = path.join(base, `run-${process.pid}-${Date.now()}`);
        fs.mkdirSync(runDir, { mode: 0o700 });
        childEnv.TMPDIR = childEnv.TEMP = childEnv.TMP = runDir;
      } catch (e) {
        console.error(`[with-test-tmp] cannot use ${base} (${e.code || e.message}): running without it`);
        runDir = null;
      }
    }
  }
  const capBytes = num(maxMb, num(env.AGENT_MANAGER_TEST_TMP_MAX_MB, 1024)) * 1024 * 1024;
  const pollMs = num(env.AGENT_MANAGER_TEST_TMP_POLL_MS, 10000);

  const child = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit', env: childEnv });
  let overCap = false;
  const cleanup = () => { if (runDir) { try { fs.rmSync(runDir, { recursive: true, force: true }); } catch { /* best effort */ } } };
  const forward = (sig) => () => { try { child.kill(sig); } catch { /* already gone */ } };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, forward(sig));
  const timer = runDir ? setInterval(() => {
    if (dirBytes(runDir, capBytes) > capBytes) {
      overCap = true;
      console.error(`[with-test-tmp] ${runDir} grew past ${Math.round(capBytes / 1048576)} MB: stopping the command (it is RAM on this machine). Raise AGENT_MANAGER_TEST_TMP_MAX_MB only if that is intended.`);
      try { child.kill('SIGTERM'); } catch { /* gone */ }
    }
  }, pollMs) : null;
  child.on('error', (e) => { console.error(`[with-test-tmp] cannot start ${cmd[0]}: ${e.message}`); if (timer) clearInterval(timer); cleanup(); process.exit(127); });
  child.on('exit', (code, signal) => {
    if (timer) clearInterval(timer);
    cleanup();
    process.exit(overCap ? 3 : code !== null ? code : 128 + ({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1 }[signal] || 1));
  });
  return null;
}

module.exports = { sweepStale, dirBytes, freeMb, parseArgs, DEFAULT_BASE };

if (require.main === module) {
  const code = main();
  if (code !== null) process.exit(code);
}
