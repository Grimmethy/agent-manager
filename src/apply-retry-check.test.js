'use strict';

// Unit tests for apply-retry-check.js's applyRetryCheck() -- mirrors
// reject-retry-check.test.js's own coverage shape for the apply-stage sibling
// (2026-08-24, pipeline hardening: apply-failed tasks used to sit in queue/blocked/
// forever requiring a human to manually diagnose and requeue -- see that module's own
// header for the real live incident this closes).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { applyRetryCheck, isDivergedHistoryFailure } = require('./apply-retry-check.js');

function setupDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-retry-test-'));
  const blockedDir = path.join(root, 'queue', 'blocked');
  const pendingDir = path.join(root, 'queue', 'pending');
  fs.mkdirSync(blockedDir, { recursive: true });
  fs.mkdirSync(pendingDir, { recursive: true });
  return { root, blockedDir, pendingDir };
}

function writeBlockedTask(blockedDir, id, extra = {}) {
  const task = { id, blockedStage: 'apply', blockedReason: 'git apply failed: patch does not apply', history: [], ...extra };
  fs.writeFileSync(path.join(blockedDir, `${id}.json`), JSON.stringify(task, null, 2));
  return task;
}

test('applyRetryCheck requeues an apply-failed task under the retry cap', () => {
  const { blockedDir, pendingDir } = setupDirs();
  writeBlockedTask(blockedDir, 'task-1', { applyRetryCount: 0 });

  const summary = applyRetryCheck({ blockedDir, pendingDir, recordModelOutcome: () => {} });

  assert.equal(summary.requeued, 1);
  assert.equal(summary.exhausted, 0);
  assert.ok(fs.existsSync(path.join(pendingDir, 'task-1.json')));
  assert.ok(!fs.existsSync(path.join(blockedDir, 'task-1.json')));
  const requeued = JSON.parse(fs.readFileSync(path.join(pendingDir, 'task-1.json'), 'utf8'));
  assert.equal(requeued.applyRetryCount, 1);
});

test('applyRetryCheck ignores a review-stage rejection -- only blockedStage==="apply" is its job', () => {
  const { blockedDir, pendingDir } = setupDirs();
  writeBlockedTask(blockedDir, 'task-1', { blockedStage: 'review', localRejectCount: 0 });

  const summary = applyRetryCheck({ blockedDir, pendingDir, recordModelOutcome: () => {} });

  assert.equal(summary.checked, 1);
  assert.equal(summary.requeued, 0);
  assert.ok(fs.existsSync(path.join(blockedDir, 'task-1.json')), 'a review rejection must be left for reject-retry-check.js, not touched here');
});

test('applyRetryCheck stamps exhausted exactly once when the retry cap is hit, not on every call', () => {
  const { blockedDir, pendingDir } = setupDirs();
  writeBlockedTask(blockedDir, 'task-1', { applyRetryCount: 2 });

  const first = applyRetryCheck({ blockedDir, pendingDir, recordModelOutcome: () => {} });
  assert.equal(first.exhausted, 1);
  const afterFirst = JSON.parse(fs.readFileSync(path.join(blockedDir, 'task-1.json'), 'utf8'));
  assert.equal(afterFirst.history.filter((h) => h.stage === 'exhausted').length, 1);

  for (let i = 0; i < 5; i++) {
    applyRetryCheck({ blockedDir, pendingDir, recordModelOutcome: () => {} });
  }
  const afterMany = JSON.parse(fs.readFileSync(path.join(blockedDir, 'task-1.json'), 'utf8'));
  assert.equal(afterMany.history.filter((h) => h.stage === 'exhausted').length, 1, 'must not re-append exhausted on every tick');
});

