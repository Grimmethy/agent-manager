'use strict';

// Unit tests for the brain_dump_disposition dispatch (HUB0119 · 4/4) -- the pieces
// landing alongside this file:
//   1/4: 'brain_dump_disposition' registered as a task domain (src/task-sources.js)
//   2/4: BRAIN_DUMP_DISPOSITION_RE + routing in src/apply-adhoc-diff.js
//   3/4: the brain_dump_disposition apply branch in src/apply-task.js, which calls
//        closeBrainDumpEntryResolved (src/apply-group-a-brain-dump.js, re-exported via
//        src/apply-group-a.js) against the REAL brain-dump.json under brainDumpPath.
//
// The applyTask tests are end-to-end against a real temp brain-dump.json (the same
// convention src/apply-group-a.test.js uses for closeBrainDumpEntryResolved), so they
// observe closeBrainDumpEntryResolved's actual args by effect: the entry it resolves
// must end up status:'actioned' with resolvedNote === the evidenceText.
//
// Run: node --test test/apply-task-brain-dump-disposition.test.js  (or `npm test`)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { BRAIN_DUMP_DISPOSITION_RE } = require('../src/apply-adhoc-diff.js');

// src/apply-task.js calls config.ensureRegistered() at load time, which requires
// AGENT_MANAGER_REPO_ROOT to be set (same convention src/apply-group-a.test.js and
// src/agentic-draft-common.test.js use around their loads of config-dependent modules).
const prevRepoRoot = process.env.AGENT_MANAGER_REPO_ROOT;
process.env.AGENT_MANAGER_REPO_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-disposition-env-'));
let applyTask;
try {
  ({ applyTask } = require('../src/apply-task.js'));
} finally {
  if (prevRepoRoot === undefined) delete process.env.AGENT_MANAGER_REPO_ROOT;
  else process.env.AGENT_MANAGER_REPO_ROOT = prevRepoRoot;
}

// 13-digit id, the exact shape BRAIN_DUMP_DISPOSITION_RE's \bbd-(\d{13})\b demands.
const ENTRY_ID = 'bd-1789585157691';

function writeBrainDump(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-disposition-test-'));
  const brainDumpPath = path.join(dir, 'brain-dump.json');
  fs.writeFileSync(brainDumpPath, JSON.stringify({ entries }, null, 2));
  return brainDumpPath;
}

function entry(overrides = {}) {
  return { id: ENTRY_ID, capturedAt: '2026-09-16T00:00:00.000Z', rawText: 'Close me down', status: 'captured', ...overrides };
}

// (a) BRAIN_DUMP_DISPOSITION_RE: a disposition title matches, an unrelated one does not.
test('BRAIN_DUMP_DISPOSITION_RE matches a brain-dump disposition title', () => {
  const title = `File ${ENTRY_ID} into project agent-manager and queue it`;
  assert.ok(BRAIN_DUMP_DISPOSITION_RE.test(title), `expected match for: ${title}`);
  const m = BRAIN_DUMP_DISPOSITION_RE.exec(title);
  assert.equal(m[1], '1789585157691'); // group 1 is the digits, per apply-adhoc-diff.js's own exec use
});

test('BRAIN_DUMP_DISPOSITION_RE does not match an unrelated title', () => {
  assert.equal(BRAIN_DUMP_DISPOSITION_RE.test('Weekly status update for team Alpha'), false);
  assert.equal(BRAIN_DUMP_DISPOSITION_RE.test(`File bug AC-4 in src/apply-task.js`), false); // directive verb but no bd-<13 digits>
  assert.equal(BRAIN_DUMP_DISPOSITION_RE.test(`Archive bd-${ENTRY_ID.slice(3)}0 (14 digits)`), false); // bd- present but the id is 14 digits, not 13
});

// (b) applyTask with domain 'brain_dump_disposition' and a valid payload calls
// closeBrainDumpEntryResolved with the right args (verified by effect on the entry).
test('applyTask brain_dump_disposition resolves the entry via closeBrainDumpEntryResolved', () => {
  const brainDumpPath = writeBrainDump([entry()]);
  const task = {
    id: `brain-dump-disposition-test-${Date.now()}`,
    domain: 'brain_dump_disposition',
    source: 'brain_dump_disposition',
    decision: { entryId: ENTRY_ID, evidenceText: 'Implemented and pushed to branch agent/task-1' },
  };

  const result = applyTask(task, { repoRoot: process.cwd(), pipelineDir: os.tmpdir(), brainDumpPath });

  assert.equal(result.succeeded, true, `expected succeeded, got: ${JSON.stringify(result)}`);
  assert.match(String(result.doneMarker || ''), /closed brain-dump entry/);

  const entries = JSON.parse(fs.readFileSync(brainDumpPath, 'utf8')).entries;
  // Exactly the args closeBrainDumpEntryResolved was called with, as observed through it:
  assert.equal(entries[0].id, ENTRY_ID); // brainDumpEntryId = task.decision.entryId
  assert.equal(entries[0].status, 'actioned');
  assert.equal(entries[0].resolvedNote, 'Implemented and pushed to branch agent/task-1'); // note = evidenceText
  assert.ok(entries[0].resolvedAt);
});

// (c) a missing entryId returns {skipped:true,...} and touches nothing.
test('applyTask brain_dump_disposition returns {skipped:true} and leaves the dump untouched when entryId is missing', () => {
  const brainDumpPath = writeBrainDump([entry()]);
  const task = {
    id: `brain-dump-disposition-noid-${Date.now()}`,
    domain: 'brain_dump_disposition',
    source: 'brain_dump_disposition',
    payload: { evidenceText: 'no entry id on this one' },
  };

  const result = applyTask(task, { repoRoot: process.cwd(), pipelineDir: os.tmpdir(), brainDumpPath });

  assert.equal(result.skipped, true, `expected skipped:true, got: ${JSON.stringify(result)}`);
  assert.match(String(result.reason || ''), /entryId/);

  const entries = JSON.parse(fs.readFileSync(brainDumpPath, 'utf8')).entries;
  assert.equal(entries[0].status, 'captured'); // untouched -- nothing was closed
  assert.equal(entries[0].resolvedNote, undefined);
  assert.equal(entries[0].resolvedAt, undefined);
});
