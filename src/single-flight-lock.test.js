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

test('acquire() backs off while .discuss-waiting/ is non-empty, then proceeds once the marker is removed', () => {
  const dir = makeInstancesDir();
  const waitDir = path.join(dir, '.discuss-waiting');
  fs.mkdirSync(waitDir);
  const marker = path.join(waitDir, 'fake-discuss-session');
  fs.writeFileSync(marker, '');

  // acquire() is synchronous (blocks the calling process), so run it in a real child
  // process and remove the marker from THIS process after a short delay -- proves the
  // child's backoff loop actually notices the marker disappearing mid-wait rather than
  // just running out its own fixed deadline.
  const child = require('child_process').spawn('node', ['-e', `
    const { acquire, release } = require(${JSON.stringify(require.resolve('./single-flight-lock.js'))});
    const start = Date.now();
    const fd = acquire(${JSON.stringify(dir)});
    process.stdout.write(String(Date.now() - start));
    release(fd);
  `]);
  let out = '';
  child.stdout.on('data', (d) => { out += d; });

  setTimeout(() => fs.unlinkSync(marker), 1200);

  return new Promise((resolve) => {
    child.on('exit', () => {
      const elapsedMs = Number(out);
      assert.ok(elapsedMs >= 1000, `expected the child to back off for at least ~1s while the marker existed, took ${elapsedMs}ms`);
      assert.ok(elapsedMs < 6000, `expected the child to proceed well before the 8s max-wait once the marker was removed, took ${elapsedMs}ms`);
      resolve();
    });
  });
});

test('acquire() does not back off at all when .discuss-waiting/ is absent or empty', () => {
  const dir = makeInstancesDir();
  const start = Date.now();
  const fd = acquire(dir);
  const elapsedMs = Date.now() - start;
  release(fd);
  assert.ok(elapsedMs < 500, `expected no backoff with nothing waiting, took ${elapsedMs}ms`);
});

test('lockFilePath matches the exact bash lockfile name (interop depends on this)', () => {
  const dir = makeInstancesDir();
  assert.equal(lockFilePath(dir), path.join(dir, '.pipeline-single-flight.lock'));
});

test('lockFilePath with a key returns a distinct per-model lockfile', () => {
  const dir = makeInstancesDir();
  assert.equal(lockFilePath(dir, 'qwen2.5:3b'), path.join(dir, '.pipeline-single-flight.qwen2.5_3b.lock'));
  assert.notEqual(lockFilePath(dir, 'qwen2.5:3b'), lockFilePath(dir));
});

test('two different keys can be held concurrently -- the actual throughput fix', () => {
  const dir = makeInstancesDir();
  const fdA = acquire(dir, 'model-a');
  try {
    const result = spawnSync('bash', ['-c', `exec 200>"${lockFilePath(dir, 'model-b')}"; timeout 1 flock -n 200 && echo GOT_IT || echo BLOCKED`]);
    assert.match(result.stdout.toString(), /GOT_IT/, 'a lock held on model-a must not block a real flock attempt on model-b\'s own lockfile');
  } finally {
    release(fdA);
  }
});

test('the same key still serializes against itself, same as the old global lock did', () => {
  const dir = makeInstancesDir();
  const fdA = acquire(dir, 'model-a');
  try {
    const result = spawnSync('bash', ['-c', `exec 200>"${lockFilePath(dir, 'model-a')}"; timeout 1 flock -n 200 && echo GOT_IT || echo BLOCKED`]);
    assert.match(result.stdout.toString(), /BLOCKED/, 'a lock held on model-a must still block another attempt on the SAME key');
  } finally {
    release(fdA);
  }
});

test('withLock passes its key through to acquire', async () => {
  const dir = makeInstancesDir();
  await withLock(dir, async () => {
    const result = spawnSync('bash', ['-c', `exec 200>"${lockFilePath(dir, 'model-a')}"; timeout 1 flock -n 200 && echo GOT_IT || echo BLOCKED`]);
    assert.match(result.stdout.toString(), /BLOCKED/, 'withLock(dir, fn, "model-a") must actually lock model-a\'s own lockfile');
  }, 'model-a');
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
