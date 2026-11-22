'use strict';

// Tests for src/stuck-task-notifier.js using node:test.
//
// All tests use temp dirs and fake collaborators (notifyFn, readTask). No network, no real
// watcher, no disk state outside the temp dirs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { scanOnce, seenKey, STATES } = require('./stuck-task-notifier.js');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `stuck-test-${prefix}-`));
}

function writeJsonAtomic(file, data) {
  const dir = path.dirname(file);
  if (dir) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

function makeNotifyFn() {
  const calls = [];
  const state = { failNext: false };
  async function notifyFn(message) {
    calls.push(message);
    if (state.failNext) {
      state.failNext = false;
      return { sent: false, reason: 'error' };
    }
    return { sent: true, reason: 'sent' };
  }
  notifyFn.calls = calls;
  notifyFn.setFail = (v) => { state.failNext = v; };
  return notifyFn;
}

function makeReadTask(files) {
  return function readTask(fullPath) {
    const rel = path.relative(files.root, fullPath);
    const data = files.data[rel];
    if (data === undefined) throw new Error(`no fixture for ${rel}`);
    return JSON.stringify(data);
  };
}

function buildFixture(dir, layout) {
  // layout: { 'queue/blocked/foo.json': { id, title, premiumPriority, blockedReason }, ... }
  const files = { root: dir, data: {} };
  for (const [rel, task] of Object.entries(layout)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, JSON.stringify(task));
    files.data[rel] = task;
  }
  return files;
}

test('first run: existing entries are recorded silently', async () => {
  const dir = tmpDir('first-run');
  const queueDir = path.join(dir, 'queue');
  const seenPath = path.join(dir, 'seen.json');
  buildFixture(queueDir, {
    'blocked/a.json': { id: 'a', title: 'Alpha', premiumPriority: true, blockedReason: 'stuck' },
    'blocked/b.json': { id: 'b', title: 'Beta', premiumPriority: false, blockedReason: 'blocked' },
    'needs-clarification/c.json': { id: 'c', title: 'Charlie', premiumPriority: true, clarificationQuestion: 'what?' },
  });
  const notifyFn = makeNotifyFn();
  const result = await scanOnce({
    queueDirs: [queueDir],
    seenPath,
    notifyFn,
    readTask: (f) => fs.readFileSync(f, 'utf8'),
  });
  assert.equal(result.isNew, true);
  assert.equal(result.notified, 0);
  assert.equal(notifyFn.calls.length, 0);
  // All entries recorded.
  const seen = JSON.parse(fs.readFileSync(seenPath, 'utf8'));
  assert.equal(Object.keys(seen.entries).length, 3);
});

test('new premium blocked task notifies once', async () => {
  const dir = tmpDir('new-premium');
  const queueDir = path.join(dir, 'queue');
  const seenPath = path.join(dir, 'seen.json');
  // Pre-populate seen so this is not a first run.
  writeJsonAtomic(seenPath, { version: 1, entries: {} });
  const blockedDir = path.join(queueDir, 'blocked');
  fs.mkdirSync(blockedDir, { recursive: true });
  const taskFile = path.join(blockedDir, 'new.json');
  fs.writeFileSync(taskFile, JSON.stringify({
    id: 'new',
    title: 'New Task',
    premiumPriority: true,
    blockedReason: 'waiting on dependency',
  }));
  // Set mtime to something we can reference.
  const stat = fs.statSync(taskFile);
  const notifyFn = makeNotifyFn();
  const result = await scanOnce({
    queueDirs: [queueDir],
    seenPath,
    notifyFn,
    readTask: (f) => fs.readFileSync(f, 'utf8'),
  });
  assert.equal(result.isNew, false);
  assert.equal(result.notified, 1);
  assert.equal(notifyFn.calls.length, 1);
  const call = notifyFn.calls[0];
  assert.equal(call.level, 'urgent');
  assert.equal(call.key, 'stuck:blocked:new');
  assert.ok(call.title.includes('premium'));
  assert.ok(call.text.includes('waiting on dependency'));
  // Recorded in seen.
  const seen = JSON.parse(fs.readFileSync(seenPath, 'utf8'));
  assert.ok(seen.entries[seenKey(queueDir, 'new', stat.mtimeMs)]);
});

