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
    localRejectCount: 2,
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
  assert.equal(pending.localRejectCount, undefined); // stripped -- a fresh do-over, not a continuation
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

// --- pipeline_forensics_fix: sweep needs-clarification/ too, skip design-decision holds,
//     and don't requeue the same task twice for the same signature (2026-09-01) ---

function writeInState(dir, state, id, task) {
  const d = path.join(dir, 'queue', state);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `${id}.json`), JSON.stringify({ id, ...task }));
}

test('with dirs: [blocked, needs-clarification] it drains a matching task out of needs-clarification/ too', () => {
  const dir = tempPipelineDir();
  writeInState(dir, 'needs-clarification', 'adhoc-nc-1', {
    source: 'manual', domain: 'adhoc', title: 'NC-1',
    needsClarification: { reason: 'no anchor match' },
    blockedReason: 'Plan pass degenerate: empty',
  });
  const { requeuedIds } = requeueBlockedTasksForSignature(dir, 'manual::empty-degenerate-draft', { dirs: ['blocked', 'needs-clarification'] });
  assert.deepEqual(requeuedIds, ['adhoc-nc-1']);
  assert.equal(fs.existsSync(path.join(dir, 'queue', 'needs-clarification', 'adhoc-nc-1.json')), false);
  const pending = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'pending', 'adhoc-nc-1.json'), 'utf8'));
  assert.match(pending.history[0].note, /auto-requeued from needs-clarification\//);
  assert.deepEqual(pending.requeuedForSignatures, ['manual::empty-degenerate-draft']);
});

test('a GENUINE design-decision hold (RESOLUTION: needs-human-decision, no exhausted event) is left alone', () => {
  const dir = tempPipelineDir();
  writeInState(dir, 'needs-clarification', 'adhoc-dd-1', {
    source: 'manual', domain: 'adhoc',
    needsClarification: { reason: 'design-decision', openQuestions: 'Which of these two graph layouts do you want?' },
    blockedReason: 'Plan pass degenerate: empty',
    history: [{ stage: 'implement-done' }, { stage: 'needs-clarification' }],
  });
  const { requeuedIds } = requeueBlockedTasksForSignature(dir, 'manual::empty-degenerate-draft', { dirs: ['blocked', 'needs-clarification'] });
  assert.deepEqual(requeuedIds, []);
  assert.equal(fs.existsSync(path.join(dir, 'queue', 'needs-clarification', 'adhoc-dd-1.json')), true);
});

test('a design-decision hold that is really an exhausted-retries auto-escalation IS requeued when its fix lands', () => {
  const dir = tempPipelineDir();
  writeInState(dir, 'needs-clarification', 'adhoc-dd-exhausted-1', {
    source: 'manual', domain: 'adhoc',
    // reject-retry-check.js stamps reason:'design-decision' here too, but always alongside
    // an 'exhausted' history event -- that is the tell that it's a drafting failure a
    // signature-scoped fix can now unblock, not a real human question.
    needsClarification: { reason: 'design-decision', openQuestions: 'The automated handler could not get this past review after 3 attempts:' },
    blockedReason: 'Plan pass degenerate: empty',
    history: [{ stage: 'draft-attempt' }, { stage: 'exhausted', detail: '2/2 retries used' }, { stage: 'needs-clarification', detail: 'escalated to a human after exhausting redraft retries' }],
  });
  const { requeuedIds } = requeueBlockedTasksForSignature(dir, 'manual::empty-degenerate-draft', { dirs: ['blocked', 'needs-clarification'] });
  assert.deepEqual(requeuedIds, ['adhoc-dd-exhausted-1']);
  assert.equal(fs.existsSync(path.join(dir, 'queue', 'needs-clarification', 'adhoc-dd-exhausted-1.json')), false);
  const pending = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'pending', 'adhoc-dd-exhausted-1.json'), 'utf8'));
  assert.deepEqual(pending.requeuedForSignatures, ['manual::empty-degenerate-draft']);
});

test('a task already auto-requeued for this signature is not requeued again', () => {
  const dir = tempPipelineDir();
  writeInState(dir, 'blocked', 'adhoc-again-1', {
    source: 'manual', domain: 'adhoc',
    blockedReason: 'Plan pass degenerate: empty',
    requeuedForSignatures: ['manual::empty-degenerate-draft'],
  });
  const { requeuedIds } = requeueBlockedTasksForSignature(dir, 'manual::empty-degenerate-draft', { dirs: ['blocked', 'needs-clarification'] });
  assert.deepEqual(requeuedIds, []);
  assert.equal(fs.existsSync(path.join(dir, 'queue', 'blocked', 'adhoc-again-1.json')), true);
});
