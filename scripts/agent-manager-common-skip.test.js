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
// Cases:
//   1. skip + fresh marker + move.x key        -> returns rc=0 (no wall-clock threshold;
//                                                 a backoff hang is caught by a hard timeout cap)
//   2. no skip + fresh marker + model.qwen-test -> still blocks (timeout 124)
//   3. no skip + fresh marker + model.move.x    -> still blocks (timeout 124); proves no prefix matching
//   4. apply-task.sh keeps passing "skip" (static assertion)
//
// These tests source the REAL shipped function (not a copy) in a throwaway bash with a
// fresh INSTANCES_DIR, so they fail if the skip argument is removed from the function
// (the skip-path call would then block in backoff until the timeout) and if the "skip"
// flag is dropped from apply-task.sh's acquire call (static assertion at the bottom).
//
// Determinism: every case sets DISCUSS_PRIORITY_MAX_WAIT_SEC explicitly (120s, far above
// any test window) so the backoff ceiling never depends on the 900s default. The blocking
// cases use `timeout 5` as an inherent "still blocked" assertion (124 == killed while
// waiting); the skip case uses `timeout 10` as a hard cap, so a skip path that wrongly
// sat in backoff fails instead of hanging. No sleeps, polling, or elapsed-time thresholds.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const COMMON_SH = path.join(__dirname, 'agent-manager-common.sh');
const APPLY_SH = path.join(__dirname, 'apply-task.sh');

// Explicit backoff ceiling for every case (see header).
const MAX_WAIT_LINE = 'DISCUSS_PRIORITY_MAX_WAIT_SEC=120';

function freshInstancesDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfl-skip-test-'));
  // Simulated active-priority condition: a user-interactive (Discuss) waiter dropped a
  // marker THIS instant, so it is fresh (age < the function's 15s freshness window).
  // mtime is set explicitly to now so freshness does not depend on filename timestamps.
  const dsc = path.join(dir, '.discuss-waiting');
  fs.mkdirSync(dsc);
  const marker = path.join(dsc, `waiter-${process.pid}-${Date.now()}`);
  fs.writeFileSync(marker, 'discuss-turn marker\n');
  const now = new Date();
  fs.utimesSync(marker, now, now);
  return dir;
}

function acquireScript(instancesDir, key, skipArg, extraLine) {
  const skipTok = skipArg ? `"${skipArg}"` : '';
  return [
    'set -u',
    `INSTANCES_DIR=${JSON.stringify(instancesDir)}`,
    extraLine || '',
    `source ${JSON.stringify(COMMON_SH)}`,
    `acquire_single_flight_lock "${key}" ${skipTok}; rc=$?`,
    'echo "rc=$rc"',
  ].filter(Boolean).join('\n');
}

test('with a fresh .discuss-waiting/ marker, the skip argument returns rc=0 without sitting in backoff', () => {
  const dir = freshInstancesDir();
  try {
    // timeout 10 is a hard cap, not a timing threshold: a skip path that wrongly sat in the
    // 120s backoff would be killed here and fail (status 124).
    const script = acquireScript(dir, 'move.x', 'skip', MAX_WAIT_LINE);
    const r = spawnSync('timeout', ['10', 'bash', '-c', script], { encoding: 'utf8', timeout: 20000 });
    assert.equal(r.status, 0, `skip-path must return within the 10s cap, not sit in backoff (got status ${r.status}): ` + r.stdout + r.stderr);
    assert.match(r.stdout, /rc=0/, 'skip-path must acquire (lock is free, only backoff was in the way): ' + r.stdout + r.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('without the skip argument, a model-style key with a fresh marker blocks the waiter (timeout 124)', () => {
  const dir = freshInstancesDir();
  try {
    const script = acquireScript(dir, 'model.qwen-test', null, MAX_WAIT_LINE);
    const r = spawnSync('timeout', ['5', 'bash', '-c', script], { encoding: 'utf8', timeout: 20000 });
    assert.equal(r.status, 124, `without skip, a model key with a fresh marker must stay blocked in backoff -- expected timeout(124), got ${r.status}: ` + r.stdout + r.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('without the skip argument, the key model.move.x still blocks (no prefix matching on "move.")', () => {
  const dir = freshInstancesDir();
  try {
    const script = acquireScript(dir, 'model.move.x', null, MAX_WAIT_LINE);
    const r = spawnSync('timeout', ['5', 'bash', '-c', script], { encoding: 'utf8', timeout: 20000 });
    assert.equal(r.status, 124, `model.move.x without skip must stay blocked -- expected timeout(124), got ${r.status}: ` + r.stdout + r.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('without the skip argument, the same fresh marker blocks the waiter (timeout 124)', () => {
  const dir = freshInstancesDir();
  try {
    // DISCUSS_PRIORITY_MAX_WAIT_SEC=120 keeps the backoff's own ceiling far beyond the
    // 5s test window (default 900s) so a waiter that should block cannot slip out early.
    const script = acquireScript(dir, 'move.block-test', null, MAX_WAIT_LINE);
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
