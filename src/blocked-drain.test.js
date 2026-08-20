'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { requeueBlockedTasksForSignature } = require('./blocked-drain.js');

function tempPipelineDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'blocked-drain-test-'));
}

function writeBlocked(dir, id, task) {
  const blockedDir = path.join(dir, 'queue', 'blocked');
  fs.mkdirSync(blockedDir, { recursive: true });
  fs.writeFileSync(path.join(blockedDir, `${id}.json`), JSON.stringify({ id, ...task }));
}

test('requeueBlockedTasksForSignature moves every task matching the signature to pending, stripped to a fresh shape', () => {
  const dir = tempPipelineDir();
  writeBlocked(dir, 'arch-import-x-1', {
    source: 'arch_import', domain: 'default', title: 'X-1',
    promptContext: { itemId: '1' },
    history: [{ stage: 'harness-search', detail: '3 quer(y/ies), 0 hit(s), 0 file(s)' }],
    blockedReason: 'no grounding',
    ornithRejectCount: 2,
  });
  writeBlocked(dir, 'arch-import-x-2', {
    source: 'arch_import', domain: 'default', title: 'X-2',
    promptContext: { itemId: '2' },
    history: [{ stage: 'harness-search', detail: '2 quer(y/ies), 0 hit(s), 0 file(s)' }],
  });
  // A different signature -- must NOT be touched.
  writeBlocked(dir, 'other-task', {
    source: 'manual', blockedReason: 'The draft fabricates a repo that does not exist.',
  });

  const { requeuedIds } = requeueBlockedTasksForSignature(dir, 'arch_import::harness-search-zero-results');

  assert.deepEqual(requeuedIds.sort(), ['arch-import-x-1', 'arch-import-x-2']);
  assert.equal(fs.existsSync(path.join(dir, 'queue', 'blocked', 'arch-import-x-1.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'queue', 'blocked', 'other-task.json')), true);

  const pending = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'pending', 'arch-import-x-1.json'), 'utf8'));
  assert.equal(pending.status, 'pending');
  assert.equal(pending.title, 'X-1');
  assert.equal(pending.ornithRejectCount, undefined); // stripped -- a fresh do-over, not a continuation
  assert.equal(pending.blockedReason, undefined);
  assert.match(pending.history[0].note, /auto-requeued/);
  assert.match(pending.history[0].note, /arch_import::harness-search-zero-results/);
});

test('requeueBlockedTasksForSignature does not touch a task that already has a pending entry', () => {
  const dir = tempPipelineDir();
  writeBlocked(dir, 'arch-import-x-1', {
    source: 'arch_import',
    history: [{ stage: 'harness-search', detail: '0 hit(s), 0 file(s)' }],
  });
  fs.mkdirSync(path.join(dir, 'queue', 'pending'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'queue', 'pending', 'arch-import-x-1.json'), JSON.stringify({ id: 'arch-import-x-1', marker: 'do-not-clobber' }));

  const { requeuedIds } = requeueBlockedTasksForSignature(dir, 'arch_import::harness-search-zero-results');

  assert.deepEqual(requeuedIds, []);
  assert.equal(fs.existsSync(path.join(dir, 'queue', 'blocked', 'arch-import-x-1.json')), true, 'left in blocked/ since pending/ already has an entry');
  const pending = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'pending', 'arch-import-x-1.json'), 'utf8'));
  assert.equal(pending.marker, 'do-not-clobber');
});

test('requeueBlockedTasksForSignature on a missing blocked/ dir returns an empty result, not a throw', () => {
  const dir = tempPipelineDir();
  assert.deepEqual(requeueBlockedTasksForSignature(dir, 'arch_import::harness-search-zero-results'), { requeuedIds: [] });
});

test('requeueBlockedTasksForSignature skips a malformed blocked file instead of throwing', () => {
  const dir = tempPipelineDir();
  fs.mkdirSync(path.join(dir, 'queue', 'blocked'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'queue', 'blocked', 'bad.json'), '{not valid json');
  assert.doesNotThrow(() => requeueBlockedTasksForSignature(dir, 'arch_import::harness-search-zero-results'));
});

test('requeueBlockedTasksForSignature matches by re-derived signature, not a stored field', () => {
  const dir = tempPipelineDir();
  // No harness-search history at all -- categorized purely from blockedReason text.
  writeBlocked(dir, 'manual-1', { source: 'manual', blockedReason: 'The draft is a refusal (no-changes-needed).' });
  const { requeuedIds } = requeueBlockedTasksForSignature(dir, 'manual::refusal-no-changes-needed');
  assert.deepEqual(requeuedIds, ['manual-1']);
});
