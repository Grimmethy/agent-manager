'use strict';

// Unit tests for reject-retry-check.js's rejectRetryCheck() -- previously had zero test
// coverage. Written after a real live bug (2026-08-17): a task that hit the retry cap got
// its 'exhausted' history event re-appended on EVERY tick forever (nothing here ever moves
// or deletes an exhausted task out of blocked/), confirmed live via one real task that
// accumulated 20+ duplicate entries over ~12 minutes before being caught.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { rejectRetryCheck } = require('./reject-retry-check.js');

function setupDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reject-retry-test-'));
  const blockedDir = path.join(root, 'queue', 'blocked');
  const pendingDir = path.join(root, 'queue', 'pending');
  fs.mkdirSync(blockedDir, { recursive: true });
  fs.mkdirSync(pendingDir, { recursive: true });
  return { root, blockedDir, pendingDir };
}

function writeBlockedTask(blockedDir, id, extra = {}) {
  const task = { id, blockedStage: 'review', blockedReason: 'fabricated reference', history: [], ...extra };
  fs.writeFileSync(path.join(blockedDir, `${id}.json`), JSON.stringify(task, null, 2));
  return task;
}

test('rejectRetryCheck requeues a review-rejected task under the retry cap', () => {
  const { blockedDir, pendingDir } = setupDirs();
  writeBlockedTask(blockedDir, 'task-1', { localRejectCount: 0 });

  const summary = rejectRetryCheck({ blockedDir, pendingDir, recordModelOutcome: () => {} });

  assert.equal(summary.requeued, 1);
  assert.equal(summary.exhausted, 0);
  assert.ok(fs.existsSync(path.join(pendingDir, 'task-1.json')));
  assert.ok(!fs.existsSync(path.join(blockedDir, 'task-1.json')));
  const requeued = JSON.parse(fs.readFileSync(path.join(pendingDir, 'task-1.json'), 'utf8'));
  assert.equal(requeued.localRejectCount, 1);
});

test('rejectRetryCheck stamps exhausted exactly once when the retry cap is hit, not on every call', () => {
  const { blockedDir, pendingDir } = setupDirs();
  writeBlockedTask(blockedDir, 'task-1', { localRejectCount: 2 });

  const first = rejectRetryCheck({ blockedDir, pendingDir, recordModelOutcome: () => {} });
  assert.equal(first.exhausted, 1);
  const afterFirst = JSON.parse(fs.readFileSync(path.join(blockedDir, 'task-1.json'), 'utf8'));
  assert.equal(afterFirst.history.filter((h) => h.stage === 'exhausted').length, 1);

  // Simulate several more ticks against the same still-blocked task -- the real-world
  // scenario that produced 20+ duplicate entries before this fix.
  for (let i = 0; i < 5; i++) {
    rejectRetryCheck({ blockedDir, pendingDir, recordModelOutcome: () => {} });
  }
  const afterMany = JSON.parse(fs.readFileSync(path.join(blockedDir, 'task-1.json'), 'utf8'));
  assert.equal(afterMany.history.filter((h) => h.stage === 'exhausted').length, 1, 'must never re-append a duplicate exhausted event');
});

test('rejectRetryCheck ignores an apply-stage failure (not a review rejection)', () => {
  const { blockedDir, pendingDir } = setupDirs();
  const task = { id: 'task-1', history: [] }; // no blockedStage -- e.g. a real apply-time git failure
  fs.writeFileSync(path.join(blockedDir, 'task-1.json'), JSON.stringify(task));

  const summary = rejectRetryCheck({ blockedDir, pendingDir, recordModelOutcome: () => {} });

  assert.equal(summary.requeued, 0);
  assert.equal(summary.exhausted, 0);
  assert.ok(fs.existsSync(path.join(blockedDir, 'task-1.json')), 'must be left alone in blocked/');
});

test('rejectRetryCheck returns an all-zero summary when blockedDir does not exist', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reject-retry-test-'));
  const summary = rejectRetryCheck({ blockedDir: path.join(root, 'nope'), pendingDir: path.join(root, 'pending') });
  assert.deepEqual(summary, { checked: 0, requeued: 0, exhausted: 0, errors: 0 });
});

// --- adhoc-specific routing (2026-08-30) ---------------------------------------------
function setupAdhocDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reject-retry-adhoc-'));
  const dirs = {
    root,
    blockedDir: path.join(root, 'queue', 'blocked'),
    pendingDir: path.join(root, 'queue', 'pending'),
    adhocDir: path.join(root, 'queue', 'adhoc'),
    needsClarificationDir: path.join(root, 'queue', 'needs-clarification'),
  };
  for (const d of [dirs.blockedDir, dirs.pendingDir, dirs.adhocDir, dirs.needsClarificationDir]) fs.mkdirSync(d, { recursive: true });
  return dirs;
}