test('new non-premium blocked task never notifies', async () => {
  const dir = tmpDir('non-premium');
  const queueDir = path.join(dir, 'queue');
  const seenPath = path.join(dir, 'seen.json');
  writeJsonAtomic(seenPath, { version: 1, entries: {} });
  const blockedDir = path.join(queueDir, 'blocked');
  fs.mkdirSync(blockedDir, { recursive: true });
  const taskFile = path.join(blockedDir, 'plain.json');
  fs.writeFileSync(taskFile, JSON.stringify({
    id: 'plain',
    title: 'Plain Task',
    premiumPriority: false,
    blockedReason: 'nothing',
  }));
  const stat = fs.statSync(taskFile);
  const notifyFn = makeNotifyFn();
  const result = await scanOnce({
    queueDirs: [queueDir],
    seenPath,
    notifyFn,
    readTask: (f) => fs.readFileSync(f, 'utf8'),
  });
  assert.equal(result.notified, 0);
  assert.equal(notifyFn.calls.length, 0);
  // Still recorded as seen.
  const seen = JSON.parse(fs.readFileSync(seenPath, 'utf8'));
  assert.ok(seen.entries[seenKey(queueDir, 'plain', stat.mtimeMs)]);
});

test('same file seen twice notifies only once', async () => {
  const dir = tmpDir('duplicate');
  const queueDir = path.join(dir, 'queue');
  const seenPath = path.join(dir, 'seen.json');
  // Pre-populate seen with the entry.
  const blockedDir = path.join(queueDir, 'blocked');
  fs.mkdirSync(blockedDir, { recursive: true });
  const taskFile = path.join(blockedDir, 'dup.json');
  fs.writeFileSync(taskFile, JSON.stringify({
    id: 'dup',
    title: 'Dup',
    premiumPriority: true,
    blockedReason: 'x',
  }));
  const stat = fs.statSync(taskFile);
  writeJsonAtomic(seenPath, {
    version: 1,
    entries: { [seenKey(queueDir, 'dup', stat.mtimeMs)]: true },
  });
  const notifyFn = makeNotifyFn();
  const result = await scanOnce({
    queueDirs: [queueDir],
    seenPath,
    notifyFn,
    readTask: (f) => fs.readFileSync(f, 'utf8'),
  });
  assert.equal(result.notified, 0);
  assert.equal(notifyFn.calls.length, 0);
});

test('re-entered task (new mtime) notifies again', async () => {
  const dir = tmpDir('reenter');
  const queueDir = path.join(dir, 'queue');
  const seenPath = path.join(dir, 'seen.json');
  const blockedDir = path.join(queueDir, 'blocked');
  fs.mkdirSync(blockedDir, { recursive: true });
  // First version of the file.
  const taskFile = path.join(blockedDir, 're.json');
  fs.writeFileSync(taskFile, JSON.stringify({
    id: 're',
    title: 'Re-entered',
    premiumPriority: true,
    blockedReason: 'old reason',
  }));
  const oldStat = fs.statSync(taskFile);
  // Record the old mtime as seen.
  writeJsonAtomic(seenPath, {
    version: 1,
    entries: { [seenKey(queueDir, 're', oldStat.mtimeMs)]: true },
  });
  // Update the file (new mtime).
  fs.writeFileSync(taskFile, JSON.stringify({
    id: 're',
    title: 'Re-entered',
    premiumPriority: true,
    blockedReason: 'new reason',
  }));
  const newStat = fs.statSync(taskFile);
  assert.notEqual(newStat.mtimeMs, oldStat.mtimeMs, 'test precondition: mtime must change');
  const notifyFn = makeNotifyFn();
  const result = await scanOnce({
    queueDirs: [queueDir],
    seenPath,
    notifyFn,
    readTask: (f) => fs.readFileSync(f, 'utf8'),
  });
  assert.equal(result.notified, 1);
  assert.equal(notifyFn.calls.length, 1);
  assert.ok(notifyFn.calls[0].text.includes('new reason'));
});

test('notify failure does not mark task as seen', async () => {
  const dir = tmpDir('fail');
  const queueDir = path.join(dir, 'queue');
  const seenPath = path.join(dir, 'seen.json');
  writeJsonAtomic(seenPath, { version: 1, entries: {} });
  const blockedDir = path.join(queueDir, 'blocked');
  fs.mkdirSync(blockedDir, { recursive: true });
  const taskFile = path.join(blockedDir, 'fail.json');
  fs.writeFileSync(taskFile, JSON.stringify({
    id: 'fail',
    title: 'Fail Task',
    premiumPriority: true,
    blockedReason: 'network error',
  }));
  const stat = fs.statSync(taskFile);
  const notifyFn = makeNotifyFn();
  notifyFn.setFail(true);
  const result = await scanOnce({
    queueDirs: [queueDir],
    seenPath,
    notifyFn,
    readTask: (f) => fs.readFileSync(f, 'utf8'),
  });
  assert.equal(result.notified, 0);
  // Key NOT recorded.
  const seen = JSON.parse(fs.readFileSync(seenPath, 'utf8'));
  assert.equal(seen.entries[seenKey(queueDir, 'fail', stat.mtimeMs)], undefined);
});