test('applyRetryCheck leaves a non-JSON/unreadable file alone and counts it as an error, not a crash', () => {
  const { blockedDir, pendingDir } = setupDirs();
  fs.writeFileSync(path.join(blockedDir, 'broken.json'), '{not valid json');

  const summary = applyRetryCheck({ blockedDir, pendingDir, recordModelOutcome: () => {} });

  assert.equal(summary.errors, 1);
  assert.ok(fs.existsSync(path.join(blockedDir, 'broken.json')));
  // A JSON.parse failure is a 'parse' error, not a 'write' one -- see the fix's own
  // header comment on `step` for why this distinction was wrong before.
  assert.equal(summary.errorDetails[0].step, 'parse');
});

test('applyRetryCheck reports step "record" (not "write") when recordModelOutcome itself throws', () => {
  const { blockedDir, pendingDir } = setupDirs();
  writeBlockedTask(blockedDir, 'task-1', { applyRetryCount: 0 });

  const summary = applyRetryCheck({
    blockedDir, pendingDir,
    recordModelOutcome: () => { throw new Error('model-stats db is locked'); },
  });

  assert.equal(summary.errors, 1);
  assert.equal(summary.errorDetails[0].step, 'record');
  assert.match(summary.errorDetails[0].message, /model-stats db is locked/);
  // Nothing should have moved -- the requeue write never happened.
  assert.ok(fs.existsSync(path.join(blockedDir, 'task-1.json')));
  assert.ok(!fs.existsSync(path.join(pendingDir, 'task-1.json')));
});

test('applyRetryCheck returns an all-zero summary when queue/blocked/ does not exist at all', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-retry-test-'));
  const summary = applyRetryCheck({
    blockedDir: path.join(root, 'queue', 'blocked'),
    pendingDir: path.join(root, 'queue', 'pending'),
    recordModelOutcome: () => {},
  });
  assert.deepEqual(summary, { checked: 0, requeued: 0, exhausted: 0, resolved: 0, released: 0, held: 0, errors: 0, errorDetails: [] });
});

// 2026-09-17 (decompose_design_question AC-60/AC-61): git-runner.js's resetToMain()/
// prepareStackedBranch() throw this exact shape when the working checkout and
// origin/<main> have each moved ahead independently -- a git-state problem, never
// fixable by redrafting the diff. See isDivergedHistoryFailure's own header.

const DIVERGED_REASON = "resetToMain: local master and origin/master have diverged (each has commit(s) the other lacks) -- needs a human to reconcile, not an automatic reset";

test('isDivergedHistoryFailure recognizes the exact resetToMain/prepareStackedBranch diverged-history wording', () => {
  assert.equal(isDivergedHistoryFailure({ blockedStage: 'apply', blockedReason: DIVERGED_REASON }), true);
  assert.equal(isDivergedHistoryFailure({ blockedStage: 'apply', blockedReason: 'git apply failed: patch does not apply' }), false);
  assert.equal(isDivergedHistoryFailure({ blockedStage: 'review', blockedReason: DIVERGED_REASON }), false, 'must still be a real apply failure, not just matching text on any stage');
});

test('applyRetryCheck escalates a diverged-history apply failure straight to needs-clarification, never blind-retrying it', () => {
  const { blockedDir, pendingDir } = setupDirs();
  writeBlockedTask(blockedDir, 'task-1', { blockedReason: DIVERGED_REASON, applyRetryCount: 0 });
  const needsClarificationDir = path.join(pendingDir, '..', 'needs-clarification');
  fs.mkdirSync(needsClarificationDir, { recursive: true });

  const summary = applyRetryCheck({ blockedDir, pendingDir, needsClarificationDir, recordModelOutcome: () => {} });

  assert.equal(summary.exhausted, 1);
  assert.equal(summary.requeued, 0);
  assert.ok(!fs.existsSync(path.join(blockedDir, 'task-1.json')), 'must not sit in blocked/ burning retries');
  assert.ok(fs.existsSync(path.join(needsClarificationDir, 'task-1.json')));
  const escalated = JSON.parse(fs.readFileSync(path.join(needsClarificationDir, 'task-1.json'), 'utf8'));
  assert.equal(escalated.needsClarification.reason, 'git-state-diverged');
  assert.equal(escalated.applyRetryCount, 0, 'never spent a retry -- this was never eligible for a blind redraft in the first place');
  assert.ok(escalated.history.some((h) => h.stage === 'needs-clarification' && /diverged git history/.test(h.detail || '')));
});

