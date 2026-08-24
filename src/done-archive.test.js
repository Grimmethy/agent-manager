'use strict';

// Unit tests for done-archive.js -- built directly 2026-08-24 after the adhoc task meant
// to build this exhausted 5 draft retries without ever producing a diff (twice hitting
// max_turns without reaching a RESOLUTION line, twice degenerating into a "no-changes-
// needed" cop-out review correctly rejected). See that file's own header for the full
// production-incident context.
//
// Run: node --test src/done-archive.test.js  (or `npm test`)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  archiveDoneTasks, checkDue, listArchivedMonthDirs, retentionMs, statePath, monthBucket,
} = require('./done-archive.js');

function makePipelineDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'done-archive-test-'));
  fs.mkdirSync(path.join(dir, 'queue', 'done'), { recursive: true });
  return dir;
}

function writeDoneTask(pipelineDir, id, { mtimeMs } = {}) {
  const file = path.join(pipelineDir, 'queue', 'done', `${id}.json`);
  fs.writeFileSync(file, JSON.stringify({ id, status: 'done' }));
  if (mtimeMs != null) fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

function withEnv(overrides, fn) {
  const prior = {};
  for (const key of Object.keys(overrides)) prior[key] = process.env[key];
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (prior[key] === undefined) delete process.env[key];
      else process.env[key] = prior[key];
    }
  }
}

test('archiveDoneTasks moves a task older than the retention window into the current month bucket', () => {
  const pipelineDir = makePipelineDir();
  const now = Date.parse('2026-08-24T12:00:00Z');
  writeDoneTask(pipelineDir, 'old-task', { mtimeMs: now - 40 * 24 * 60 * 60 * 1000 }); // 40 days old

  const result = archiveDoneTasks({ pipelineDir, now });

  assert.equal(result.moved, 1);
  assert.equal(result.skipped, 0);
  assert.equal(fs.existsSync(path.join(pipelineDir, 'queue', 'done', 'old-task.json')), false);
  assert.equal(fs.existsSync(path.join(pipelineDir, 'queue', 'done', '_archived', '2026-08', 'old-task.json')), true);
});

test('archiveDoneTasks leaves a task inside the retention window alone', () => {
  const pipelineDir = makePipelineDir();
  const now = Date.parse('2026-08-24T12:00:00Z');
  writeDoneTask(pipelineDir, 'recent-task', { mtimeMs: now - 5 * 24 * 60 * 60 * 1000 }); // 5 days old

  const result = archiveDoneTasks({ pipelineDir, now });

  assert.equal(result.moved, 0);
  assert.equal(result.skipped, 1);
  assert.equal(fs.existsSync(path.join(pipelineDir, 'queue', 'done', 'recent-task.json')), true);
});

test('archiveDoneTasks respects AGENT_MANAGER_DONE_ARCHIVE_AFTER_DAYS instead of the 30-day default', () => {
  withEnv({ AGENT_MANAGER_DONE_ARCHIVE_AFTER_DAYS: '5' }, () => {
    const pipelineDir = makePipelineDir();
    const now = Date.parse('2026-08-24T12:00:00Z');
    writeDoneTask(pipelineDir, 'ten-days-old', { mtimeMs: now - 10 * 24 * 60 * 60 * 1000 });

    const result = archiveDoneTasks({ pipelineDir, now });

    assert.equal(result.moved, 1, 'a 10-day-old task must be archived once the retention window is set to 5 days');
  });
});

test('archiveDoneTasks never recurses into _archived_no_action/ or its own _archived/ folders', () => {
  const pipelineDir = makePipelineDir();
  const now = Date.parse('2026-08-24T12:00:00Z');
  const veryOld = now - 400 * 24 * 60 * 60 * 1000;

  fs.mkdirSync(path.join(pipelineDir, 'queue', 'done', '_archived_no_action'), { recursive: true });
  writeDoneTask(pipelineDir, 'manually-archived', {});
  fs.renameSync(
    path.join(pipelineDir, 'queue', 'done', 'manually-archived.json'),
    path.join(pipelineDir, 'queue', 'done', '_archived_no_action', 'manually-archived.json'),
  );
  fs.utimesSync(path.join(pipelineDir, 'queue', 'done', '_archived_no_action', 'manually-archived.json'), veryOld / 1000, veryOld / 1000);

  const result = archiveDoneTasks({ pipelineDir, now });

  assert.equal(result.moved, 0);
  assert.equal(fs.existsSync(path.join(pipelineDir, 'queue', 'done', '_archived_no_action', 'manually-archived.json')), true, 'must stay exactly where a human put it, never touched by the automatic pass');
});

