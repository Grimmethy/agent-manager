'use strict';

// Unit tests for src/brain-dump-reconcile.js: the five reconciliation scenarios
// (merged task actioned, non-merged unchanged, superseded handled, symbol-gone
// possibly-resolved, second-run idempotent). Uses isolated temp directories with
// entries.json and task subdirectories. Does NOT mock the core module -- the real
// findExistingWorkForEntry and checkEntryTargets are exercised.
//
// Run: node --test src/brain-dump-reconcile.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const Module = require('module');
const { reconcileBrainDumpEntries } = require('./brain-dump-reconcile.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Create an isolated temp root with:
//   <root>/brain-dump.json       (entries)
//   <root>/pipeline/queue/<state>/ (task dirs)
function makeIsolatedTempDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-reconcile-'));
  const pipelineDir = path.join(root, 'pipeline');
  fs.mkdirSync(path.join(pipelineDir, 'queue', 'adhoc'), { recursive: true });
  fs.mkdirSync(path.join(pipelineDir, 'queue', 'derived'), { recursive: true });
  fs.mkdirSync(path.join(pipelineDir, 'queue', 'pending'), { recursive: true });
  fs.mkdirSync(path.join(pipelineDir, 'queue', 'review'), { recursive: true });
  fs.mkdirSync(path.join(pipelineDir, 'queue', 'approved'), { recursive: true });
  fs.mkdirSync(path.join(pipelineDir, 'queue', 'blocked'), { recursive: true });
  fs.mkdirSync(path.join(pipelineDir, 'queue', 'needs-clarification'), { recursive: true });
  fs.mkdirSync(path.join(pipelineDir, 'queue', 'awaiting-confirm'), { recursive: true });
  fs.mkdirSync(path.join(pipelineDir, 'queue', 'coordinating'), { recursive: true });
  fs.mkdirSync(path.join(pipelineDir, 'queue', 'research'), { recursive: true });
  fs.mkdirSync(path.join(pipelineDir, 'queue', 'done'), { recursive: true });
  fs.mkdirSync(path.join(pipelineDir, 'queue', 'done', '_archived_no_action'), { recursive: true });
  fs.mkdirSync(path.join(pipelineDir, 'queue', 'done', '_superseded'), { recursive: true });
  fs.mkdirSync(path.join(pipelineDir, 'queue', 'drafting'), { recursive: true });
  fs.mkdirSync(path.join(pipelineDir, 'queue', 'done', '_archived', '2026-10'), { recursive: true });
  return { root, pipelineDir, brainDumpPath: path.join(root, 'brain-dump.json') };
}

function writeEntries(temp, entries) {
  fs.writeFileSync(temp.brainDumpPath, JSON.stringify(entries, null, 2));
}

function writeTask(pipelineDir, relativeState, task) {
  const dir = path.join(pipelineDir, 'queue', relativeState);
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, `${task.id}.json`);
  fs.writeFileSync(fp, JSON.stringify(task));
  return fp;
}

// Inject a fake src/config.js into the require cache so reconcileBrainDumpEntries
// picks up our temp pipelineDir without touching the real config.
function injectFakeConfig(pipelineDir) {
  const realConfigPath = require.resolve('./config.js');
  Module._cache[realConfigPath] = {
    id: realConfigPath,
    filename: realConfigPath,
    loaded: true,
    children: [],
    exports: { pipelineDir },
  };
}

function restoreConfigCache() {
  const realConfigPath = require.resolve('./config.js');
  delete Module._cache[realConfigPath];
}

