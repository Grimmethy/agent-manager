'use strict';

// Unit tests for requeue-attribution.js's recordSuppression() -- the durable attribution
// record written for a suppressed (zero-hit) requeue event. Matches this codebase's own
// established convention (see requeue-attribution.test.js): real throwaway temp dirs as
// the repoRoot, exercising the function exactly as the real writer calls it, no mocks.
//
// The core safety property under test: the dedup key is taskId, NOT signature. Two
// distinct tasks that happen to share a signature must each get their own suppression
// file -- otherwise a suppressed neighbor would silently shadow a distinct task that
// legitimately needs to run.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { recordSuppression } = require('./requeue-attribution.js');

function freshDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('creates a suppression file for each taskId even when signatures match', () => {
  const dir = freshDir('suppression-test-');
  const sharedSignature = 'query:SELECT * FROM t WHERE x=1';
  const res1 = recordSuppression({ taskId: 'task-001', signature: sharedSignature, zeroHitGroupSize: 3, repoRoot: dir });
  const res2 = recordSuppression({ taskId: 'task-002', signature: sharedSignature, zeroHitGroupSize: 5, repoRoot: dir });

  // The two distinct taskIds must map to two DISTINCT files -- if the key were signature,
  // both would point at the same path and this is the case that would wrongly be dropped.
  assert.ok(res1, 'recordSuppression returned a result for task-001');
  assert.ok(res2, 'recordSuppression returned a result for task-002');
  assert.notEqual(res1.file, res2.file, 'two distinct taskIds must not collide onto one suppression file');
  assert.ok(fs.existsSync(res1.file), 'task-001 suppression file is missing');
  assert.ok(fs.existsSync(res2.file), 'task-002 suppression file is missing');
});

test('is idempotent when called twice for the same taskId', () => {
  const dir = freshDir('suppression-test-');
  const args = { taskId: 'task-010', signature: 'sig-A', zeroHitGroupSize: 2, repoRoot: dir };
  const first = recordSuppression(args);
  const file = first.file;
  const firstContent = fs.readFileSync(file, 'utf8');

  const second = recordSuppression(args);
  const secondContent = fs.readFileSync(file, 'utf8');

  assert.equal(first.filed, true, 'first call must file the record');
  assert.equal(second.filed, false, 'second call for the same taskId must not re-file');
  assert.equal(second.deduped, true, 'second call should be reported as deduped');
  assert.equal(firstContent, secondContent, 'file content must not change on the second call');
});

test('writes a file containing "suppressed" and the correct zeroHitGroupSize', () => {
  const dir = freshDir('suppression-test-');
  const res = recordSuppression({ taskId: 'task-020', signature: 'sig-B', zeroHitGroupSize: 7, repoRoot: dir });
  const content = fs.readFileSync(res.file, 'utf8');

  assert.ok(content.includes('suppressed'), 'file does not contain the string "suppressed"');
  const parsed = JSON.parse(content);
  assert.equal(parsed.status, 'suppressed', 'record.status is not "suppressed"');
  assert.equal(parsed.zeroHitGroupSize, 7, 'zeroHitGroupSize is not preserved correctly');
});

test('does not create a file and does not throw when taskId is absent', () => {
  const dir = freshDir('suppression-test-');
  let result;
  assert.doesNotThrow(() => {
    result = recordSuppression({ signature: 'sig-C', zeroHitGroupSize: 1, repoRoot: dir });
  });
  assert.equal(result, null, 'without a taskId recordSuppression must not file anything');

  const dirPath = path.join(dir, 'queue', 'suppression-attribution');
  if (fs.existsSync(dirPath)) {
    const entries = fs.readdirSync(dirPath);
    assert.equal(entries.length, 0, 'no suppression file should exist without a taskId');
  }
});