test('applyRetryCheck does NOT escalate a diverged-history failure a second time once already escalated', () => {
  const { blockedDir, pendingDir } = setupDirs();
  writeBlockedTask(blockedDir, 'task-1', {
    blockedReason: DIVERGED_REASON,
    applyRetryCount: 0,
    history: [{ stage: 'needs-clarification', detail: 'escalated immediately -- diverged git history, a blind retry cannot differ' }],
  });
  const needsClarificationDir = path.join(pendingDir, '..', 'needs-clarification');
  fs.mkdirSync(needsClarificationDir, { recursive: true });

  const summary = applyRetryCheck({ blockedDir, pendingDir, needsClarificationDir, recordModelOutcome: () => {} });

  // Falls through to the ordinary retry-cap path instead (still bounded, no infinite loop).
  assert.equal(summary.requeued, 1);
  assert.ok(fs.existsSync(path.join(pendingDir, 'task-1.json')));
});

test('applyRetryCheck falls back to the ordinary bounded retry when no needsClarificationDir is given (back-compat)', () => {
  const { blockedDir, pendingDir } = setupDirs();
  writeBlockedTask(blockedDir, 'task-1', { blockedReason: DIVERGED_REASON, applyRetryCount: 0 });

  const summary = applyRetryCheck({ blockedDir, pendingDir, recordModelOutcome: () => {} });

  assert.equal(summary.requeued, 1);
  assert.ok(fs.existsSync(path.join(pendingDir, 'task-1.json')));
});

// --- apply-stage "find string not found" on a candidate whose own site is already fixed -----
// 2026-09-18 (observability-fix-ac-169): a scanner-derived candidate whose edit's `find`
// string no longer matches because the flagged code was since fixed by unrelated work. Every
// redraft re-anchors on the same stale candidate; after MAX_APPLY_RETRIES the task was
// stamped 'exhausted' and left in blocked/ forever. When the source's own deterministic
// scanner rules confirm the candidate's site is clean (premise-recheck-decision.js's
// decideFindingResolved), it is landed as the documented FALSE POSITIVE dismissal instead.

const FIND_MISS = 'find string not found in src/local-draft.js';

function setupWithApproved() {
  const d = setupDirs();
  const approvedDir = path.join(d.root, 'queue', 'approved');
  const needsClarificationDir = path.join(d.root, 'queue', 'needs-clarification');
  return { ...d, approvedDir, needsClarificationDir };
}

test('applyRetryCheck lands a find-string-miss whose site is verifiably resolved as a FALSE POSITIVE approval', () => {
  const { blockedDir, pendingDir, approvedDir } = setupWithApproved();
  writeBlockedTask(blockedDir, 'ac-169', {
    source: 'observability_fix', blockedReason: FIND_MISS, applyRetryCount: 0,
    implementResponse: '{"mode":"edit","file":"src/local-draft.js","find":"old","replace":"new"}',
  });

  const summary = applyRetryCheck({ blockedDir, pendingDir, approvedDir, decideResolved: () => true, recordModelOutcome: () => {} });

  assert.equal(summary.resolved, 1);
  assert.equal(summary.requeued, 0);
  assert.ok(!fs.existsSync(path.join(blockedDir, 'ac-169.json')));
  assert.ok(!fs.existsSync(path.join(pendingDir, 'ac-169.json')));
  const t = JSON.parse(fs.readFileSync(path.join(approvedDir, 'ac-169.json'), 'utf8'));
  assert.match(t.implementResponse, /^FALSE POSITIVE\b/, 'the stale edit must be replaced, or apply would just fail on it again');
  assert.equal(t.blockedReason, undefined);
  assert.equal(t.blockedStage, undefined);
  assert.equal(t.reviewProvider, 'deterministic-apply-site-resolved');
  assert.ok(t.history.some((h) => h.stage === 'approved'), 'audit trail: an approved history event');
});