test('archiveDoneTasks is idempotent -- running it twice the same day does not error or re-move anything', () => {
  const pipelineDir = makePipelineDir();
  const now = Date.parse('2026-08-24T12:00:00Z');
  writeDoneTask(pipelineDir, 'old-task', { mtimeMs: now - 40 * 24 * 60 * 60 * 1000 });

  const first = archiveDoneTasks({ pipelineDir, now });
  const second = archiveDoneTasks({ pipelineDir, now });

  assert.equal(first.moved, 1);
  assert.equal(second.moved, 0);
  assert.equal(second.skipped, 0);
  assert.deepEqual(second.errors, []);
});

test('archiveDoneTasks never deletes anything -- a moved file is still readable at its new location with identical content', () => {
  const pipelineDir = makePipelineDir();
  const now = Date.parse('2026-08-24T12:00:00Z');
  writeDoneTask(pipelineDir, 'old-task', { mtimeMs: now - 40 * 24 * 60 * 60 * 1000 });
  const originalContent = fs.readFileSync(path.join(pipelineDir, 'queue', 'done', 'old-task.json'), 'utf8');

  archiveDoneTasks({ pipelineDir, now });

  const movedContent = fs.readFileSync(path.join(pipelineDir, 'queue', 'done', '_archived', '2026-08', 'old-task.json'), 'utf8');
  assert.equal(movedContent, originalContent);
});

test('checkDue runs the real archive pass on first call (no state file yet) and persists lastArchivedAt', () => {
  const pipelineDir = makePipelineDir();
  const now = Date.parse('2026-08-24T12:00:00Z');
  writeDoneTask(pipelineDir, 'old-task', { mtimeMs: now - 40 * 24 * 60 * 60 * 1000 });

  const result = checkDue({ pipelineDir, now });

  assert.ok(result, 'must run on the first call, nothing recorded yet');
  assert.equal(result.moved, 1);
  const state = JSON.parse(fs.readFileSync(statePath(pipelineDir), 'utf8'));
  assert.equal(state.lastArchivedAt, new Date(now).toISOString());
});

test('checkDue returns null (skips the real pass) when called again the same day', () => {
  const pipelineDir = makePipelineDir();
  const now = Date.parse('2026-08-24T12:00:00Z');
  checkDue({ pipelineDir, now });

  writeDoneTask(pipelineDir, 'new-old-task', { mtimeMs: now - 40 * 24 * 60 * 60 * 1000 });
  const second = checkDue({ pipelineDir, now: now + 60 * 60 * 1000 }); // 1 hour later, same day

  assert.equal(second, null);
  assert.equal(fs.existsSync(path.join(pipelineDir, 'queue', 'done', 'new-old-task.json')), true, 'must not have been archived yet -- the real pass never ran');
});

test('checkDue runs again once RECHECK_INTERVAL_MS (24h) has actually elapsed', () => {
  const pipelineDir = makePipelineDir();
  const now = Date.parse('2026-08-24T12:00:00Z');
  checkDue({ pipelineDir, now });

  writeDoneTask(pipelineDir, 'next-day-old-task', { mtimeMs: now - 40 * 24 * 60 * 60 * 1000 });
  const second = checkDue({ pipelineDir, now: now + 25 * 60 * 60 * 1000 }); // 25h later

  assert.ok(second);
  assert.equal(second.moved, 1);
});

test('listArchivedMonthDirs returns every dated bucket, empty array when none exist yet', () => {
  const pipelineDir = makePipelineDir();
  assert.deepEqual(listArchivedMonthDirs(pipelineDir), []);

  const now = Date.parse('2026-08-24T12:00:00Z');
  writeDoneTask(pipelineDir, 'old-task', { mtimeMs: now - 40 * 24 * 60 * 60 * 1000 });
  archiveDoneTasks({ pipelineDir, now });

  const dirs = listArchivedMonthDirs(pipelineDir);
  assert.equal(dirs.length, 1);
  assert.match(dirs[0], /2026-08$/);
});

test('retentionMs defaults to 30 days when AGENT_MANAGER_DONE_ARCHIVE_AFTER_DAYS is unset', () => {
  withEnv({ AGENT_MANAGER_DONE_ARCHIVE_AFTER_DAYS: undefined }, () => {
    assert.equal(retentionMs(), 30 * 24 * 60 * 60 * 1000);
  });
});

test('monthBucket formats as YYYY-MM, zero-padded', () => {
  assert.equal(monthBucket(new Date(Date.UTC(2026, 0, 15))), '2026-01');
  assert.equal(monthBucket(new Date(Date.UTC(2026, 10, 1))), '2026-11');
});

test('archiveDoneTasks reports (not throws) when queue/done/ does not exist yet', () => {
  const pipelineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'done-archive-test-empty-'));
  const result = archiveDoneTasks({ pipelineDir, now: Date.now() });
  assert.equal(result.moved, 0);
  assert.ok(result.errors.length > 0);
});
