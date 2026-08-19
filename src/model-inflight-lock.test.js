'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { acquire, release, readActiveLocks, STALE_MS } = require('./model-inflight-lock.js');

function tempInstancesDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'model-inflight-lock-test-'));
}

test('acquire creates a lock file readable by readActiveLocks', () => {
  const dir = tempInstancesDir();
  const lockPath = acquire(dir, 'ornith:35b', 'worker-1');
  assert.ok(lockPath);
  const active = readActiveLocks(dir);
  assert.equal(active.length, 1);
  assert.equal(active[0].model, 'ornith:35b');
  assert.equal(active[0].instanceId, 'worker-1');
});

test('release removes the lock so readActiveLocks no longer sees it', () => {
  const dir = tempInstancesDir();
  const lockPath = acquire(dir, 'ornith:35b', 'worker-1');
  release(lockPath);
  assert.deepEqual(readActiveLocks(dir), []);
});

test('release(null) and double-release are no-ops', () => {
  const dir = tempInstancesDir();
  release(null);
  const lockPath = acquire(dir, 'ornith:35b', 'worker-1');
  release(lockPath);
  release(lockPath); // already gone -- must not throw
});

test('concurrent locks for the SAME model both remain visible independently', () => {
  const dir = tempInstancesDir();
  const a = acquire(dir, 'ornith:35b', 'worker-1');
  const b = acquire(dir, 'ornith:35b', 'reviewer');
  assert.equal(readActiveLocks(dir).length, 2);
  release(a);
  assert.equal(readActiveLocks(dir).length, 1);
  release(b);
  assert.equal(readActiveLocks(dir).length, 0);
});

test('readActiveLocks skips a stale (crashed, never-released) lock', () => {
  const dir = tempInstancesDir();
  const lockPath = acquire(dir, 'qwen3.8:27b-q4_K_M', 'worker-reasoning');
  const old = Date.now() - (STALE_MS + 60_000);
  fs.utimesSync(lockPath, old / 1000, old / 1000);
  assert.deepEqual(readActiveLocks(dir), []);
});

test('readActiveLocks on a missing locks dir returns empty, not a throw', () => {
  const dir = tempInstancesDir();
  assert.deepEqual(readActiveLocks(path.join(dir, 'does-not-exist')), []);
});

test('acquire degrades to null (never throws) when instancesDir is unusable', () => {
  // A file where a directory is expected -- mkdirSync must fail.
  const dir = tempInstancesDir();
  const blocker = path.join(dir, 'blocked');
  fs.writeFileSync(blocker, 'not a directory');
  const lockPath = acquire(path.join(blocker, 'instances'), 'ornith:35b', 'worker-1');
  assert.equal(lockPath, null);
});