test('applyRetryCheck still resolves a find-string-miss AFTER the retry cap was already reached (the AC-169 state)', () => {
  const { blockedDir, pendingDir, approvedDir } = setupWithApproved();
  writeBlockedTask(blockedDir, 'ac-169', {
    source: 'observability_fix', blockedReason: FIND_MISS, applyRetryCount: 2,
    history: [{ stage: 'exhausted', at: '2026-09-09T00:00:00Z' }],
  });

  const summary = applyRetryCheck({ blockedDir, pendingDir, approvedDir, decideResolved: () => true, recordModelOutcome: () => {} });

  assert.equal(summary.resolved, 1);
  assert.ok(fs.existsSync(path.join(approvedDir, 'ac-169.json')));
});

test('applyRetryCheck falls back to the ordinary retry when the site is NOT verifiably resolved', () => {
  const { blockedDir, pendingDir, approvedDir } = setupWithApproved();
  writeBlockedTask(blockedDir, 'ac-169', { source: 'observability_fix', blockedReason: FIND_MISS, applyRetryCount: 0 });

  const summary = applyRetryCheck({ blockedDir, pendingDir, approvedDir, decideResolved: () => false, recordModelOutcome: () => {} });

  assert.equal(summary.resolved, 0);
  assert.equal(summary.requeued, 1);
  assert.ok(fs.existsSync(path.join(pendingDir, 'ac-169.json')));
});

test('applyRetryCheck only consults the resolver for a find-string miss, not any other apply failure', () => {
  const { blockedDir, pendingDir, approvedDir } = setupWithApproved();
  writeBlockedTask(blockedDir, 'conflict', { blockedReason: 'git apply failed: patch does not apply', applyRetryCount: 0 });
  let consulted = 0;

  const summary = applyRetryCheck({ blockedDir, pendingDir, approvedDir, decideResolved: () => { consulted += 1; return true; }, recordModelOutcome: () => {} });

  assert.equal(consulted, 0);
  assert.equal(summary.resolved, 0);
  assert.equal(summary.requeued, 1);
});

test('applyRetryCheck escalates an apply failure that exhausted its retries to needs-clarification instead of parking it forever', () => {
  const { blockedDir, pendingDir, approvedDir, needsClarificationDir } = setupWithApproved();
  writeBlockedTask(blockedDir, 'stuck', { source: 'observability_fix', blockedReason: FIND_MISS, applyRetryCount: 2 });

  const summary = applyRetryCheck({ blockedDir, pendingDir, approvedDir, needsClarificationDir, decideResolved: () => false, recordModelOutcome: () => {} });

  assert.equal(summary.exhausted, 1);
  assert.ok(!fs.existsSync(path.join(blockedDir, 'stuck.json')), 'no longer parked in blocked/');
  const t = JSON.parse(fs.readFileSync(path.join(needsClarificationDir, 'stuck.json'), 'utf8'));
  assert.equal(t.needsClarification.reason, 'design-decision');
  assert.match(String(t.needsClarification.openQuestions), /find string not found/);
  assert.ok(t.history.some((h) => h.stage === 'exhausted'));
  assert.ok(t.history.some((h) => h.stage === 'needs-clarification'));
});

test('applyRetryCheck without needsClarificationDir keeps the original stamp-once-and-stay behaviour on exhaustion', () => {
  const { blockedDir, pendingDir } = setupDirs();
  writeBlockedTask(blockedDir, 'stuck', { applyRetryCount: 2 });

  const summary = applyRetryCheck({ blockedDir, pendingDir, recordModelOutcome: () => {} });

  assert.equal(summary.exhausted, 1);
  assert.ok(fs.existsSync(path.join(blockedDir, 'stuck.json')));
});

