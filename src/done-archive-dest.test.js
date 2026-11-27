'use strict';

process.env.AGENT_MANAGER_DONE_ARCHIVE_AFTER_DAYS = '30';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  archiveDoneTasks, archiveSpecificDoneTasks, monthBucket, ARCHIVE_DIRNAME,
} = require('./done-archive.js');

const NOW = Date.UTC(2026, 6, 15, 12, 0, 0); // 2026-07-15
const NOW_AUG = Date.UTC(2026, 7, 20, 12, 0, 0); // 2026-08-20
const RECENT = NOW - 24 * 60 * 60 * 1000;
const OLD_MTIME = Date.UTC(2026, 0, 1); // far outside the 30-day window

function setup() {
  const pipelineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'done-archive-'));
  const doneDir = path.join(pipelineDir, 'queue', 'done');
  fs.mkdirSync(doneDir, { recursive: true });
  return { pipelineDir, doneDir };
}

function writeTask(doneDir, id, mtimeMs) {
  const p = path.join(doneDir, `${id}.json`);
  fs.writeFileSync(p, JSON.stringify({ id }));
  const t = new Date(mtimeMs);
  fs.utimesSync(p, t, t);
  return p;
}

function bucketDir(doneDir, now) {
  return path.join(doneDir, ARCHIVE_DIRNAME, monthBucket(new Date(now)));
}

test('explicit-id pass moves a recently-modified task into the current month bucket', () => {
  const { pipelineDir, doneDir } = setup();
  writeTask(doneDir, 'T1', RECENT);
  const r = archiveSpecificDoneTasks({ pipelineDir, taskIds: ['T1'], now: NOW });
  assert.strictEqual(r.moved, 1);
  assert.ok(fs.existsSync(path.join(bucketDir(doneDir, NOW), 'T1.json')));
  assert.ok(!fs.existsSync(path.join(doneDir, 'T1.json')));
});

test('time-based pass moves an old task and counts a fresh one as skipped', () => {
  const { pipelineDir, doneDir } = setup();
  writeTask(doneDir, 'OLD', OLD_MTIME);
  writeTask(doneDir, 'FRESH', RECENT);
  const r = archiveDoneTasks({ pipelineDir, now: NOW });
  assert.strictEqual(r.moved, 1);
  assert.strictEqual(r.skipped, 1);
  assert.ok(fs.existsSync(path.join(bucketDir(doneDir, NOW), 'OLD.json')));
  assert.ok(fs.existsSync(path.join(doneDir, 'FRESH.json')));
});

test('bucket is chosen from now, not from file mtime', () => {
  const { pipelineDir, doneDir } = setup();
  writeTask(doneDir, 'OLD', OLD_MTIME);
  const r = archiveDoneTasks({ pipelineDir, now: NOW_AUG });
  assert.strictEqual(r.moved, 1);
  assert.ok(fs.existsSync(path.join(doneDir, ARCHIVE_DIRNAME, '2026-08', 'OLD.json')));
});

test('empty time-based pass creates no _archived/ directory', () => {
  const { pipelineDir, doneDir } = setup();
  const r = archiveDoneTasks({ pipelineDir, now: NOW });
  assert.strictEqual(r.moved, 0);
  assert.ok(!fs.existsSync(path.join(doneDir, ARCHIVE_DIRNAME)));
});

test('explicit id with no file is counted as missing and the batch continues', () => {
  const { pipelineDir, doneDir } = setup();
  writeTask(doneDir, 'T2', RECENT);
  const r = archiveSpecificDoneTasks({ pipelineDir, taskIds: ['NOPE', 'T2'], now: NOW });
  assert.strictEqual(r.missing, 1);
  assert.strictEqual(r.moved, 1);
});

test('non-json entries and existing archive buckets are never touched', () => {
  const { pipelineDir, doneDir } = setup();
  fs.writeFileSync(path.join(doneDir, 'notes.txt'), 'x');
  const oldBucket = path.join(doneDir, ARCHIVE_DIRNAME, '2026-01');
  fs.mkdirSync(oldBucket, { recursive: true });
  const archived = writeTask(oldBucket, 'ARCH', OLD_MTIME);
  archiveDoneTasks({ pipelineDir, now: NOW });
  assert.ok(fs.existsSync(path.join(doneDir, 'notes.txt')));
  assert.ok(fs.existsSync(archived));
});
