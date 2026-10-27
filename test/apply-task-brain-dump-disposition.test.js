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

const { BRAIN_DUMP_DISPOSITION_RE, queueSubTasks } = require('../src/apply-adhoc-diff.js');

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

test('BRAIN_DUMP_DISPOSITION_RE matches the wordings the hub was filed for and returns the entry id', () => {
  for (const title of [
    `Mark brain-dump entry ${ENTRY_ID} resolved with this evidence`,
    `Record verification on brain dump ${ENTRY_ID}`,
    `Close ${ENTRY_ID} as actioned`,
    `Please dismiss the entry ${ENTRY_ID}`,
  ]) {
    const m = BRAIN_DUMP_DISPOSITION_RE.exec(title);
    assert.ok(m, `expected match for: ${title}`);
    assert.equal(m[1], '1789585157691');
  }
  // the verb may start a later line of a multi-line rawText, but only at a line start
  assert.ok(BRAIN_DUMP_DISPOSITION_RE.test(`Context line.\nClose ${ENTRY_ID} as actioned`));
});

test('BRAIN_DUMP_DISPOSITION_RE does not match real code work that merely mentions an entry', () => {
  for (const title of [
    `File the fix for the bug reported in ${ENTRY_ID} in src/x.js`,
    `Route the GPU lease through the arbiter; see ${ENTRY_ID}`,
    `Fix the crash described in ${ENTRY_ID}`,
    `Add a retry to apply-task.js (follow-up from ${ENTRY_ID} close)`,
    `Add a retry so the sweep can close ${ENTRY_ID} once the fix lands`, // verb mid-sentence, not a disposition request
  ]) {
    assert.equal(BRAIN_DUMP_DISPOSITION_RE.test(title), false, `must not match: ${title}`);
  }
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

// HUB0119 follow-up: the disposition routing must send a real disposition to brain_dump_disposition and leave code work that merely mentions an entry on the adhoc path.
test('queueSubTasks routes a brain-dump disposition to brain_dump_disposition and keeps code work that mentions an entry as adhoc', () => {
  const pipelineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-adhoc-diff-disposition-'));
  const subTasks = [
    { title: 'Mark brain-dump entry bd-1789585157691 resolved with this evidence', rawText: 'Evidence: merged in commit abc123.' },
    { title: 'Fix the crash reported in bd-1789585157692', rawText: 'File the fix for the bug reported in bd-1789585157692 in src/apply-task.js and add a test.' },
  ];

  queueSubTasks(subTasks, pipelineDir, 'parent-disposition', {});

  const adhocDir = path.join(pipelineDir, 'queue', 'adhoc');
  const records = fs.readdirSync(adhocDir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(adhocDir, f), 'utf8')));
  const disposition = records.filter((r) => r.domain === 'brain_dump_disposition');
  assert.equal(disposition.length, 1);
  assert.equal(disposition[0].payload.entryId, '1789585157691');
  const work = records.filter((r) => r.domain === 'adhoc');
  assert.equal(work.length, 1, 'the code-work proposal stays an adhoc task');
  assert.match(work[0].title, /Fix the crash reported/);
});