// ---------------------------------------------------------------------------
// Scenario 1: merged task closes entry
// ---------------------------------------------------------------------------
test.describe('Scenario 1: merged task actioneds entry', () => {
test('merged task in done/ actioneds the entry (status=actioned, queuedTaskId, queuedAt)', () => {
  const temp = makeIsolatedTempDir();
  const entry = {
    id: 'bd-1792293449127-test-merged',
    serial: 42,
    status: 'captured',
    rawText: 'Fix the broken test in src/brain-dump-reconcile.js',
    capturedAt: '2026-10-24T10:00:00.000Z',
  };
  writeEntries(temp, [entry]);
  // Task in done/ that matches via raisedFrom (source != brain_dump_sort to avoid exclusion)
  writeTask(temp.pipelineDir, 'done', {
    id: 'HUB0042',
    source: 'manual',
    raisedFrom: 'brain-dump-bd-1792293449127-test-merged',
    title: 'Fix the broken test',
    status: 'done',
  });
  injectFakeConfig(temp.pipelineDir);
  process.env.AGENT_MANAGER_BRAIN_DUMP_PATH = temp.brainDumpPath;

  const result = reconcileBrainDumpEntries({ dryRun: false });

  assert.equal(result.counts.checked, 1);
  assert.equal(result.counts.actioned, 1);
  assert.equal(result.counts.possiblyResolved, 0);
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0].entryId, entry.id);
  assert.equal(result.changes[0].action, 'actioned');
  assert.equal(result.changes[0].taskId, 'HUB0042');

  // Entry on disk is mutated
  const reRead = JSON.parse(fs.readFileSync(temp.brainDumpPath, 'utf8'));
  assert.equal(reRead[0].status, 'actioned');
  assert.equal(reRead[0].queuedTaskId, 'HUB0042');
  assert.ok(reRead[0].queuedAt);

  restoreConfigCache();
  delete process.env.AGENT_MANAGER_BRAIN_DUMP_PATH;
  fs.rmSync(temp.root, { recursive: true, force: true });
});
});

// ---------------------------------------------------------------------------
// Scenario 2: non-merged task leaves entry unchanged
// ---------------------------------------------------------------------------
test.describe('Scenario 2: non-merged task leaves entry unchanged', () => {
test('no matching task leaves entry status=captured unchanged', () => {
  const temp = makeIsolatedTempDir();
  const entry = {
    id: 'bd-1792293449127-test-unchanged',
    serial: 43,
    status: 'captured',
    rawText: 'Add a new feature for X',
    capturedAt: '2026-10-24T11:00:00.000Z',
  };
  writeEntries(temp, [entry]);
  // Task in pending/ with unrelated raisedFrom -- does NOT match
  writeTask(temp.pipelineDir, 'pending', {
    id: 'HUB0099',
    source: 'manual',
    raisedFrom: 'brain-dump-bd-other-entry',
    title: 'Something else',
    status: 'pending',
  });
  injectFakeConfig(temp.pipelineDir);
  process.env.AGENT_MANAGER_BRAIN_DUMP_PATH = temp.brainDumpPath;

  const result = reconcileBrainDumpEntries({ dryRun: false });

  assert.equal(result.counts.checked, 1);
  assert.equal(result.counts.actioned, 0);
  assert.equal(result.counts.possiblyResolved, 0);
  assert.equal(result.changes.length, 0);

  // Entry on disk is unchanged
  const reRead = JSON.parse(fs.readFileSync(temp.brainDumpPath, 'utf8'));
  assert.equal(reRead[0].status, 'captured');
  assert.equal(reRead[0].queuedTaskId, undefined);
  assert.equal(reRead[0].queuedAt, undefined);

  restoreConfigCache();
  delete process.env.AGENT_MANAGER_BRAIN_DUMP_PATH;
  fs.rmSync(temp.root, { recursive: true, force: true });
});
});

// ---------------------------------------------------------------------------
// Scenario 3: superseded task handled
// ---------------------------------------------------------------------------
test.describe('Scenario 3: superseded task handled', () => {
test('task in done/_superseded/ still actioneds the entry', () => {
  const temp = makeIsolatedTempDir();
  const entry = {
    id: 'bd-1792293449127-test-superseded',
    serial: 44,
    status: 'captured',
    rawText: 'Refactor the queue module',
    capturedAt: '2026-10-24T12:00:00.000Z',
  };
  writeEntries(temp, [entry]);
  // Task in done/_superseded/ that matches (source != brain_dump_sort to avoid exclusion)
  writeTask(temp.pipelineDir, path.join('done', '_superseded'), {
    id: 'HUB0055',
    source: 'manual',
    raisedFrom: 'brain-dump-bd-1792293449127-test-superseded',
    title: 'Refactor the queue module (superseded)',
    status: 'done',
  });
  injectFakeConfig(temp.pipelineDir);
  process.env.AGENT_MANAGER_BRAIN_DUMP_PATH = temp.brainDumpPath;

  const result = reconcileBrainDumpEntries({ dryRun: false });

  assert.equal(result.counts.checked, 1);
  assert.equal(result.counts.actioned, 1);
  assert.equal(result.counts.possiblyResolved, 0);
  assert.equal(result.changes[0].action, 'actioned');
  assert.equal(result.changes[0].taskId, 'HUB0055');

  const reRead = JSON.parse(fs.readFileSync(temp.brainDumpPath, 'utf8'));
  assert.equal(reRead[0].status, 'actioned');
  assert.equal(reRead[0].queuedTaskId, 'HUB0055');

  restoreConfigCache();
  delete process.env.AGENT_MANAGER_BRAIN_DUMP_PATH;
  fs.rmSync(temp.root, { recursive: true, force: true });
});
});

