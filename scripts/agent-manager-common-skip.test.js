'use strict';

// HUB0157 4/4 -- guard for the bash skip-priority-backoff (the twin of
// src/single-flight-lock.js's skip path): scripts/agent-manager-common.sh's
// acquire_single_flight_lock() takes an optional 2nd argument "skip". With a FRESH
// marker in .discuss-waiting/ (the dashboard's Discuss-turn priority signal), a call
// WITHOUT skip must sit in the discuss-priority backoff (that is its whole purpose:
// yield headroom for the user-interactive waiter to win the flock wakeup race); a call
// WITH skip must return immediately -- that is what lets apply-task.sh's task-move lock
// stop waiting on a Chat turn instead of sitting in backoff (the 15-minute-move report).
//
// These tests source the REAL shipped function (not a copy) in a throwaway bash with a
// fresh INSTANCES_DIR, so they fail if the skip argument is removed from the function
// (the skip-path call would then block in backoff until the timeout) and if the "skip"
// flag is dropped from apply-task.sh's acquire call (static assertion at the bottom).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const COMMON_SH = path.join(__dirname, 'agent-manager-common.sh');
const APPLY_SH = path.join(__dirname, 'apply-task.sh');

function freshInstancesDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfl-skip-test-'));
  // Simulated active-priority condition: a user-interactive (Discuss) waiter dropped a
  // marker THIS instant, so it is fresh (age < the function's 15s freshness window).
  fs.mkdirSync(path.join(dir, '.discuss-waiting'));
  fs.writeFileSync(path.join(dir, '.discuss-waiting', `waiter-${process.pid}-${Date.now()}`), 'discuss-turn marker\n');
  return dir;
}

function acquireScript(instancesDir, key, skipArg, extraLine) {
  const skipTok = skipArg ? `"${skipArg}"` : '';
  return [
    'set -u',
    `INSTANCES_DIR=${JSON.stringify(instancesDir)}`,
    extraLine || '',
    `source ${JSON.stringify(COMMON_SH)}`,
    't0=$(date +%s%N)',
    `acquire_single_flight_lock "${key}" ${skipTok}; rc=$?`,
    't1=$(date +%s%N)',
    'echo "rc=$rc elapsed_ms=$(( (t1 - t0) / 1000000 ))"',
  ].filter(Boolean).join('\n');
}

test('with a fresh .discuss-waiting/ marker, the skip argument returns immediately (rc=0, <2s)', () => {
  const dir = freshInstancesDir();
  try {
    const r = spawnSync('bash', ['-c', acquireScript(dir, 'move.skip-test', 'skip')], { encoding: 'utf8', timeout: 20000 });
    assert.equal(r.status, 0, 'skip-path bash exited non-zero: ' + r.stdout + r.stderr);
    assert.match(r.stdout, /rc=0/, 'skip-path must acquire (lock is free, only backoff was in the way): ' + r.stdout + r.stderr);
    const ms = Number((r.stdout.match(/elapsed_ms=(\d+)/) || [])[1]);
    assert.ok(Number.isFinite(ms) && ms < 2000, `skip-path must return immediately, not sit in backoff -- took ${ms}ms: ` + r.stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('without the skip argument, the same fresh marker blocks the waiter (timeout 124)', () => {
  const dir = freshInstancesDir();
  try {
    // DISCUSS_PRIORITY_MAX_WAIT_SEC=120 keeps the backoff's own ceiling far beyond the
    // 5s test window (default 900s) so a waiter that should block cannot slip out early.
    const script = acquireScript(dir, 'move.block-test', null, 'DISCUSS_PRIORITY_MAX_WAIT_SEC=120');
    const r = spawnSync('timeout', ['5', 'bash', '-c', script], { encoding: 'utf8', timeout: 20000 });
    assert.equal(r.status, 124, `without skip, a fresh marker must keep the waiter blocked in backoff -- expected timeout(124), got ${r.status}: ` + r.stdout + r.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('apply-task.sh still passes the "skip" flag to acquire_single_flight_lock (the wiring this guards)', () => {
  const src = fs.readFileSync(APPLY_SH, 'utf8');
  assert.match(src, /acquire_single_flight_lock[^\n]*"skip"/, 'apply-task.sh must keep calling acquire_single_flight_lock with the "skip" argument');
});
