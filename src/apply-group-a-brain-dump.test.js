'use strict';

// Regression test for the brain_dump_sort staleness no-op (HUB0041 2/2).
//
// The guard in src/apply-group-a-brain-dump.js (applyBrainDumpSort core) refuses to
// classify when the entry was edited or its status changed since this task was drafted
// (entry.status !== 'captured' || entry.rawText !== the drafted rawText), and the
// wrapper in src/apply-group-a.js (HUB0050 2/3) re-states that as a distinct
// non-success shape: { skipped: true, stale: true, success: false, reason } -- with NO
// sortAttempt bump and NO status write. src/apply-group-a.test.js has one stale case
// but only pins result.skipped + the reason string; this file pins the full non-success
// shape (stale/success flags, no file written) and the "entry left exactly as-is" side
// effect, so the stale no-op can never silently regress to a success-shaped or
// recoverable-sort-shaped return that apply-task.js would misroute.
//
// NOTE: the task brief mentions a `result.retryable === true` assertion, but the code
// intentionally does NOT emit a retryable field on this path -- stale is terminal for
// THIS task's pass (a FRESH sort task under a new id supersedes it; retrying this task
// can never apply), which is precisely why recoverableSortSkip is not used. So we
// assert the shape the code actually returns.
//
// Run: node --test src/apply-group-a-brain-dump.test.js  (or `npm test`)

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { applyBrainDumpSort } = require('./apply-group-a.js');

function brainDumpEntry(overrides = {}) {
  return { id: 'bd-1', capturedAt: '2026-07-22T00:00:00.000Z', rawText: 'original', status: 'captured', ...overrides };
}

function writeBrainDump(dir, entries) {
  const brainDumpPath = path.join(dir, 'brain-dump.json');
  fs.writeFileSync(brainDumpPath, JSON.stringify({ entries }, null, 2));
  return brainDumpPath;
}

test('applyBrainDumpSort stale no-op: edited rawText since drafting -> non-success shape, entry left untouched', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-brain-dump-stale-'));
  const secondBrainDir = path.join(dir, 'secondbrain');
  const brainDumpEntryId = 'bd-1';
  const brainDumpPath = writeBrainDump(dir, [brainDumpEntry()]); // status 'captured', rawText 'original'

  // Task was drafted against the ORIGINAL text the entry had at draft time.
  const task = { promptContext: { brainDumpEntryId, rawText: 'original' } };

  // Simulate the dashboard's edit endpoint: same entry, changed text, status reset to 'captured'.
  const data = JSON.parse(fs.readFileSync(brainDumpPath, 'utf8'));
  data.entries[0].rawText = 'edited after drafting';
  fs.writeFileSync(brainDumpPath, JSON.stringify(data, null, 2));

  // A perfectly valid classification -- irrelevant, the guard fires before it is ever parsed.
  const implementResponse = JSON.stringify({ category: 'idea', secondBrainPath: 'Ideas/x.md' });
  const result = applyBrainDumpSort({ implementResponse, task, brainDumpPath, secondBrainDir });

  // Distinct non-success shape -- not a success shape (no file), not a recoverable-sort shape.
  assert.equal(result.skipped, true);
  assert.equal(result.stale, true);
  assert.equal(result.success, false);
  assert.match(result.reason, /changed since this task was drafted/);
  assert.equal(result.file, undefined);
  assert.equal(result.recoverable, undefined);

  // Entry left exactly as-is: status still 'captured' (a fresh sort classifies it),
  // no sortAttempt bump burned on this superseded task, no queuedTaskId/sort fields.
  const entries = JSON.parse(fs.readFileSync(brainDumpPath, 'utf8')).entries;
  assert.equal(entries[0].status, 'captured');
  assert.equal(entries[0].rawText, 'edited after drafting');
  assert.equal(entries[0].sortAttempt, undefined);

  // Nothing was written to the second brain either.
  assert.equal(fs.existsSync(secondBrainDir), false);
});

test('applyBrainDumpSort stale no-op: status moved off captured since drafting -> same non-success shape', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-brain-dump-stale-'));
  const secondBrainDir = path.join(dir, 'secondbrain');
  const brainDumpEntryId = 'bd-2';
  const brainDumpPath = writeBrainDump(dir, [
    { id: brainDumpEntryId, capturedAt: '2026-07-22T00:00:00.000Z', rawText: 'original', status: 'sorted' },
  ]);

  // Drafted when the entry was 'captured'; something else sorted it in the meantime.
  const task = { promptContext: { brainDumpEntryId, rawText: 'original' } };
  const implementResponse = JSON.stringify({ category: 'idea', secondBrainPath: 'Ideas/x.md' });
  const result = applyBrainDumpSort({ implementResponse, task, brainDumpPath, secondBrainDir });

  assert.equal(result.skipped, true);
  assert.equal(result.stale, true);
  assert.equal(result.success, false);
  assert.equal(result.file, undefined);

  const entries = JSON.parse(fs.readFileSync(brainDumpPath, 'utf8')).entries;
  assert.equal(entries[0].status, 'sorted'); // untouched -- the guard writes nothing
  assert.equal(entries[0].sortAttempt, undefined);
});