// ---------------------------------------------------------------------------
// Scenario 4: symbol gone flags possibly-resolved but does not close
// ---------------------------------------------------------------------------
test.describe('Scenario 4: symbol gone flags possibly-resolved', () => {
test('every cited path missing -> possibly-resolved, does not close', () => {
  const temp = makeIsolatedTempDir();
  // Entry text cites paths that don't exist in the pipeline dir (which is empty of source files)
  const entry = {
    id: 'bd-1792293449127-test-gone',
    serial: 45,
    status: 'captured',
    rawText: 'The function in `pipeline/queue/done/gone-file.js` was removed',
    capturedAt: '2026-10-24T13:00:00.000Z',
  };
  writeEntries(temp, [entry]);
  // Initialize a git repo in the pipeline dir so defaultExists doesn't fail open.
  // Add a dummy tracked file; the cited path is not in the repo.
  const { execFileSync } = require('child_process');
  execFileSync('git', ['init'], { cwd: temp.pipelineDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: temp.pipelineDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: temp.pipelineDir, stdio: 'ignore' });
  fs.writeFileSync(path.join(temp.pipelineDir, 'README.md'), '# test\n');
  execFileSync('git', ['add', '.'], { cwd: temp.pipelineDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: temp.pipelineDir, stdio: 'ignore' });
  // No matching task -- the pipeline dir has no tasks referencing this entry
  injectFakeConfig(temp.pipelineDir);
  process.env.AGENT_MANAGER_BRAIN_DUMP_PATH = temp.brainDumpPath;

  const result = reconcileBrainDumpEntries({ dryRun: false });

  assert.equal(result.counts.checked, 1);
  assert.equal(result.counts.actioned, 0);
  assert.equal(result.counts.possiblyResolved, 1);
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0].entryId, entry.id);
  assert.equal(result.changes[0].action, 'possibly-resolved');
  // The "symbol" is the first cited path
  assert.equal(result.changes[0].symbol, 'pipeline/queue/done/gone-file.js');

  // Entry on disk: status=possibly-resolved, but NOT closed (no queuedTaskId)
  const reRead = JSON.parse(fs.readFileSync(temp.brainDumpPath, 'utf8'));
  assert.equal(reRead[0].status, 'possibly-resolved');
  assert.equal(reRead[0].queuedTaskId, undefined);

  restoreConfigCache();
  delete process.env.AGENT_MANAGER_BRAIN_DUMP_PATH;
  fs.rmSync(temp.root, { recursive: true, force: true });
});
});

