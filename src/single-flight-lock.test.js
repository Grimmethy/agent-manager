'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { acquire, release, withLock, lockFilePath, queueDirPath } = require('./single-flight-lock.js');

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

// acquire(): bounded wait ------------------------------------------------------------
// 2026-08-27, root-caused live: `lslocks` reported this exact lockfile held by a PID
// that no longer existed -- some prior holder died in a way that left the flock()
// unreleased, and every real waiter across all three daemons sat blocked for 20+
// minutes with zero recovery path. acquire() used to be a genuinely unbounded blocking
// call; this proves the new SINGLE_FLIGHT_LOCK_TIMEOUT_SECS-bounded wait actually times
// out (rather than hanging the test suite itself) and that the thrown message contains
// "timed out" -- the literal word local-worker.sh's/review-runner.sh's shared
// INFRA_FAILURE_PATTERN matches on, without which a lock timeout would have been
// miscategorized as a permanent content failure instead of a retryable infra one.
// 2026-08-31: the stuck holder must be a DIFFERENT process now -- a second acquire()
// from THIS process is reentrant (granted immediately, see the reentrancy tests below),
// which is the whole point of that fix. A real leaked/stuck lock only ever comes from
// another process's open file description.
test('acquire() times out (instead of hanging forever) when another process holds the lock, with a message matching INFRA_FAILURE_PATTERN', async () => {
  const dir = makeInstancesDir();
  // A background bash process grabs the lock and sits on it, never releasing within the test.
  const holder = require('child_process').spawn('bash', ['-c', `exec 200>"${lockFilePath(dir)}"; flock 200; sleep 30`]);
  await new Promise((r) => setTimeout(r, 200)); // let the holder actually acquire
  const prevTimeout = process.env.SINGLE_FLIGHT_LOCK_TIMEOUT_SECS;
  process.env.SINGLE_FLIGHT_LOCK_TIMEOUT_SECS = '1';
  try {
    assert.throws(() => acquire(dir), /timed out/);
  } finally {
    if (prevTimeout === undefined) delete process.env.SINGLE_FLIGHT_LOCK_TIMEOUT_SECS;
    else process.env.SINGLE_FLIGHT_LOCK_TIMEOUT_SECS = prevTimeout;
    holder.kill('SIGKILL');
  }
});

test('acquire() timing out does not leak the fd it opened for the failed attempt', async () => {
  const dir = makeInstancesDir();
  const holder = require('child_process').spawn('bash', ['-c', `exec 200>"${lockFilePath(dir)}"; flock 200; sleep 30`]);
  await new Promise((r) => setTimeout(r, 200));
  const prevTimeout = process.env.SINGLE_FLIGHT_LOCK_TIMEOUT_SECS;
  process.env.SINGLE_FLIGHT_LOCK_TIMEOUT_SECS = '1';
  try {
    assert.throws(() => acquire(dir));
  } finally {
    if (prevTimeout === undefined) delete process.env.SINGLE_FLIGHT_LOCK_TIMEOUT_SECS;
    else process.env.SINGLE_FLIGHT_LOCK_TIMEOUT_SECS = prevTimeout;
  }
  holder.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 150)); // let the kernel drop the killed holder's lock

  // The lock must be immediately acquirable now -- if the failed attempt's fd leaked, a
  // stray open file description could keep the kernel lock table confused.
  const result = spawnSync('bash', ['-c', `exec 200>"${lockFilePath(dir)}"; timeout 1 flock -n 200 && echo FREE || echo STILL_HELD`]);
  assert.match(result.stdout.toString(), /FREE/);
});

// per-process reentrancy -----------------------------------------------------------
// 2026-08-31: the actual bug that made task bra-1788142124203 fail 19 times. A tier is
// wrapped in maybeLocked() -> withLock(dir, fn, MODEL) (whole-tier hold); inside fn,
// local-tool-client.js's runPlanWithTools() takes withLock(dir, ..., MODEL) again PER
// TURN. Same process, same key, different open file description -> the inner flock(2)
// blocked on the outer one for the full 600s timeout, every turn. A lock this process
// already holds is now re-granted immediately and released only when the outermost
// holder releases.
test('a second acquire() for the same key in the same process is granted immediately (reentrant), not blocked', () => {
  const dir = makeInstancesDir();
  const outer = acquire(dir, 'm');
  const start = Date.now();
  const inner = acquire(dir, 'm');
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 200, `reentrant acquire must be immediate, took ${elapsed}ms`);
  assert.equal(typeof inner, 'object'); // an opaque reentrant token, not a raw fd
  release(inner);
  release(outer);
});