// 2026-09-23 (change_review backlog incident): a dirty apply clone is INFRASTRUCTURE, not a draft failure.
const DIRTY_REASON = 'applyDirectToMainBatch crashed before producing a result: Command failed: git checkout -B agent/triage-queue origin/agent/triage-queue\nerror: Your local changes to the following files would be overwritten by checkout:\n\tDocs/OBSERVABILITY_FIX_CANDIDATES.md';

test('applyRetryCheck: an infra (dirty apply clone) failure is HELD -- not requeued, no retry burned -- while the clone is still dirty', () => {
  const { root, blockedDir, pendingDir } = setupDirs();
  const approvedDir = path.join(root, 'queue', 'approved');
  writeBlockedTask(blockedDir, 'infra-1', { blockedReason: DIRTY_REASON, applyRetryCount: 1 });

  const summary = applyRetryCheck({ blockedDir, pendingDir, approvedDir, recordModelOutcome: () => {}, isApplyCloneClean: () => false });

  assert.equal(summary.held, 1);
  assert.equal(summary.requeued, 0);
  assert.equal(fs.existsSync(path.join(pendingDir, 'infra-1.json')), false, 'no redraft');
  const held = JSON.parse(fs.readFileSync(path.join(blockedDir, 'infra-1.json'), 'utf8'));
  assert.equal(held.applyRetryCount, 1, 'retry count untouched');
  assert.equal(held.history.filter((h) => h.stage === 'infra-held').length, 1);

  applyRetryCheck({ blockedDir, pendingDir, approvedDir, recordModelOutcome: () => {}, isApplyCloneClean: () => false });
  const again = JSON.parse(fs.readFileSync(path.join(blockedDir, 'infra-1.json'), 'utf8'));
  assert.equal(again.history.filter((h) => h.stage === 'infra-held').length, 1, 'stamped once, never re-fired per tick');
});

test('applyRetryCheck: once the apply clone is clean, an infra failure is released to approved/ to RE-APPLY (no redraft), even at the retry cap', () => {
  const { root, blockedDir, pendingDir } = setupDirs();
  const approvedDir = path.join(root, 'queue', 'approved');
  writeBlockedTask(blockedDir, 'infra-2', { blockedReason: DIRTY_REASON, applyRetryCount: 2, implementResponse: '### AC-1 · x' });

  const summary = applyRetryCheck({ blockedDir, pendingDir, approvedDir, recordModelOutcome: () => {}, isApplyCloneClean: () => true });

  assert.equal(summary.released, 1);
  assert.equal(summary.exhausted, 0, 'the cap is for draft failures, not infra');
  assert.equal(fs.existsSync(path.join(pendingDir, 'infra-2.json')), false);
  const released = JSON.parse(fs.readFileSync(path.join(approvedDir, 'infra-2.json'), 'utf8'));
  assert.equal(released.implementResponse, '### AC-1 · x', 'the approved result is kept as-is');
  assert.equal(released.blockedStage, undefined);
  assert.equal(released.blockedReason, undefined);
  assert.equal(released.status, 'approved');
});

test('applyRetryCheck: the rebase-on-dirty-tree and assertCleanTree messages are also classed as infra; a real patch conflict is not', () => {
  const { isInfraApplyFailure } = require('./apply-retry-check.js');
  const mk = (blockedReason) => ({ blockedStage: 'apply', blockedReason });
  assert.equal(isInfraApplyFailure(mk('git rebase origin/master\nerror: cannot rebase: You have unstaged changes.')), true);
  assert.equal(isInfraApplyFailure(mk('apply clone is dirty (uncommitted tracked changes: a.md) -- refusing')), true);
  assert.equal(isInfraApplyFailure(mk('git apply failed: patch does not apply')), false);
  assert.equal(isInfraApplyFailure({ blockedStage: 'review', blockedReason: DIRTY_REASON }), false);
});
