'use strict';

// Unit tests for reclaim-orphaned-drafts.js -- see its own header for the real incident
// this exists to prevent (60 real tasks silently stuck in queue/drafting/worker-1/ for
// as long as ~19 hours, invisible to every dashboard tab, because nothing ever
// reconciled a dead worker's claimed files back into the queue).
//
// Run: node --test src/reclaim-orphaned-drafts.test.js  (or `npm test`)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { reclaimOrphanedDrafts, destinationDirFor } = require('./reclaim-orphaned-drafts.js');

function tempPipelineDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'reclaim-orphaned-drafts-test-'));
}

function writeDraftingTask(pipelineDir, instanceId, task) {
  const dir = path.join(pipelineDir, 'queue', 'drafting', instanceId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${task.id}.json`), JSON.stringify(task));
}

test('destinationDirFor sends adhoc/research domains back to their own claim source, everything else to pending', () => {
  assert.equal(destinationDirFor('adhoc'), 'adhoc');
  assert.equal(destinationDirFor('research'), 'research');
  assert.equal(destinationDirFor('default'), 'pending');
  assert.equal(destinationDirFor(undefined), 'pending');
});

test('reclaims an orphaned adhoc task back into queue/adhoc/, not pending/', () => {
  const dir = tempPipelineDir();
  writeDraftingTask(dir, 'worker-1', { id: 'adhoc-test-1', domain: 'adhoc', title: 'x', history: [] });

  const result = reclaimOrphanedDrafts({ pipelineDir: dir, instanceId: 'worker-1' });

  assert.equal(result.reclaimed, 1);
  assert.deepEqual(result.ids, ['adhoc-test-1']);
  assert.ok(fs.existsSync(path.join(dir, 'queue', 'adhoc', 'adhoc-test-1.json')));
  assert.ok(!fs.existsSync(path.join(dir, 'queue', 'drafting', 'worker-1', 'adhoc-test-1.json')));
});

test('reclaims an orphaned research task back into queue/research/', () => {
  const dir = tempPipelineDir();
  writeDraftingTask(dir, 'worker-reasoning', { id: 'research-test-1', domain: 'research', title: 'x', history: [] });

  const result = reclaimOrphanedDrafts({ pipelineDir: dir, instanceId: 'worker-reasoning' });

  assert.equal(result.reclaimed, 1);
  assert.ok(fs.existsSync(path.join(dir, 'queue', 'research', 'research-test-1.json')));
});

test('reclaims a plain-domain task back into queue/pending/', () => {
  const dir = tempPipelineDir();
  writeDraftingTask(dir, 'worker-1', { id: 'plain-test-1', domain: 'default', title: 'x', history: [] });

  const result = reclaimOrphanedDrafts({ pipelineDir: dir, instanceId: 'worker-1' });

  assert.equal(result.reclaimed, 1);
  assert.ok(fs.existsSync(path.join(dir, 'queue', 'pending', 'plain-test-1.json')));
});

test('stamps a history event recording the reclaim', () => {
  const dir = tempPipelineDir();
  writeDraftingTask(dir, 'worker-1', { id: 'hist-test-1', domain: 'default', title: 'x', history: [] });

  reclaimOrphanedDrafts({ pipelineDir: dir, instanceId: 'worker-1' });

  const written = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'pending', 'hist-test-1.json'), 'utf8'));
  const last = written.history[written.history.length - 1];
  assert.equal(last.stage, 'reclaimed');
  assert.match(last.detail, /Orphaned claim from a prior worker-1 process/);
});

test('does nothing (empty result) when the instance has no drafting/ folder at all', () => {
  const dir = tempPipelineDir();
  const result = reclaimOrphanedDrafts({ pipelineDir: dir, instanceId: 'worker-1' });
  assert.deepEqual(result, { reclaimed: 0, ids: [] });
});

test('does nothing when a DIFFERENT instance has orphaned files -- only reclaims its own', () => {
  const dir = tempPipelineDir();
  writeDraftingTask(dir, 'worker-reasoning', { id: 'other-worker-task', domain: 'default', title: 'x', history: [] });

  const result = reclaimOrphanedDrafts({ pipelineDir: dir, instanceId: 'worker-1' });

  assert.deepEqual(result, { reclaimed: 0, ids: [] });
  assert.ok(fs.existsSync(path.join(dir, 'queue', 'drafting', 'worker-reasoning', 'other-worker-task.json')), 'must leave the other instance\'s file untouched');
});

test('never clobbers an existing file already at the destination -- leaves it for manual investigation instead', () => {
  const dir = tempPipelineDir();
  writeDraftingTask(dir, 'worker-1', { id: 'dup-test-1', domain: 'default', title: 'orphaned copy', history: [] });
  const pendingDir = path.join(dir, 'queue', 'pending');
  fs.mkdirSync(pendingDir, { recursive: true });
  fs.writeFileSync(path.join(pendingDir, 'dup-test-1.json'), JSON.stringify({ id: 'dup-test-1', title: 'the real one already here' }));

  const result = reclaimOrphanedDrafts({ pipelineDir: dir, instanceId: 'worker-1' });

  assert.equal(result.reclaimed, 0);
  // The orphaned copy stays in drafting/ rather than silently overwriting what's in pending/.
  assert.ok(fs.existsSync(path.join(dir, 'queue', 'drafting', 'worker-1', 'dup-test-1.json')));
  const stillThere = JSON.parse(fs.readFileSync(path.join(pendingDir, 'dup-test-1.json'), 'utf8'));
  assert.equal(stillThere.title, 'the real one already here');
});

test('skips an unreadable/malformed file rather than throwing, and still reclaims the good ones', () => {
  const dir = tempPipelineDir();
  const draftingDir = path.join(dir, 'queue', 'drafting', 'worker-1');
  fs.mkdirSync(draftingDir, { recursive: true });
  fs.writeFileSync(path.join(draftingDir, 'broken.json'), '{not valid json');
  writeDraftingTask(dir, 'worker-1', { id: 'good-task', domain: 'default', title: 'x', history: [] });

  const result = reclaimOrphanedDrafts({ pipelineDir: dir, instanceId: 'worker-1' });

  assert.equal(result.reclaimed, 1);
  assert.deepEqual(result.ids, ['good-task']);
  // The broken file is left in place for a future run to try again, not deleted.
  assert.ok(fs.existsSync(path.join(draftingDir, 'broken.json')));
});

test('reclaims multiple orphaned tasks in one pass', () => {
  const dir = tempPipelineDir();
  writeDraftingTask(dir, 'worker-1', { id: 'multi-1', domain: 'adhoc', title: 'x', history: [] });
  writeDraftingTask(dir, 'worker-1', { id: 'multi-2', domain: 'default', title: 'x', history: [] });
  writeDraftingTask(dir, 'worker-1', { id: 'multi-3', domain: 'research', title: 'x', history: [] });

  const result = reclaimOrphanedDrafts({ pipelineDir: dir, instanceId: 'worker-1' });

  assert.equal(result.reclaimed, 3);
  assert.ok(fs.existsSync(path.join(dir, 'queue', 'adhoc', 'multi-1.json')));
  assert.ok(fs.existsSync(path.join(dir, 'queue', 'pending', 'multi-2.json')));
  assert.ok(fs.existsSync(path.join(dir, 'queue', 'research', 'multi-3.json')));
});