test('reentrant depth: the lock stays held until the OUTERMOST holder releases', () => {
  const dir = makeInstancesDir();
  const stillHeld = () => spawnSync('bash', ['-c', `exec 200>"${lockFilePath(dir, 'm')}"; timeout 1 flock -n 200 && echo FREE || echo HELD`]).stdout.toString();

  const a = acquire(dir, 'm');
  const b = acquire(dir, 'm');
  const c = acquire(dir, 'm');
  assert.match(stillHeld(), /HELD/);
  release(c);
  assert.match(stillHeld(), /HELD/, 'still held after releasing the 3rd (innermost) acquire');
  release(b);
  assert.match(stillHeld(), /HELD/, 'still held after releasing the 2nd acquire');
  release(a);
  assert.match(stillHeld(), /FREE/, 'free only after the outermost release');
});

test('reentrancy is per-key: two different keys in the same process each take a real lock', () => {
  const dir = makeInstancesDir();
  const m1 = acquire(dir, 'm1');
  const m2 = acquire(dir, 'm2'); // NOT reentrant -- different lockfile
  assert.equal(typeof m2, 'number', 'a different key must be a real fd, not a reentrant token');
  const heldA = spawnSync('bash', ['-c', `exec 200>"${lockFilePath(dir, 'm1')}"; timeout 1 flock -n 200 && echo FREE || echo HELD`]).stdout.toString();
  const heldB = spawnSync('bash', ['-c', `exec 200>"${lockFilePath(dir, 'm2')}"; timeout 1 flock -n 200 && echo FREE || echo HELD`]).stdout.toString();
  assert.match(heldA, /HELD/);
  assert.match(heldB, /HELD/);
  release(m2);
  release(m1);
});

test('withLock nested on the same key completes without self-deadlock (the bra-1788142124203 scenario)', async () => {
  const dir = makeInstancesDir();
  const start = Date.now();
  const value = await withLock(dir, async () => {
    return withLock(dir, async () => {
      const held2 = spawnSync('bash', ['-c', `exec 200>"${lockFilePath(dir, 'm')}"; timeout 1 flock -n 200 && echo FREE || echo HELD`]).stdout.toString();
      assert.match(held2, /HELD/, 'the lock is genuinely held while inside the nested withLock');
      return 'nested-ok';
    }, 'm');
  }, 'm');
  const elapsed = Date.now() - start;
  assert.equal(value, 'nested-ok');
  assert.ok(elapsed < 2000, `nested withLock must not stall on the lock, took ${elapsed}ms`);

  const freed = spawnSync('bash', ['-c', `exec 200>"${lockFilePath(dir, 'm')}"; timeout 1 flock -n 200 && echo FREE || echo HELD`]).stdout.toString();
  assert.match(freed, /FREE/, 'both nested holds released after the outer withLock returns');
});

// FIFO ticket queue --------------------------------------------------------------
// 2026-08-31: flock(2) has no ordering guarantee, so under sustained contention a third
// consumer starves (in the incident, worker-reasoning lost the acquire race to worker-1
// + the reviewer for 600s straight, every attempt). Waiters now queue by timestamped
// ticket and only attempt the real flock once at the head of the line.
test('FIFO: staggered waiters acquire in enqueue order', async () => {
  const dir = makeInstancesDir();
  const outFile = path.join(dir, 'order.log');
  fs.writeFileSync(outFile, '');
  const sflPath = require.resolve('./single-flight-lock.js');

  const gate = acquire(dir, 'k'); // hold it so both waiters must queue

  const mkWaiter = (label, delayMs) => require('child_process').spawn('node', ['-e', `
    const { acquire, release } = require(${JSON.stringify(sflPath)});
    const fs = require('fs');
    setTimeout(() => {
      const fd = acquire(${JSON.stringify(dir)}, 'k');
      fs.appendFileSync(${JSON.stringify(outFile)}, ${JSON.stringify(label)} + String.fromCharCode(10));
      setTimeout(() => release(fd), 60);
    }, ${delayMs});
  `], { stdio: ['ignore', 'ignore', 'inherit'] });

  const a = mkWaiter('A', 0);
  const b = mkWaiter('B', 150); // B enqueues clearly after A

  setTimeout(() => release(gate), 500); // release once both are queued

  await Promise.all([a, b].map((c) => new Promise((r) => c.on('exit', r))));
  assert.equal(fs.readFileSync(outFile, 'utf8').trim(), 'A\nB', 'the earlier-enqueued waiter (A) must be granted first');
});

test('FIFO: a ticket owned by a dead pid is swept and does not wedge the queue', () => {
  const dir = makeInstancesDir();
  const qdir = queueDirPath(dir, 'k');
  fs.mkdirSync(qdir, { recursive: true });
  // Oldest-possible ticket, owned by a pid that cannot exist.
  fs.writeFileSync(path.join(qdir, '00000000000000000001.999999.deadbeef'), '');

  const start = Date.now();
  const fd = acquire(dir, 'k');
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 2000, `a dead-pid ticket must not block a live acquire, took ${elapsed}ms`);
  assert.deepEqual(fs.readdirSync(qdir).filter((n) => /^\d{20}\./.test(n)), [], 'the stale ticket was swept and our own ticket cleaned up');
  release(fd);
});
