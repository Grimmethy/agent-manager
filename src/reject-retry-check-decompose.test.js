'use strict';

// ROOT CAUSE (step 1 of task): A decompose parent (adhocResolution:'decompose',
// subTaskProposals set, blockedStage:'review') enters the retry entry gate because
// isReviewRejection() returns true for blockedStage:'review'. But classifyBlockedTask()
// then classifies it as non-retryable (e.g. 'unreliable-grounding' -- the sub-task
// proposals cite files that don't exist yet; they're PROPOSED, not real) and escalates
// it to needs-clarification instead of requeueing. Confirmed live 2026-11-09: task R12
// sat in queue/blocked/ for 5 minutes after review rejected the plan, then was replaced
// by hand. The fix: bypass classifyBlockedTask for this shape and treat it like any
// other genuine review rejection (same localRejectCount cap, same priorRejectionFeedback,
// same pending/ destination).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { rejectRetryCheck } = require('./reject-retry-check.js');

function makeTempQueue() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reject-retry-decompose-'));
  const blockedDir = path.join(root, 'queue', 'blocked');
  const pendingDir = path.join(root, 'queue', 'pending');
  const adhocDir = path.join(root, 'queue', 'adhoc');
  const derivedDir = path.join(root, 'queue', 'derived');
  const needsClarificationDir = path.join(root, 'queue', 'needs-clarification');
  fs.mkdirSync(blockedDir, { recursive: true });
  fs.mkdirSync(pendingDir, { recursive: true });
  fs.mkdirSync(adhocDir, { recursive: true });
  fs.mkdirSync(derivedDir, { recursive: true });
  fs.mkdirSync(needsClarificationDir, { recursive: true });
  return { root, blockedDir, pendingDir, adhocDir, derivedDir, needsClarificationDir };
}

function writeTask(dir, name, task) {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(task, null, 2));
}

function readTask(dir, name) {
  return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
}

function listDir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

function cleanup(q) {
  try { fs.rmSync(q.root, { recursive: true, force: true }); } catch { /* ignore */ }
}

test('rejected decompose parent is moved to pending with priorRejectionFeedback set', () => {
  const q = makeTempQueue();
  try {
    const task = {
      id: 'test-decompose-1',
      status: 'blocked',
      domain: 'default',
      source: 'adhoc',
      adhocResolution: 'decompose',
      subTaskProposals: [
        { id: 'sub-1', rawText: 'do thing A' },
        { id: 'sub-2', rawText: 'do thing B' },
      ],
      blockedStage: 'review',
      blockedReason: 'Reviewer read manual-browser step as polling mechanism',
      localRejectCount: 0,
      priorRejectionFeedback: [],
    };
    writeTask(q.blockedDir, 'test-decompose-1.json', task);

    const summary = rejectRetryCheck({
      blockedDir: q.blockedDir,
      pendingDir: q.pendingDir,
      adhocDir: q.adhocDir,
      derivedDir: q.derivedDir,
      needsClarificationDir: q.needsClarificationDir,
      pipelineDir: path.join(q.root, 'queue'),
    });

    assert.equal(summary.requeued, 1, 'summary says requeued');
    assert.equal(summary.exhausted, 0, 'summary says not exhausted');

    // Task should be in pending/ now
    assert.ok(listDir(q.pendingDir).includes('test-decompose-1.json'), 'task moved to pending/');
    assert.equal(listDir(q.blockedDir).filter(n => n.startsWith('test-decompose-')).length, 0, 'task removed from blocked/');

    const moved = readTask(q.pendingDir, 'test-decompose-1.json');
    assert.equal(moved.localRejectCount, 1, 'localRejectCount incremented to 1');
    assert.ok(Array.isArray(moved.priorRejectionFeedback) && moved.priorRejectionFeedback.length > 0, 'priorRejectionFeedback set');
    assert.ok(moved.priorRejectionFeedback.includes('Reviewer read manual-browser step as polling mechanism'),
      'priorRejectionFeedback contains the blockedReason');
    assert.equal(moved.blockedStage, 'queue', 'blockedStage cleared to queue');
  } finally {
    cleanup(q);
  }
});

test('decompose parent stops at retry cap and is escalated to needs-clarification', () => {
  const q = makeTempQueue();
  try {
    // At retryCount = MAX_LOCAL_REJECT_RETRIES (2), should be exhausted
    const task = {
      id: 'test-decompose-cap',
      status: 'blocked',
      domain: 'default',
      source: 'adhoc',
      adhocResolution: 'decompose',
      subTaskProposals: [{ id: 'sub-1', rawText: 'do thing A' }],
      blockedStage: 'review',
      blockedReason: 'plan rejected again',
      localRejectCount: 2,
      priorRejectionFeedback: ['first rejection', 'second rejection'],
      history: [],
    };
    writeTask(q.blockedDir, 'test-decompose-cap.json', task);

    const summary = rejectRetryCheck({
      blockedDir: q.blockedDir,
      pendingDir: q.pendingDir,
      adhocDir: q.adhocDir,
      derivedDir: q.derivedDir,
      needsClarificationDir: q.needsClarificationDir,
      pipelineDir: path.join(q.root, 'queue'),
    });

    assert.equal(summary.exhausted, 1, 'summary says exhausted');
    assert.equal(summary.requeued, 0, 'summary says not requeued');

    // Task should be in needs-clarification/ now
    assert.ok(listDir(q.needsClarificationDir).includes('test-decompose-cap.json'), 'task moved to needs-clarification/');
    assert.equal(listDir(q.blockedDir).filter(n => n.startsWith('test-decompose-')).length, 0, 'task removed from blocked/');

    const moved = readTask(q.needsClarificationDir, 'test-decompose-cap.json');
    assert.ok(moved.needsClarification, 'needsClarification set');
    assert.equal(moved.needsClarification.reason, 'design-decision', 'reason is design-decision');
  } finally {
    cleanup(q);
  }
});

test('non-decompose rejected task behaves as before (regression)', () => {
  const q = makeTempQueue();
  try {
    // A regular implementation task rejected by review
    const task = {
      id: 'test-normal-1',
      status: 'blocked',
      domain: 'default',
      source: 'adhoc',
      adhocResolution: 'implementation',
      blockedStage: 'review',
      blockedReason: 'missing test coverage',
      localRejectCount: 0,
      priorRejectionFeedback: [],
    };
    writeTask(q.blockedDir, 'test-normal-1.json', task);

    const summary = rejectRetryCheck({
      blockedDir: q.blockedDir,
      pendingDir: q.pendingDir,
      adhocDir: q.adhocDir,
      derivedDir: q.derivedDir,
      needsClarificationDir: q.needsClarificationDir,
      pipelineDir: path.join(q.root, 'queue'),
    });

    assert.equal(summary.requeued, 1, 'summary says requeued');
    assert.equal(listDir(q.blockedDir).filter(n => n.startsWith('test-normal-')).length, 0, 'task removed from blocked/');
    assert.ok(listDir(q.pendingDir).includes('test-normal-1.json'), 'task moved to pending/');
  } finally {
    cleanup(q);
  }
});