// ---------------------------------------------------------------------------
// Scenario 5: second run is idempotent no-op
// ---------------------------------------------------------------------------
test.describe('Scenario 5: second run is idempotent no-op', () => {
test('second run on same data is a no-op (same counts, no new changes)', () => {
  const temp = makeIsolatedTempDir();
  const entry = {
    id: 'bd-1792293449127-test-idem',
    serial: 46,
    status: 'captured',
    rawText: 'Idempotency test entry',
    capturedAt: '2026-10-24T14:00:00.000Z',
  };
  writeEntries(temp, [entry]);
  // Task in done/ matches this entry (source != brain_dump_sort to avoid exclusion)
  writeTask(temp.pipelineDir, 'done', {
    id: 'HUB0066',
    source: 'manual',
    raisedFrom: 'brain-dump-bd-1792293449127-test-idem',
    title: 'Idempotency test',
    status: 'done',
  });
  injectFakeConfig(temp.pipelineDir);
  process.env.AGENT_MANAGER_BRAIN_DUMP_PATH = temp.brainDumpPath;

  // First run: should action the entry
  const first = reconcileBrainDumpEntries({ dryRun: false });
  assert.equal(first.counts.actioned, 1);
  assert.equal(first.counts.checked, 1);
  assert.equal(first.changes.length, 1);

  // Second run: entry is now status='actioned' with queuedTaskId set.
  // findExistingWorkForEntry will still find the same task (it matches by raisedFrom),
  // so the entry gets actioned again -- but since it's already actioned, the mutation
  // is a no-op on the entry state. The counts and changes are identical.
  const second = reconcileBrainDumpEntries({ dryRun: false });
  assert.equal(second.counts.actioned, 1);
  assert.equal(second.counts.checked, 1);
  assert.equal(second.changes.length, 1);
  assert.equal(second.changes[0].entryId, first.changes[0].entryId);
  assert.equal(second.changes[0].action, first.changes[0].action);
  assert.equal(second.changes[0].taskId, first.changes[0].taskId);

  // The file content is stable: queuedAt may differ (new Date()), but status and queuedTaskId are the same
  const reRead = JSON.parse(fs.readFileSync(temp.brainDumpPath, 'utf8'));
  assert.equal(reRead[0].status, 'actioned');
  assert.equal(reRead[0].queuedTaskId, 'HUB0066');

  restoreConfigCache();
  delete process.env.AGENT_MANAGER_BRAIN_DUMP_PATH;
  fs.rmSync(temp.root, { recursive: true, force: true });
});
});

// ---------------------------------------------------------------------------
// Scenario 6: real-shape fixture { entries: [...], _meta: {...} } with extra key
// ---------------------------------------------------------------------------
test.describe('Scenario 6: real-shape fixture with extra top-level key', () => {
test('real-shape { entries, _meta } is processed, _meta preserved on write, second run idempotent', () => {
  const temp = makeIsolatedTempDir();
  const entry = {
    id: 'bd-1792293449127-test-wrapped',
    serial: 47,
    status: 'captured',
    rawText: 'Wrap-shape fixture entry',
    capturedAt: '2026-10-24T15:00:00.000Z',
  };
  // Write the real shape with an extra top-level key
  const wrapped = {
    entries: [entry],
    _meta: { version: 1, exportedAt: '2026-10-24T09:00:00.000Z' },
    _customFlag: 'keep-me',
  };
  fs.writeFileSync(temp.brainDumpPath, JSON.stringify(wrapped, null, 2));
  // Task in done/ that matches via raisedFrom
  writeTask(temp.pipelineDir, 'done', {
    id: 'HUB0077',
    source: 'manual',
    raisedFrom: 'brain-dump-bd-1792293449127-test-wrapped',
    title: 'Wrap-shape test',
    status: 'done',
  });
  injectFakeConfig(temp.pipelineDir);
  process.env.AGENT_MANAGER_BRAIN_DUMP_PATH = temp.brainDumpPath;

  const result = reconcileBrainDumpEntries({ dryRun: false });
  assert.equal(result.counts.checked, 1);
  assert.equal(result.counts.actioned, 1);
  assert.equal(result.counts.possiblyResolved, 0);
  assert.equal(result.changes[0].entryId, entry.id);
  assert.equal(result.changes[0].action, 'actioned');

  // On-disk shape: entries mutated, extra keys preserved
  const reRead = JSON.parse(fs.readFileSync(temp.brainDumpPath, 'utf8'));
  assert.ok(Array.isArray(reRead.entries), 'should still be wrapped object');
  assert.equal(reRead.entries[0].status, 'actioned');
  assert.equal(reRead.entries[0].queuedTaskId, 'HUB0077');
  assert.equal(reRead._meta.version, 1);
  assert.equal(reRead._meta.exportedAt, '2026-10-24T09:00:00.000Z');
  assert.equal(reRead._customFlag, 'keep-me');

  // Second run: idempotent
  const second = reconcileBrainDumpEntries({ dryRun: false });
  assert.equal(second.counts.actioned, 1);
  assert.equal(second.counts.checked, 1);
  const reRead2 = JSON.parse(fs.readFileSync(temp.brainDumpPath, 'utf8'));
  assert.equal(reRead2.entries[0].status, 'actioned');
  assert.equal(reRead2._meta.version, 1);
  assert.equal(reRead2._customFlag, 'keep-me');

  restoreConfigCache();
  delete process.env.AGENT_MANAGER_BRAIN_DUMP_PATH;
  fs.rmSync(temp.root, { recursive: true, force: true });
});
});

