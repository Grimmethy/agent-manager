'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { acquire, release, withLock, lockFilePath } = require('./single-flight-lock.js');

function makeInstancesDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'single-flight-lock-test-'));
}

test('lockFilePath matches the exact bash lockfile name (interop depends on this)', () => {
  const dir = makeInstancesDir();
  assert.equal(lockFilePath(dir), path.join(dir, '.pipeline-single-flight.lock'));
});

test('acquire then release: a second acquire() in the SAME process succeeds only after release()', () => {
  const dir = makeInstancesDir();
  const fd1 = acquire(dir);

  // A second acquire from a background child (bash flock, matching how a real other lane
  // would contend) must block until fd1 is released -- verified by timing, not just
  // "eventually returns".
  const start = Date.now();
  const child = require('child_process').spawn('bash', ['-c', `exec 200>"${lockFilePath(dir)}"; flock 200; echo ACQUIRED`]);
  let out = '';
  child.stdout.on('data', (d) => { out += d; });

  setTimeout(() => release(fd1), 300);

  return new Promise((resolve) => {
    child.on('exit', () => {
      const elapsed = Date.now() - start;
      assert.ok(out.includes('ACQUIRED'));
      assert.ok(elapsed >= 250, `expected the waiter to block until release (~300ms), only waited ${elapsed}ms`);
      resolve();
    });
  });
});

test('a real bash flock process blocks on a Node-held lock and acquires the instant Node releases (cross-mechanism interop)', () => {
  const dir = makeInstancesDir();
  const fd = acquire(dir);

  const result = spawnSync('bash', ['-c', `exec 200>"${lockFilePath(dir)}"; timeout 1 flock -n 200 && echo GOT_IT || echo BLOCKED`]);
  assert.match(result.stdout.toString(), /BLOCKED/, 'a non-blocking flock attempt must fail while Node still holds the lock');

  release(fd);

  const result2 = spawnSync('bash', ['-c', `exec 200>"${lockFilePath(dir)}"; timeout 1 flock -n 200 && echo GOT_IT || echo BLOCKED`]);
  assert.match(result2.stdout.toString(), /GOT_IT/, 'a non-blocking flock attempt must succeed once Node has released');
});

test('withLock releases even when the wrapped function throws', async () => {
  const dir = makeInstancesDir();
  await assert.rejects(
    withLock(dir, () => { throw new Error('boom'); }),
    /boom/,
  );

  // Lock must be free afterward -- a real bash flock -n attempt should succeed immediately.
  const result = spawnSync('bash', ['-c', `exec 200>"${lockFilePath(dir)}"; timeout 1 flock -n 200 && echo FREE || echo STILL_HELD`]);
  assert.match(result.stdout.toString(), /FREE/, 'withLock must release the lock even after the wrapped function throws');
});

test('withLock releases after a successful async function and returns its value', async () => {
  const dir = makeInstancesDir();
  const value = await withLock(dir, async () => {
    await new Promise((r) => setTimeout(r, 10));
    return 'real-result';
  });
  assert.equal(value, 'real-result');

  const result = spawnSync('bash', ['-c', `exec 200>"${lockFilePath(dir)}"; timeout 1 flock -n 200 && echo FREE || echo STILL_HELD`]);
  assert.match(result.stdout.toString(), /FREE/);
});

test('release is safe to call twice (matches release_single_flight_lock()\'s own best-effort semantics)', () => {
  const dir = makeInstancesDir();
  const fd = acquire(dir);
  release(fd);
  assert.doesNotThrow(() => release(fd));
});

test('release(null) is a safe no-op', () => {
  assert.doesNotThrow(() => release(null));
  assert.doesNotThrow(() => release(undefined));
});