test('an adhoc review-rejection under the cap is requeued to queue/adhoc/, not queue/pending/', () => {
  const d = setupAdhocDirs();
  const task = { id: 'adhoc-x', domain: 'adhoc', source: 'manual', blockedStage: 'review', blockedReason: 'cited app.py is fabricated', localRejectCount: 0, history: [] };
  fs.writeFileSync(path.join(d.blockedDir, 'adhoc-x.json'), JSON.stringify(task));

  const summary = rejectRetryCheck({ ...d, recordModelOutcome: () => {} });

  assert.equal(summary.requeued, 1);
  assert.ok(fs.existsSync(path.join(d.adhocDir, 'adhoc-x.json')), 'lands in queue/adhoc/');
  assert.ok(!fs.existsSync(path.join(d.pendingDir, 'adhoc-x.json')));
  const out = JSON.parse(fs.readFileSync(path.join(d.adhocDir, 'adhoc-x.json'), 'utf8'));
  assert.deepEqual(out.priorRejectionFeedback, ['cited app.py is fabricated']);
});

test('an adhoc no-changes-needed rejection that exhausts retries -> queue/needs-clarification/ with a pre-filled question', () => {
  const d = setupAdhocDirs();
  const task = {
    id: 'adhoc-nc', domain: 'adhoc', source: 'manual', adhocResolution: 'no-changes-needed',
    blockedStage: 'review', blockedReason: 'only covers prompt data, not gallery images',
    localRejectCount: 2, priorRejectionFeedback: ['first reason', 'second reason'], history: [],
  };
  fs.writeFileSync(path.join(d.blockedDir, 'adhoc-nc.json'), JSON.stringify(task));

  const summary = rejectRetryCheck({ ...d, recordModelOutcome: () => {} });

  assert.equal(summary.exhausted, 1);
  assert.ok(!fs.existsSync(path.join(d.blockedDir, 'adhoc-nc.json')), 'moved out of blocked/');
  const p = path.join(d.needsClarificationDir, 'adhoc-nc.json');
  assert.ok(fs.existsSync(p));
  const out = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(out.needsClarification.reason, 'design-decision');
  assert.match(out.needsClarification.openQuestions, /RESOLUTION: no-changes-needed/);
  assert.match(out.needsClarification.openQuestions, /first reason/);
  assert.match(out.needsClarification.openQuestions, /EXTEND an existing feature/);
  assert.ok(out.history.some((h) => h.stage === 'needs-clarification'));
});

test('the needs-clarification escalation is idempotent across ticks', () => {
  const d = setupAdhocDirs();
  const task = { id: 'adhoc-idem', domain: 'adhoc', source: 'manual', blockedStage: 'review', blockedReason: 'r', localRejectCount: 2, history: [{ stage: 'needs-clarification', at: 'x' }] };
  fs.writeFileSync(path.join(d.blockedDir, 'adhoc-idem.json'), JSON.stringify(task));
  const summary = rejectRetryCheck({ ...d, recordModelOutcome: () => {} });
  assert.equal(summary.exhausted, 1);
  // already escalated on a prior tick -> left where it is, not re-moved / re-stamped
  assert.ok(fs.existsSync(path.join(d.blockedDir, 'adhoc-idem.json')));
});

test('a NON-adhoc exhausted rejection keeps the original "stamp and stay in blocked/" behaviour', () => {
  const d = setupAdhocDirs();
  const task = { id: 'arch-x', source: 'trouble_log', blockedStage: 'review', blockedReason: 'r', localRejectCount: 2, history: [] };
  fs.writeFileSync(path.join(d.blockedDir, 'arch-x.json'), JSON.stringify(task));
  const summary = rejectRetryCheck({ ...d, recordModelOutcome: () => {} });
  assert.equal(summary.exhausted, 1);
  assert.ok(fs.existsSync(path.join(d.blockedDir, 'arch-x.json')), 'non-adhoc stays in blocked/');
  assert.ok(!fs.existsSync(path.join(d.needsClarificationDir, 'arch-x.json')));
  const out = JSON.parse(fs.readFileSync(path.join(d.blockedDir, 'arch-x.json'), 'utf8'));
  assert.ok(out.history.some((h) => h.stage === 'exhausted'));
  assert.equal(out.needsClarification, undefined);
});