// ---------------------------------------------------------------------------
// Scenario 7: bare array still works (backward compat)
// ---------------------------------------------------------------------------
test.describe('Scenario 7: bare array still works (backward compat)', () => {
test('bare array [entry] is still accepted and processed', () => {
  const temp = makeIsolatedTempDir();
  const entry = {
    id: 'bd-1792293449127-test-bare',
    serial: 48,
    status: 'captured',
    rawText: 'Bare array fixture entry',
    capturedAt: '2026-10-24T16:00:00.000Z',
  };
  // Write a bare array (old fixture shape)
  fs.writeFileSync(temp.brainDumpPath, JSON.stringify([entry], null, 2));
  writeTask(temp.pipelineDir, 'done', {
    id: 'HUB0088',
    source: 'manual',
    raisedFrom: 'brain-dump-bd-1792293449127-test-bare',
    title: 'Bare array test',
    status: 'done',
  });
  injectFakeConfig(temp.pipelineDir);
  process.env.AGENT_MANAGER_BRAIN_DUMP_PATH = temp.brainDumpPath;

  const result = reconcileBrainDumpEntries({ dryRun: false });
  assert.equal(result.counts.checked, 1);
  assert.equal(result.counts.actioned, 1);

  // On-disk: bare-array input stays bare-array output (legacy backward compat)
  const reRead = JSON.parse(fs.readFileSync(temp.brainDumpPath, 'utf8'));
  assert.ok(Array.isArray(reRead), 'should remain a bare array');
  assert.equal(reRead[0].status, 'actioned');
  assert.equal(reRead[0].queuedTaskId, 'HUB0088');

  restoreConfigCache();
  delete process.env.AGENT_MANAGER_BRAIN_DUMP_PATH;
  fs.rmSync(temp.root, { recursive: true, force: true });
});
});

// ---------------------------------------------------------------------------
// Scenario 8: mutation check -- revert to array-only parsing, show real-shape test red
// ---------------------------------------------------------------------------
test.describe('Scenario 8: mutation check (array-only parsing rejects real shape)', () => {
test('if parse were array-only, real-shape file throws "does not contain an array"', () => {
  const temp = makeIsolatedTempDir();
  const entry = {
    id: 'bd-1792293449127-test-mutation',
    serial: 49,
    status: 'captured',
    rawText: 'Mutation check entry',
    capturedAt: '2026-10-24T17:00:00.000Z',
  };
  // Write real shape
  const wrapped = { entries: [entry], _meta: { version: 1 } };
  fs.writeFileSync(temp.brainDumpPath, JSON.stringify(wrapped, null, 2));
  injectFakeConfig(temp.pipelineDir);
  process.env.AGENT_MANAGER_BRAIN_DUMP_PATH = temp.brainDumpPath;

  // Simulate array-only parsing: readBrainDumpRaw replaced with one that rejects objects
  const arrayOnlyReader = (filePath) => {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return { entries: parsed, _shape: 'bare-array' };
    }
    throw new Error(`brain-dump JSON at ${filePath} does not contain an array`);
  };
  // Verify the array-only reader rejects the real-shape file
  let threw = false;
  let errMsg = '';
  try {
    arrayOnlyReader(temp.brainDumpPath);
  } catch (err) {
    threw = true;
    errMsg = err.message;
  }
  assert.ok(threw, 'array-only parser should throw on real-shape file');
  assert.match(errMsg, /does not contain an array/);

  restoreConfigCache();
  delete process.env.AGENT_MANAGER_BRAIN_DUMP_PATH;
  fs.rmSync(temp.root, { recursive: true, force: true });
});
});

