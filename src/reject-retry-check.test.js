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

const { rejectRetryCheck, isReviewRejection, isPreCritiqueBlock, isPreImplementBlock, isDraftFailureBlock, isStructurallyOversizedDraftFailure, isPlanDegenerateBlock, alreadyEscalatedSinceLastReadmission } = require('./reject-retry-check.js');

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

test('rejectRetryCheck clears stale planResponse/implementResponse on a genuine review-rejection requeue (AC-131)', () => {
  const { blockedDir, pendingDir } = setupDirs();
  writeBlockedTask(blockedDir, 'task-1', {
    localRejectCount: 0,
    planResponse: '# Plan\n1. Do the thing.',
    implementResponse: '{"mode":"edit","file":"x.js","find":"a","replace":"b"}',
  });

  rejectRetryCheck({ blockedDir, pendingDir, recordModelOutcome: () => {} });

  const requeued = JSON.parse(fs.readFileSync(path.join(pendingDir, 'task-1.json'), 'utf8'));
  assert.equal(requeued.planResponse, undefined, 'stale plan must not survive a review-rejection requeue');
  assert.equal(requeued.implementResponse, undefined, 'stale implement response must not survive a review-rejection requeue');
  // priorRejectionFeedback is the rejection SIGNAL the next plan pass should read -- must
  // survive the same clearing that wipes the stale draft itself.
  assert.ok(Array.isArray(requeued.priorRejectionFeedback) && requeued.priorRejectionFeedback.length > 0);
  assert.ok(requeued.history.some((h) => h.stage === 'requeued' && /cleared stale plan\/implement state/.test(h.detail || '')));
});

// 2026-09-19, ghost-in-the-machine retroactive audit (pipeline_forensics blocked/ bucket):
// blockedStage/blockedReason used to survive this exact requeue untouched -- local-draft.js's
// draftTask() reads task.blockedStage as a LIVE gate right after critique on the NEXT
// attempt, so a stale leftover value short-circuited every subsequent automatic attempt
// straight back to 'blocked' using the FIRST rejection's wording, no matter what the fresh
// redraft actually produced. Confirmed live: a real pipeline_forensics task's attempts 3 and
// 4 produced genuinely different, well-structured 4600/5702-char reports, but both were
// blocked with the byte-identical reason describing attempt 1's 339-char draft.
test('rejectRetryCheck clears stale blockedStage/blockedReason on a genuine review-rejection requeue, not just planResponse/implementResponse', () => {
  const { blockedDir, pendingDir } = setupDirs();
  writeBlockedTask(blockedDir, 'task-1', {
    localRejectCount: 0,
    blockedStage: 'review',
    blockedReason: 'fabricated reference',
  });

  rejectRetryCheck({ blockedDir, pendingDir, recordModelOutcome: () => {} });

  const requeued = JSON.parse(fs.readFileSync(path.join(pendingDir, 'task-1.json'), 'utf8'));
  assert.equal(requeued.blockedStage, undefined, 'a stale blockedStage must not survive a review-rejection requeue -- it gates local-draft.js\'s next attempt as a live "already blocked" check');
  assert.equal(requeued.blockedReason, undefined, 'a stale blockedReason must not survive a review-rejection requeue');
  // The reason is still preserved for the next redraft's prompt -- just no longer live-gated.
  assert.ok(Array.isArray(requeued.priorRejectionFeedback) && requeued.priorRejectionFeedback.includes('fabricated reference'));
});

test('rejectRetryCheck does NOT clear planResponse/implementResponse for a retryable draft-block continuation (not a review rejection)', () => {
  const { blockedDir, pendingDir } = setupDirs();
  const task = {
    id: 'task-1', domain: 'adhoc', source: 'manual',
    blockedStage: 'draft', blockedReason: 'agentic continuation', retryableDraftBlock: true,
    isAgenticContinuation: true, agenticContinuationCount: 1, agenticContinuationNote: 'ran out of turns partway through',
    planResponse: '# Plan\n1. Do the thing.',
    implementResponse: 'partial progress notes',
    history: [], localRejectCount: 0,
  };
  fs.writeFileSync(path.join(blockedDir, 'task-1.json'), JSON.stringify(task, null, 2));

  rejectRetryCheck({ blockedDir, pendingDir, adhocDir: path.join(blockedDir, '..', 'adhoc'), recordModelOutcome: () => {} });

  const adhocDir = path.join(blockedDir, '..', 'adhoc');
  const requeued = JSON.parse(fs.readFileSync(path.join(adhocDir, 'task-1.json'), 'utf8'));
  // A continuation must build ON the prior plan, not restart from nothing.
  assert.equal(requeued.planResponse, '# Plan\n1. Do the thing.');
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
  assert.deepEqual(summary, { checked: 0, requeued: 0, exhausted: 0, recovered: 0, errors: 0 });
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

test('a status:blocked adhoc task stranded in queue/adhoc/ is picked up (not only queue/blocked/)', () => {
  const d = setupAdhocDirs();
  const task = { id: 'adhoc-stranded', domain: 'adhoc', source: 'manual', status: 'blocked',
    blockedStage: 'review', blockedReason: 'cited a value nowhere in grounding', localRejectCount: 0, history: [] };
  fs.writeFileSync(path.join(d.adhocDir, 'adhoc-stranded.json'), JSON.stringify(task));

  const summary = rejectRetryCheck({ ...d, recordModelOutcome: () => {} });

  assert.equal(summary.requeued, 1);
  const out = JSON.parse(fs.readFileSync(path.join(d.adhocDir, 'adhoc-stranded.json'), 'utf8'));
  assert.equal(out.localRejectCount, 1);
  assert.equal(out.status, 'pending', 'terminal block state cleared so the next tick does not re-requeue it');
  assert.deepEqual(out.priorRejectionFeedback, ['cited a value nowhere in grounding']);

  // second tick: not re-requeued (status no longer 'blocked')
  const again = rejectRetryCheck({ ...d, recordModelOutcome: () => {} });
  assert.equal(again.requeued, 0);
});

test('a status:blocked adhoc task in queue/adhoc/ at the retry cap escalates to needs-clarification', () => {
  const d = setupAdhocDirs();
  const task = { id: 'adhoc-cap', domain: 'adhoc', source: 'manual', status: 'blocked',
    blockedStage: 'review', blockedReason: 'never produced a real diff', localRejectCount: 2, history: [] };
  fs.writeFileSync(path.join(d.adhocDir, 'adhoc-cap.json'), JSON.stringify(task));

  const summary = rejectRetryCheck({ ...d, recordModelOutcome: () => {} });

  assert.equal(summary.exhausted, 1);
  assert.ok(!fs.existsSync(path.join(d.adhocDir, 'adhoc-cap.json')));
  assert.ok(fs.existsSync(path.join(d.needsClarificationDir, 'adhoc-cap.json')));
});

test('a non-blocked adhoc task in queue/adhoc/ is left completely alone', () => {
  const d = setupAdhocDirs();
  const task = { id: 'adhoc-fresh', domain: 'adhoc', source: 'manual', history: [] };
  fs.writeFileSync(path.join(d.adhocDir, 'adhoc-fresh.json'), JSON.stringify(task));
  const summary = rejectRetryCheck({ ...d, recordModelOutcome: () => {} });
  assert.deepEqual(summary, { checked: 0, requeued: 0, exhausted: 0, recovered: 0, errors: 0 });
  assert.ok(fs.existsSync(path.join(d.adhocDir, 'adhoc-fresh.json')));
});

test('an agentic continuation is requeued to adhoc/ even past the redraft cap, without burning a redraft slot, with a "continue from here" feedback', () => {
  const d = setupAdhocDirs();
  const task = {
    id: 'adhoc-cont', domain: 'adhoc', source: 'manual',
    retryableDraftBlock: true, isAgenticContinuation: true, agenticContinuationCount: 1,
    agenticContinuationNote: 'ran out of turns; still need the /api/plugins/marketplace route and the test file',
    priorPartialDiff: 'diff --git a/python/dashboard/app.py ...',
    blockedReason: 'ran out of turns mid-implementation -- continuation 1/2',
    localRejectCount: 2, // already at the blind-redraft cap -- must NOT block the continuation
    history: [],
  };
  fs.writeFileSync(path.join(d.blockedDir, 'adhoc-cont.json'), JSON.stringify(task));

  const summary = rejectRetryCheck({ ...d, recordModelOutcome: () => {} });

  assert.equal(summary.requeued, 1);
  assert.equal(summary.exhausted, 0, 'not treated as exhausted despite localRejectCount 2');
  const out = JSON.parse(fs.readFileSync(path.join(d.adhocDir, 'adhoc-cont.json'), 'utf8'));
  assert.equal(out.localRejectCount, 2, 'continuation does not spend a redraft slot');
  assert.equal(out.isAgenticContinuation, true, 'flag kept so resolveAgenticDraft can enforce the cap next pass');
  assert.match(out.priorRejectionFeedback.join('\n'), /CONTINUATION, not a fresh start/);
  assert.match(out.priorRejectionFeedback.join('\n'), /still need the \/api\/plugins\/marketplace route/);
  assert.equal(out.agenticContinuationNote, undefined, 'consumed');
  assert.equal(out.priorPartialDiff, undefined, 'consumed');
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

test('a NON-adhoc, non-candidateFulfillment exhausted rejection keeps the original "stamp and stay in blocked/" behaviour', () => {
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

// 2026-09-18 (brain-dump bd-1789702787675): a candidate-fulfillment source (the whole
// "_fix" family: observability_fix, performance_fix, pipeline_forensics_fix, ...) used to
// fall into the exact same permanent "stamp and stay in blocked/" dead end as any other
// non-adhoc source above -- confirmed live via 10 real blocked _fix tasks, 9 of which sat
// re-flagged by context-trim-sweep's own contextTrimFlag (a disposition nothing ever
// consumed) for up to 12 days with zero resolution. These now get the SAME real
// escalation adhoc always had, just with fulfillment-shaped question text.

test('a candidateFulfillment source (a "_fix" task) exhausted rejection NOW escalates to needs-clarification', () => {
  clearRegistry();
  registerTaskSource('fixture_observability_fix', { priority: 80, next: () => null, candidateFulfillment: true });
  const d = setupAdhocDirs();
  const task = {
    id: 'obs-fix-1', source: 'fixture_observability_fix', blockedStage: 'review',
    blockedReason: "The draft's find string does not match the actual source code.",
    localRejectCount: 2, priorRejectionFeedback: ['first rejection reason'], history: [],
  };
  fs.writeFileSync(path.join(d.blockedDir, 'obs-fix-1.json'), JSON.stringify(task));

  const summary = rejectRetryCheck({ ...d, recordModelOutcome: () => {} });

  assert.equal(summary.exhausted, 1);
  assert.ok(!fs.existsSync(path.join(d.blockedDir, 'obs-fix-1.json')), 'moved out of blocked/');
  const p = path.join(d.needsClarificationDir, 'obs-fix-1.json');
  assert.ok(fs.existsSync(p), 'landed in needs-clarification/, not stuck in blocked/');
  const out = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(out.needsClarification.reason, 'design-decision');
  assert.match(out.needsClarification.openQuestions, /first rejection reason/);
  assert.match(out.needsClarification.openQuestions, /find string does not match/);
  assert.match(out.needsClarification.openQuestions, /already fixed/);
  assert.ok(out.history.some((h) => h.stage === 'needs-clarification'));
  clearRegistry();
});

test('a candidateFulfillment source exhaustion escalation is idempotent across ticks, same as adhoc', () => {
  clearRegistry();
  registerTaskSource('fixture_observability_fix', { priority: 80, next: () => null, candidateFulfillment: true });
  const d = setupAdhocDirs();
  const task = {
    id: 'obs-fix-idem', source: 'fixture_observability_fix', blockedStage: 'review', blockedReason: 'r',
    localRejectCount: 2, history: [{ stage: 'needs-clarification', at: 'x' }],
  };
  fs.writeFileSync(path.join(d.blockedDir, 'obs-fix-idem.json'), JSON.stringify(task));
  const summary = rejectRetryCheck({ ...d, recordModelOutcome: () => {} });
  assert.equal(summary.exhausted, 1);
  assert.ok(fs.existsSync(path.join(d.blockedDir, 'obs-fix-idem.json')), 'already escalated on a prior tick -- left where it is');
  clearRegistry();
});

// --- 2026-09-01: an adhoc tier-3 draft-stage block a redraft could plausibly fix
// (resolveAgenticDraft stamps task.retryableDraftBlock -- turn-budget exhaustion OR a
// malformed decompose) is now retried, not a permanent dead end. -----------------------

test('an adhoc turn-budget-exhausted block is requeued to queue/adhoc/ with an edit-early feedback line', () => {
  const d = setupAdhocDirs();
  const task = {
    id: 'adhoc-tb', domain: 'adhoc', source: 'manual', retryableDraftBlock: true, turnBudgetExhausted: true,
    blockedReason: 'Agentic implement pass exhausted its turn budget without making any edits -- likely needs grounding or a smaller scope',
    localRejectCount: 0, history: [],
  };
  fs.writeFileSync(path.join(d.blockedDir, 'adhoc-tb.json'), JSON.stringify(task));

  const summary = rejectRetryCheck({ ...d, recordModelOutcome: () => {} });

  assert.equal(summary.requeued, 1);
  assert.ok(fs.existsSync(path.join(d.adhocDir, 'adhoc-tb.json')), 'lands in queue/adhoc/');
  const out = JSON.parse(fs.readFileSync(path.join(d.adhocDir, 'adhoc-tb.json'), 'utf8'));
  assert.equal(out.localRejectCount, 1);
  assert.equal(out.turnBudgetExhausted, undefined, 'flags cleared on requeue');
  assert.equal(out.retryableDraftBlock, undefined, 'flags cleared on requeue');
  assert.equal(out.priorRejectionFeedback.length, 1);
  assert.match(out.priorRejectionFeedback[0], /made ZERO edits/);
  assert.match(out.priorRejectionFeedback[0], /edit_file within the first few turns/);
});

test('an adhoc diff-substance block is requeued with the pointed adhocDiffSubstanceFeedback', () => {
  const d = setupAdhocDirs();
  const task = {
    id: 'adhoc-ds', domain: 'adhoc', source: 'manual', retryableDraftBlock: true,
    adhocDiffSubstanceFeedback: 'Your diff only created/edited documentation (docs/adr/0021-x.md). That is not the deliverable -- implement the actual change in python/dashboard/templates/index.html.',
    blockedReason: 'Agentic implement pass produced a diff that is not a real implementation -- diff only touches documentation',
    localRejectCount: 0, history: [],
  };
  fs.writeFileSync(path.join(d.blockedDir, 'adhoc-ds.json'), JSON.stringify(task));

  const summary = rejectRetryCheck({ ...d, recordModelOutcome: () => {} });

  assert.equal(summary.requeued, 1);
  const out = JSON.parse(fs.readFileSync(path.join(d.adhocDir, 'adhoc-ds.json'), 'utf8'));
  assert.equal(out.localRejectCount, 1);
  assert.equal(out.adhocDiffSubstanceFeedback, undefined, 'consumed on requeue');
  assert.equal(out.priorRejectionFeedback.length, 1);
  assert.match(out.priorRejectionFeedback[0], /only created\/edited documentation/);
  assert.match(out.priorRejectionFeedback[0], /index\.html/);
});

test('an adhoc no-changes-needed claim block is requeued with the pointed adhocNoChangesClaimFeedback', () => {
  const d = setupAdhocDirs();
  const task = {
    id: 'adhoc-ncc', domain: 'adhoc', source: 'manual', retryableDraftBlock: true,
    adhocNoChangesClaimFeedback: 'You answered RESOLUTION: no-changes-needed but gave no "Already covered:" block. List every concrete object the request names with a real file:symbol citation.',
    blockedReason: 'Agentic implement pass resolved no-changes-needed but no "Already covered:" block at all',
    localRejectCount: 0, history: [],
  };
  fs.writeFileSync(path.join(d.blockedDir, 'adhoc-ncc.json'), JSON.stringify(task));

  const summary = rejectRetryCheck({ ...d, recordModelOutcome: () => {} });

  assert.equal(summary.requeued, 1);
  const out = JSON.parse(fs.readFileSync(path.join(d.adhocDir, 'adhoc-ncc.json'), 'utf8'));
  assert.equal(out.localRejectCount, 1);
  assert.equal(out.adhocNoChangesClaimFeedback, undefined, 'consumed on requeue');
  assert.equal(out.priorRejectionFeedback.length, 1);
  assert.match(out.priorRejectionFeedback[0], /Already covered/);
});

test('an adhoc malformed-decompose block is requeued with a decompose-format feedback line', () => {
  const d = setupAdhocDirs();
  const task = {
    id: 'adhoc-md', domain: 'adhoc', source: 'manual', retryableDraftBlock: true,
    blockedReason: 'Agentic implement pass said RESOLUTION: decompose but did not follow it with a valid JSON array of at least 2 {title, rawText} sub-tasks',
    localRejectCount: 0, history: [],
  };
  fs.writeFileSync(path.join(d.blockedDir, 'adhoc-md.json'), JSON.stringify(task));

  const summary = rejectRetryCheck({ ...d, recordModelOutcome: () => {} });

  assert.equal(summary.requeued, 1);
  const out = JSON.parse(fs.readFileSync(path.join(d.adhocDir, 'adhoc-md.json'), 'utf8'));
  assert.equal(out.localRejectCount, 1);
  assert.equal(out.retryableDraftBlock, undefined);
  assert.match(out.priorRejectionFeedback[0], /chose RESOLUTION: decompose but the sub-task JSON was malformed/);
  assert.match(out.priorRejectionFeedback[0], /valid JSON array of 2\+ objects/);
  assert.doesNotMatch(out.priorRejectionFeedback[0], /made ZERO edits/);
});

test('an adhoc decompose-into-one re-scope block is requeued with promptContext.rawText swapped in', () => {
  const d = setupAdhocDirs();
  const task = {
    id: 'adhoc-rs', domain: 'adhoc', source: 'manual', retryableDraftBlock: true,
    rescopedFromDecompose: true, rescopedRawText: 'add POST /api/chat/inject to python/dashboard/app.py',
    promptContext: { rawText: 'the original broader ask' },
    blockedReason: 'Agentic pass re-scoped this to a single sharper sub-task; requeued once for a focused implement pass',
    localRejectCount: 0, history: [],
  };
  fs.writeFileSync(path.join(d.blockedDir, 'adhoc-rs.json'), JSON.stringify(task));

  const summary = rejectRetryCheck({ ...d, recordModelOutcome: () => {} });

  assert.equal(summary.requeued, 1);
  const out = JSON.parse(fs.readFileSync(path.join(d.adhocDir, 'adhoc-rs.json'), 'utf8'));
  assert.equal(out.promptContext.rawText, 'add POST /api/chat/inject to python/dashboard/app.py');
  assert.equal(out.rescopedFromDecompose, true, 'kept for the escalation cap');
  assert.equal(out.rescopedRawText, undefined, 'consumed');
  assert.match(out.priorRejectionFeedback[0], /Do not decompose again/);
});

test('an adhoc infra-error block is requeued to queue/adhoc/ with the retry-the-operation feedback line', () => {
  const d = setupAdhocDirs();
  const task = {
    id: 'adhoc-infra', domain: 'adhoc', source: 'manual', retryableDraftBlock: true,
    infraErrorRetry: true, infraErrorBefore: true,
    infraErrorNote: 'RESOLUTION: needs-human-decision\nBLOCKER-TYPE: infra-error\nrun_bash returned ETIMEDOUT on every `node --check` call.',
    blockedReason: 'Agentic implement pass tagged BLOCKER-TYPE: infra-error -- a tool/environment failure, not a design question, requeued for a clean retry',
    localRejectCount: 0, history: [],
  };
  fs.writeFileSync(path.join(d.blockedDir, 'adhoc-infra.json'), JSON.stringify(task));

  const summary = rejectRetryCheck({ ...d, recordModelOutcome: () => {} });

  assert.equal(summary.requeued, 1);
  assert.ok(fs.existsSync(path.join(d.adhocDir, 'adhoc-infra.json')), 'lands in queue/adhoc/');
  const out = JSON.parse(fs.readFileSync(path.join(d.adhocDir, 'adhoc-infra.json'), 'utf8'));
  assert.equal(out.localRejectCount, 1);
  assert.equal(out.infraErrorRetry, undefined, 'transient flag cleared on requeue');
  assert.equal(out.infraErrorNote, undefined, 'consumed on requeue');
  assert.equal(out.infraErrorBefore, true, 'sticky flag retained for the exhaustion-reason check');
  assert.equal(out.retryableDraftBlock, undefined);
  assert.equal(out.priorRejectionFeedback.length, 1);
  assert.match(out.priorRejectionFeedback[0], /tool\/environment failure/);
  assert.match(out.priorRejectionFeedback[0], /ETIMEDOUT/);
});

test('an exhausted infra-error task escalates with reason:infra-error, not design-decision', () => {
  const d = setupAdhocDirs();
  const task = {
    id: 'adhoc-infra-cap', domain: 'adhoc', source: 'manual', retryableDraftBlock: true, infraErrorBefore: true,
    blockedReason: 'Agentic implement pass tagged BLOCKER-TYPE: infra-error',
    localRejectCount: 2, priorRejectionFeedback: ['x', 'y'], history: [],
  };
  fs.writeFileSync(path.join(d.blockedDir, 'adhoc-infra-cap.json'), JSON.stringify(task));

  const summary = rejectRetryCheck({ ...d, recordModelOutcome: () => {} });

  assert.equal(summary.exhausted, 1);
  const out = JSON.parse(fs.readFileSync(path.join(d.needsClarificationDir, 'adhoc-infra-cap.json'), 'utf8'));
  assert.equal(out.needsClarification.reason, 'infra-error');
});

// --- forbidden-path gate-bug re-admission (2026-09-09): a block that named one of the
// task's OWN declared targets is a now-fixed adhoc-diff-sanity false positive; the system
// re-admits it clean-slate rather than dead-ending / needing an operator requeue. --------

const FORBIDDEN_TARGET_BLOCK_REASON =
  'Agentic implement pass produced a diff that is not a real implementation -- diff touches '
  + 'python/dashboard/templates/index.html (matches forbidden "python/dashboard/templates/index.html") '
  + '-- the task explicitly says not to';

function forbiddenPathReadmitTask(extra = {}) {
  return {
    id: 'adhoc-fp', domain: 'adhoc', source: 'manual', status: 'blocked',
    title: 'Decompose python/dashboard/templates/index.html — wire up the 4 new file(s)',
    lastGoodPlan: '# PLAN\nUsing `edit_file` on `python/dashboard/templates/index.html`, insert the four `<script>` tags.\n## CRITERIA:\n- No other lines in `index.html` were modified.',
    retryableDraftBlock: true, adhocResolution: 'needs-human-decision',
    blockedReason: FORBIDDEN_TARGET_BLOCK_REASON,
    priorRejectionFeedback: [
      'A prior attempt spent its whole turn budget exploring and made ZERO edits.',
      'Your diff modified python/dashboard/templates/index.html, which the task EXPLICITLY forbids ("index.html"). Discard those changes entirely.',
    ],
    localRejectCount: 2, turnBudgetExhaustedBefore: true,
    history: [{ stage: 'needs-clarification', at: '2026-09-08T10:02:11Z' }],
    ...extra,
  };
}

test('a forbidden-path block that named one of the task\'s own declared targets is re-admitted clean-slate, not exhausted', () => {
  const d = setupAdhocDirs();
  fs.writeFileSync(path.join(d.blockedDir, 'adhoc-fp.json'), JSON.stringify(forbiddenPathReadmitTask()));

  const summary = rejectRetryCheck({ ...d, recordModelOutcome: () => {} });

  assert.equal(summary.requeued, 1);
  assert.equal(summary.exhausted, 0);
  assert.ok(fs.existsSync(path.join(d.adhocDir, 'adhoc-fp.json')), 'back in queue/adhoc/');
  assert.ok(!fs.existsSync(path.join(d.blockedDir, 'adhoc-fp.json')));
  const out = JSON.parse(fs.readFileSync(path.join(d.adhocDir, 'adhoc-fp.json'), 'utf8'));
  assert.equal(out.localRejectCount, undefined, 'retry budget reset');
  assert.equal(out.priorRejectionFeedback, undefined, 'poisoned "index.html is forbidden" feedback dropped');
  assert.equal(out.blockedReason, undefined);
  assert.equal(out.turnBudgetExhaustedBefore, undefined);
  assert.equal(out.forbiddenPathReadmitted, true, 're-admission is stamped so it happens at most once');
  assert.ok(out.history.some((h) => h.stage === 'requeued' && /own declared edit targets/.test(h.detail)));
});

test('the forbidden-path re-admission fires at most once (forbiddenPathReadmitted stamp)', () => {
  const d = setupAdhocDirs();
  fs.writeFileSync(path.join(d.blockedDir, 'adhoc-fp.json'),
    JSON.stringify(forbiddenPathReadmitTask({ forbiddenPathReadmitted: true })));

  const summary = rejectRetryCheck({ ...d, recordModelOutcome: () => {} });

  assert.equal(summary.requeued, 0, 'not re-admitted a second time');
  // localRejectCount 2 + already-escalated history -> normal exhaustion path, left in place
  assert.equal(summary.exhausted, 1);
  assert.ok(!fs.existsSync(path.join(d.adhocDir, 'adhoc-fp.json')));
});

test('a forbidden-path block naming a genuine NON-target file is NOT re-admitted', () => {
  const d = setupAdhocDirs();
  const task = forbiddenPathReadmitTask({
    id: 'adhoc-fp-real',
    blockedReason: 'Agentic implement pass produced a diff that is not a real implementation -- diff touches src/git-runner.js (matches forbidden "src/git-runner.js") -- the task explicitly says not to',
    priorRejectionFeedback: ['Your diff modified src/git-runner.js, which the task EXPLICITLY forbids ("src/git-runner.js").'],
    history: [],
  });
  fs.writeFileSync(path.join(d.blockedDir, 'adhoc-fp-real.json'), JSON.stringify(task));

  const summary = rejectRetryCheck({ ...d, recordModelOutcome: () => {} });

  // localRejectCount 2, no prior needs-clarification event -> real exhaustion escalation
  assert.equal(summary.requeued, 0);
  const out = JSON.parse(fs.readFileSync(path.join(d.needsClarificationDir, 'adhoc-fp-real.json'), 'utf8'));
  assert.equal(out.needsClarification.reason, 'design-decision');
});

test('an adhoc retryable draft block at the retry cap escalates to needs-clarification (honest, after real retries)', () => {
  const d = setupAdhocDirs();
  const task = {
    id: 'adhoc-tb2', domain: 'adhoc', source: 'manual', retryableDraftBlock: true, turnBudgetExhausted: true,
    blockedReason: 'exhausted its turn budget without making any edits',
    localRejectCount: 2, priorRejectionFeedback: ['made ZERO edits (1)', 'made ZERO edits (2)'], history: [],
  };
  fs.writeFileSync(path.join(d.blockedDir, 'adhoc-tb2.json'), JSON.stringify(task));

  const summary = rejectRetryCheck({ ...d, recordModelOutcome: () => {} });

  assert.equal(summary.exhausted, 1);
  const p = path.join(d.needsClarificationDir, 'adhoc-tb2.json');
  assert.ok(fs.existsSync(p), 'escalated to needs-clarification/');
  const out = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.match(out.needsClarification.openQuestions, /could not get this past review after 3 attempts/);

  // Ghost-in-the-Machine (2026-09-09): a retry-cap escalation with no re-admission
  // signature is ghost debt -- one side-finding tagged to the concept.
  const inbox = path.join(d.root, 'queue', 'side-findings-inbox');
  const sf = fs.readdirSync(inbox).map((f) => JSON.parse(fs.readFileSync(path.join(inbox, f), 'utf8')));
  const debt = sf.find((r) => r.stage === 'ghost-debt' && r.taskId === 'adhoc-tb2');
  assert.ok(debt, 'a ghost-debt side-finding was filed');
  assert.equal(debt.conceptId, 'concept-ghost-in-the-machine-0dbeea');
});

test('a NON-adhoc task carrying retryableDraftBlock is NOT requeued (guarded on isAdhocTask)', () => {
  const d = setupAdhocDirs();
  const task = { id: 'nonadhoc-tb', source: 'trouble_log', retryableDraftBlock: true, blockedReason: 'r', localRejectCount: 0, history: [] };
  fs.writeFileSync(path.join(d.blockedDir, 'nonadhoc-tb.json'), JSON.stringify(task));

  const summary = rejectRetryCheck({ ...d, recordModelOutcome: () => {} });

  assert.equal(summary.requeued, 0);
  assert.ok(fs.existsSync(path.join(d.blockedDir, 'nonadhoc-tb.json')), 'left in blocked/');
});

// --- unreliable-grounding escalation (2026-09-06) -------------------------------------
// Root-caused live via pipeline-forensics-fix-ac-8: windowFetchedFileContent falls back
// to anchorConfidence:'none' when it can't find the candidate's cited code at all, and
// refreshCandidateFetchedFiles() re-derives that SAME deterministic result from the SAME
// unchanged file on every retry -- so a blind requeue can only ever reproduce the
// identical failure. Must escalate on the FIRST rejection, not after burning the full
// retry cap on guaranteed repeats.
const { hasUnreliableGrounding } = require('./blocked-task-classifiers.js');

function unreliableGroundingTask(overrides = {}) {
  return {
    id: 'pff-ac8', source: 'pipeline_forensics_fix', blockedStage: 'review',
    blockedReason: 'the draft is a refusal citing insufficient grounding', localRejectCount: 0, history: [],
    promptContext: {
      fetchedFiles: [{ path: 'src/local-draft.js', content: '[LOW-CONFIDENCE GROUNDING...]', anchorConfidence: 'none' }],
    },
    ...overrides,
  };
}

test('hasUnreliableGrounding is true when any fetchedFiles entry has anchorConfidence:none', () => {
  assert.equal(hasUnreliableGrounding(unreliableGroundingTask()), true);
});

test('hasUnreliableGrounding is false for strong/weak confidence or no fetchedFiles at all', () => {
  assert.equal(hasUnreliableGrounding({ promptContext: { fetchedFiles: [{ anchorConfidence: 'strong' }] } }), false);
  assert.equal(hasUnreliableGrounding({ promptContext: { fetchedFiles: [{ anchorConfidence: 'weak' }] } }), false);
  assert.equal(hasUnreliableGrounding({ promptContext: {} }), false);
  assert.equal(hasUnreliableGrounding({}), false);
});

test('a review rejection with anchorConfidence:none escalates to needs-clarification on the FIRST rejection, not after 2 more retries', () => {
  const d = setupAdhocDirs();
  const task = unreliableGroundingTask({ localRejectCount: 0 });
  fs.writeFileSync(path.join(d.blockedDir, 'pff-ac8.json'), JSON.stringify(task));

  const summary = rejectRetryCheck({ ...d, recordModelOutcome: () => {} });

  assert.equal(summary.exhausted, 1);
  assert.equal(summary.requeued, 0);
  assert.ok(!fs.existsSync(path.join(d.blockedDir, 'pff-ac8.json')));
  const p = path.join(d.needsClarificationDir, 'pff-ac8.json');
  assert.ok(fs.existsSync(p), 'escalated straight to needs-clarification/, not requeued to pending/');
  const out = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(out.needsClarification.reason, 'unreliable-grounding');
  assert.match(out.needsClarification.openQuestions, /src\/local-draft\.js/);
  assert.match(out.needsClarification.openQuestions, /blind requeue cannot fix this/);
  assert.ok(out.history.some((h) => h.stage === 'needs-clarification'));
});

test('applies to non-adhoc, non-candidateFulfillment-specific sources alike -- gated on grounding, not on source', () => {
  const d = setupAdhocDirs();
  const task = unreliableGroundingTask({ id: 'obs-x', source: 'observability_fix', domain: 'default' });
  fs.writeFileSync(path.join(d.blockedDir, 'obs-x.json'), JSON.stringify(task));

  const summary = rejectRetryCheck({ ...d, recordModelOutcome: () => {} });

  assert.equal(summary.exhausted, 1);
  assert.ok(fs.existsSync(path.join(d.needsClarificationDir, 'obs-x.json')));
});

test('does not re-escalate a task already carrying a needs-clarification history entry', () => {
  const d = setupAdhocDirs();
  const task = unreliableGroundingTask({ history: [{ stage: 'needs-clarification', at: '2026-01-01T00:00:00Z' }] });
  fs.writeFileSync(path.join(d.blockedDir, 'pff-ac8.json'), JSON.stringify(task));

  const summary = rejectRetryCheck({ ...d, recordModelOutcome: () => {} });

  // Falls through to the ordinary retry-cap path instead of looping the escalation --
  // localRejectCount 0 is under the cap, so this becomes a normal (if likely futile) requeue.
  assert.equal(summary.requeued, 1);
  assert.equal(summary.exhausted, 0);
});

test('a task with only strong/weak-confidence grounding is NOT escalated -- falls through to the ordinary retry path', () => {
  const d = setupAdhocDirs();
  const task = unreliableGroundingTask({
    promptContext: { fetchedFiles: [{ path: 'src/foo.js', content: 'real content', anchorConfidence: 'strong' }] },
  });
  fs.writeFileSync(path.join(d.blockedDir, 'pff-ac8.json'), JSON.stringify(task));

  const summary = rejectRetryCheck({ ...d, recordModelOutcome: () => {} });

  assert.equal(summary.requeued, 1);
  assert.equal(summary.exhausted, 0);
});

// --- AC-13b: guard against blind re-queueing of feasibility-gated tasks (2026-09-06) --
// AC-13a (local-agentic-write-draft.js's detectExternalDependency) stamps
// needsClarification.reason='external-dependency' on a task that's structurally
// impossible for the sandbox. A stale blockedStage:'review' from an earlier, unrelated
// rejection cycle must never let this sweep blindly re-queue it back into the
// local-agentic-write tier -- retrying can never change "this needs a human to
// provision an external resource first."

test('a review-rejected task ALSO stamped external-dependency is never requeued, under the cap', () => {
  const d = setupAdhocDirs();
  const task = {
    id: 'ext-under-cap', domain: 'adhoc', source: 'manual', status: 'blocked',
    blockedStage: 'review', blockedReason: 'stale rejection from an earlier cycle', localRejectCount: 0, history: [],
    needsClarification: { reason: 'external-dependency', openQuestions: ['confirm the resource'] },
  };
  fs.writeFileSync(path.join(d.adhocDir, 'ext-under-cap.json'), JSON.stringify(task));

  const summary = rejectRetryCheck({ ...d, recordModelOutcome: () => {} });

  assert.equal(summary.requeued, 0);
  assert.equal(summary.exhausted, 0);
  assert.ok(fs.existsSync(path.join(d.adhocDir, 'ext-under-cap.json')), 'left exactly where it was, not re-queued into the write tier');
  const out = JSON.parse(fs.readFileSync(path.join(d.adhocDir, 'ext-under-cap.json'), 'utf8'));
  assert.equal(out.localRejectCount, 0, 'never touched -- not treated as a spent retry');
});

test('a review-rejected task ALSO stamped external-dependency at the retry cap is left alone, not re-stamped design-decision', () => {
  const d = setupAdhocDirs();
  const task = {
    id: 'ext-at-cap', domain: 'adhoc', source: 'manual', status: 'blocked',
    blockedStage: 'review', blockedReason: 'never produced a real diff', localRejectCount: 2, history: [],
    needsClarification: { reason: 'external-dependency', openQuestions: ['confirm the resource'] },
  };
  fs.writeFileSync(path.join(d.adhocDir, 'ext-at-cap.json'), JSON.stringify(task));

  const summary = rejectRetryCheck({ ...d, recordModelOutcome: () => {} });

  assert.equal(summary.exhausted, 0, 'must not run the generic exhaustion/escalation path at all');
  assert.ok(!fs.existsSync(path.join(d.needsClarificationDir, 'ext-at-cap.json')), 'not moved -- it is already the caller\'s job to have filed this appropriately');
  const out = JSON.parse(fs.readFileSync(path.join(d.adhocDir, 'ext-at-cap.json'), 'utf8'));
  assert.equal(out.needsClarification.reason, 'external-dependency', 'the specific reason must survive untouched, never overwritten with the generic design-decision one');
});

test('checked is incremented exactly once for a skipped external-dependency task, not twice', () => {
  const d = setupAdhocDirs();
  const task = {
    id: 'ext-count', domain: 'adhoc', source: 'manual', status: 'blocked',
    blockedStage: 'review', blockedReason: 'r', localRejectCount: 0, history: [],
    needsClarification: { reason: 'external-dependency', openQuestions: [] },
  };
  fs.writeFileSync(path.join(d.adhocDir, 'ext-count.json'), JSON.stringify(task));

  const summary = rejectRetryCheck({ ...d, recordModelOutcome: () => {} });
  assert.equal(summary.checked, 1);
});

test('a plain review rejection with no needsClarification field at all is unaffected by the AC-13b guard', () => {
  const d = setupAdhocDirs();
  const task = { id: 'ordinary', domain: 'adhoc', source: 'manual', blockedStage: 'review', blockedReason: 'r', localRejectCount: 0, history: [] };
  fs.writeFileSync(path.join(d.blockedDir, 'ordinary.json'), JSON.stringify(task));

  const summary = rejectRetryCheck({ ...d, recordModelOutcome: () => {} });
  assert.equal(summary.requeued, 1);
});

// --- unified fault-side registry (2026-09-06) -----------------------------------------
// reject-retry-check.js now consults src/blocked-task-classifiers.js's
// classifyBlockedTask() for the non-retryable decision, generalizing AC-13b's specific
// "already carries needsClarification.reason==='external-dependency'" check to "already
// carries ANY needsClarification, from ANY prior mechanism" -- once a human decision is
// flagged, nothing here should ever re-decide it.
test('a task carrying a needsClarification for an UNRELATED reason (not external-dependency) is also left untouched', () => {
  const d = setupAdhocDirs();
  const task = {
    id: 'some-other-nc', domain: 'adhoc', source: 'manual', status: 'blocked',
    blockedStage: 'review', blockedReason: 'stale rejection from an earlier cycle', localRejectCount: 0, history: [],
    needsClarification: { reason: 'design-decision', openQuestions: 'some unrelated prior question' },
  };
  fs.writeFileSync(path.join(d.adhocDir, 'some-other-nc.json'), JSON.stringify(task));

  const summary = rejectRetryCheck({ ...d, recordModelOutcome: () => {} });

  assert.equal(summary.requeued, 0);
  assert.equal(summary.exhausted, 0);
  const out = JSON.parse(fs.readFileSync(path.join(d.adhocDir, 'some-other-nc.json'), 'utf8'));
  assert.equal(out.needsClarification.reason, 'design-decision', 'left exactly as it was, never re-decided');
  assert.equal(out.localRejectCount, 0);
});

test('a non-retryable classification with no pre-existing needsClarification stamps one using the classifier registry, with category+faultSide in the history detail', () => {
  const d = setupAdhocDirs();
  const task = unreliableGroundingTask({ localRejectCount: 0 });
  fs.writeFileSync(path.join(d.blockedDir, 'pff-ac8.json'), JSON.stringify(task));

  rejectRetryCheck({ ...d, recordModelOutcome: () => {} });

  const out = JSON.parse(fs.readFileSync(path.join(d.needsClarificationDir, 'pff-ac8.json'), 'utf8'));
  const ncEvent = out.history.find((h) => h.stage === 'needs-clarification');
  assert.match(ncEvent.detail, /unreliable-grounding \(harness-side\)/);
});

// --- isReviewRejection: reviewInconclusive carve-out (2026-09-14, hub bd-1788969231749) --
// Inconclusive vs real REJECT are conflated across the whole pipeline: this function used
// to key only on blockedStage:'review', so local-draft.js's two stochastic harness gates
// (postImplementCheck, implement-critique.js's grounding-failed gate) -- which also set
// blockedStage:'review' -- silently inherited the blind-redraft behavior meant for a
// genuine reviewer REJECT. task.reviewInconclusive, stamped only at those two real gate
// sites, is the structured signal that lets this function (and any other downstream
// consumer) tell them apart.
test('isReviewRejection returns false when reviewInconclusive is set, even with blockedStage:"review"', () => {
  assert.equal(isReviewRejection({ blockedStage: 'review', reviewInconclusive: true }), false);
});

test('isReviewRejection returns true for a genuine review rejection (blockedStage:"review", no reviewInconclusive flag)', () => {
  assert.equal(isReviewRejection({ blockedStage: 'review' }), true);
});

// --- deterministic-review-recovery (2026-09-16) -----------------------------------------
// Real incident: 2 brain_dump_sort tasks blocked 2026-09-07 by belongsToProject:"Projects"
// (a Second-Brain vault folder name mistaken for a tracked project label); a 2026-09-11 fix
// auto-corrects exactly this to null, but both tasks were non-adhoc, so the OLD "non-adhoc
// stays in blocked/ forever" exhaustion path stranded them -- found stale 5+ days later,
// confirmed to pass the CURRENT validator with zero redraft needed.

const { registerTaskSource, clearRegistry } = require('./task-source-registry.js');

function setupDirsWithApproved() {
  const d = setupDirs();
  const approvedDir = path.join(d.root, 'queue', 'approved');
  fs.mkdirSync(approvedDir, { recursive: true });
  return { ...d, approvedDir };
}

test('deterministic-review-recovery: a blocked task whose source rule now passes is auto-approved, no redraft', () => {
  clearRegistry();
  registerTaskSource('fake_det_review', {
    priority: 1,
    next: () => null,
    deterministicReview: true,
    deterministicReviewValidate: (task) => (task.implementResponse === 'good' ? { ok: true } : { ok: false, reason: 'bad' }),
  });
  const { blockedDir, pendingDir, approvedDir } = setupDirsWithApproved();
  writeBlockedTask(blockedDir, 'dr-1', {
    source: 'fake_det_review', localRejectCount: 2, implementResponse: 'good',
    blockedReason: 'Deterministic review: the old, now-fixed rule',
  });

  const summary = rejectRetryCheck({ blockedDir, pendingDir, approvedDir, recordModelOutcome: () => {} });

  assert.equal(summary.recovered, 1);
  assert.equal(summary.requeued, 0);
  assert.equal(summary.exhausted, 0);
  assert.ok(!fs.existsSync(path.join(blockedDir, 'dr-1.json')), 'moved out of blocked/');
  assert.ok(fs.existsSync(path.join(approvedDir, 'dr-1.json')), 'landed in approved/');
  const moved = JSON.parse(fs.readFileSync(path.join(approvedDir, 'dr-1.json'), 'utf8'));
  assert.equal(moved.blockedReason, undefined);
  assert.equal(moved.blockedStage, undefined);
  assert.equal(moved.reviewProvider, 'deterministic-review-recovery');
  assert.ok(moved.history.some((h) => h.stage === 'approved' && /deterministic-review-recovery/.test(h.detail)));
  clearRegistry();
});

test('deterministic-review-recovery: a blocked task whose source rule STILL fails falls through to the normal retry/exhaust path, untouched by recovery', () => {
  clearRegistry();
  registerTaskSource('fake_det_review', {
    priority: 1,
    next: () => null,
    deterministicReview: true,
    deterministicReviewValidate: () => ({ ok: false, reason: 'still bad' }),
  });
  const { blockedDir, pendingDir, approvedDir } = setupDirsWithApproved();
  writeBlockedTask(blockedDir, 'dr-2', { source: 'fake_det_review', localRejectCount: 0, implementResponse: 'still-bad' });

  const summary = rejectRetryCheck({ blockedDir, pendingDir, approvedDir, recordModelOutcome: () => {} });

  assert.equal(summary.recovered, 0);
  assert.equal(summary.requeued, 1, 'still under the retry cap -- normal requeue path handles it');
  assert.ok(!fs.existsSync(path.join(approvedDir, 'dr-2.json')));
  clearRegistry();
});

test('deterministic-review-recovery: a source with no deterministicReviewValidate registered is unaffected (ordinary requeue)', () => {
  clearRegistry();
  const { blockedDir, pendingDir, approvedDir } = setupDirsWithApproved();
  writeBlockedTask(blockedDir, 'dr-3', { source: 'manual', localRejectCount: 0 });

  const summary = rejectRetryCheck({ blockedDir, pendingDir, approvedDir, recordModelOutcome: () => {} });

  assert.equal(summary.recovered, 0);
  assert.equal(summary.requeued, 1);
  clearRegistry();
});

// 2026-09-16, real regression: the deterministic-review-recovery tests above all register
// a FAKE source directly via registerTaskSource(), which exercises the RECOVERY LOGIC
// correctly but never proves the real, built-in brain_dump_sort source is actually
// reachable from reject-retry-check.js's own standalone CLI entry point (`node reject-
// retry-check.js`, a fresh process with no other module having required task-sources.js
// first) -- confirmed live: the feature shipped, unit tests green, and was completely
// inert in production because nothing in this file required task-sources.js, so
// getRegisteredSource('brain_dump_sort') returned undefined every time. This test does
// NOT register anything itself -- it only requires this module (as the real CLI does) and
// checks the registry brain_dump_sort actually landed in, catching a reintroduction of
// the exact same wiring gap.
test('the real, built-in brain_dump_sort source is actually registered after requiring this module, in a genuinely FRESH process (regression: task-sources.js must be required as a side effect)', () => {
  // A real child process, not a require-cache trick: this is the exact real-world shape
  // of the bug -- `node reject-retry-check.js` (scripts/queue-watcher.sh's own real
  // invocation) starts a FRESH process with an empty task-source registry. Forcing a
  // re-require inside THIS process risks colliding with other registries (model-profile,
  // etc.) that clearRegistry() doesn't reset -- a real, separate process sidesteps that
  // entirely and proves the actual thing that matters: the registry is populated by the
  // time reject-retry-check.js's own code can look a source up, with no other module
  // having required task-sources.js first.
  const out = require('child_process').execFileSync(
    process.execPath,
    ['-e', "require('./reject-retry-check.js'); const { getRegisteredSource } = require('./task-source-registry.js'); const e = getRegisteredSource('brain_dump_sort'); console.log(JSON.stringify({ found: !!e, hasValidate: !!(e && typeof e.deterministicReviewValidate === 'function') }));"],
    { cwd: __dirname, encoding: 'utf8' },
  );
  const result = JSON.parse(out.trim());
  assert.equal(result.found, true, 'brain_dump_sort must be registered once reject-retry-check.js has been required, in a real fresh process');
  assert.equal(result.hasValidate, true);
});

test('requeue clears adhocNoChangesClaimFeedback but preserves coordination flags', () => {
  const d = setupAdhocDirs();
  const task = {
    id: 'adhoc-sentinel', domain: 'adhoc', source: 'manual', blockedStage: 'review',
    localRejectCount: 0, history: [],
    retryableDraftBlock: true,
    adhocNoChangesClaimFeedback: 'should-be-cleared',
    // Coordination flag set by the decompose/rescope path (resolveAgenticDraft) -- the
    // GUARD at the requeue-delete site in reject-retry-check.js forbids a blanket
    // delete here; this test pins that guard.
    decomposeDirective: 'sentinel-must-survive',
  };
  fs.writeFileSync(path.join(d.blockedDir, 'adhoc-sentinel.json'), JSON.stringify(task));

  const summary = rejectRetryCheck({ ...d, recordModelOutcome: () => {} });

  assert.equal(summary.requeued, 1);
  assert.ok(!fs.existsSync(path.join(d.blockedDir, 'adhoc-sentinel.json')), 'moved out of queue/blocked/');
  assert.ok(fs.existsSync(path.join(d.adhocDir, 'adhoc-sentinel.json')), 'lands in queue/adhoc/');
  const out = JSON.parse(fs.readFileSync(path.join(d.adhocDir, 'adhoc-sentinel.json'), 'utf8'));
  // The feedback value must be CLEARED from the requeued file...
  assert.equal(out.adhocNoChangesClaimFeedback, undefined, 'adhocNoChangesClaimFeedback must not survive the requeue');
  // ...and its value must be preserved in priorRejectionFeedback for the next pass.
  assert.ok(Array.isArray(out.priorRejectionFeedback), 'priorRejectionFeedback must be an array');
  assert.ok(out.priorRejectionFeedback.includes('should-be-cleared'), 'original feedback value must be present in priorRejectionFeedback');
  // ...while the coordination sentinel must reach the next pass intact.
  assert.equal(out.decomposeDirective, 'sentinel-must-survive', 'decomposeDirective must survive the requeue');
});

// 2026-09-17: blockedStage:'pre-critique' (local-draft.js's hard pre-critique guard,
// added 2026-09-16) shipped with no retry-check coverage -- these tasks were entirely
// invisible to this sweep's entry gate (isReviewRejection/retryableDraftBlock only), so
// they sat in queue/blocked/ forever with zero chance of ever redrafting past the bad
// citation. See isPreCritiqueBlock's own header in reject-retry-check.js.

test('isPreCritiqueBlock recognizes blockedStage:pre-critique', () => {
  assert.equal(isPreCritiqueBlock({ blockedStage: 'pre-critique' }), true);
  assert.equal(isPreCritiqueBlock({ blockedStage: 'review' }), false);
  assert.equal(isPreCritiqueBlock({}), false);
});

test('rejectRetryCheck requeues a pre-critique missing-file block under the retry cap', () => {
  const { blockedDir, pendingDir } = setupDirs();
  writeBlockedTask(blockedDir, 'task-1', {
    blockedStage: 'pre-critique',
    blockedReason: 'implementResponse cites src/does-not-exist.js, which is not a file in this repo',
    localRejectCount: 0,
    planResponse: '# Plan\n1. Fix the thing.',
    implementResponse: '{"mode":"edit","file":"src/does-not-exist.js","find":"a","replace":"b"}',
  });

  const summary = rejectRetryCheck({ blockedDir, pendingDir, recordModelOutcome: () => {} });

  assert.equal(summary.requeued, 1);
  assert.equal(summary.exhausted, 0);
  assert.ok(fs.existsSync(path.join(pendingDir, 'task-1.json')));
  assert.ok(!fs.existsSync(path.join(blockedDir, 'task-1.json')));
  const requeued = JSON.parse(fs.readFileSync(path.join(pendingDir, 'task-1.json'), 'utf8'));
  assert.equal(requeued.localRejectCount, 1);
  // The bad implementResponse must not carry forward as "prior work" to build on...
  assert.equal(requeued.implementResponse, undefined, 'stale implement response must not survive a pre-critique requeue');
  // ...but the plan itself is kept -- it wasn't what cited the nonexistent file.
  assert.equal(requeued.planResponse, '# Plan\n1. Fix the thing.', 'planResponse must survive a pre-critique requeue');
  assert.ok(requeued.priorRejectionFeedback.some((f) => /does-not-exist\.js/.test(f)), 'feedback must name the offending citation');
  assert.ok(requeued.history.some((h) => h.stage === 'requeued' && /cleared stale implementResponse/.test(h.detail || '')));
});

test('rejectRetryCheck exhausts a non-adhoc pre-critique block at the retry cap without escalating to needs-clarification', () => {
  const { blockedDir, pendingDir } = setupDirs();
  writeBlockedTask(blockedDir, 'task-1', {
    blockedStage: 'pre-critique',
    blockedReason: 'implementResponse cites src/does-not-exist.js, which is not a file in this repo',
    localRejectCount: 2,
  });
  const needsClarificationDir = path.join(pendingDir, '..', 'needs-clarification');
  fs.mkdirSync(needsClarificationDir, { recursive: true });

  const summary = rejectRetryCheck({ blockedDir, pendingDir, needsClarificationDir, recordModelOutcome: () => {} });

  assert.equal(summary.exhausted, 1);
  assert.equal(summary.requeued, 0);
  assert.ok(fs.existsSync(path.join(blockedDir, 'task-1.json')), 'non-adhoc exhausted task stays in blocked/');
  assert.ok(!fs.existsSync(path.join(needsClarificationDir, 'task-1.json')));
  const stayed = JSON.parse(fs.readFileSync(path.join(blockedDir, 'task-1.json'), 'utf8'));
  assert.ok(stayed.history.some((h) => h.stage === 'exhausted'));
});

// 2026-09-17: blockedStage:'pre-implement' (local-draft.js's hard PRE-implementation
// guard, plan-target-guard.js's planTargetGuard) blocks a plan citing a missing edit
// target BEFORE the implement pass runs at all -- one stage earlier than pre-critique.
// Wired into this entry gate in the SAME change that introduces the blockedStage. See
// isPreImplementBlock's own header in reject-retry-check.js.

test('isPreImplementBlock recognizes blockedStage:pre-implement', () => {
  assert.equal(isPreImplementBlock({ blockedStage: 'pre-implement' }), true);
  assert.equal(isPreImplementBlock({ blockedStage: 'pre-critique' }), false);
  assert.equal(isPreImplementBlock({}), false);
});

test('rejectRetryCheck requeues a pre-implement missing-file block under the retry cap', () => {
  const { blockedDir, pendingDir } = setupDirs();
  writeBlockedTask(blockedDir, 'task-1', {
    blockedStage: 'pre-implement',
    blockedReason: 'plan cites missing-file target(s): src/does-not-exist.js',
    localRejectCount: 0,
    planResponse: '# Plan\n1. Edit src/does-not-exist.js to fix the thing.',
  });

  const summary = rejectRetryCheck({ blockedDir, pendingDir, recordModelOutcome: () => {} });

  assert.equal(summary.requeued, 1);
  assert.equal(summary.exhausted, 0);
  const requeued = JSON.parse(fs.readFileSync(path.join(pendingDir, 'task-1.json'), 'utf8'));
  assert.equal(requeued.localRejectCount, 1);
  // The plan itself named the bad target -- nothing usable to carry forward.
  assert.equal(requeued.planResponse, undefined, 'stale plan must not survive a pre-implement requeue');
  assert.equal(requeued.implementResponse, undefined);
  assert.ok(requeued.priorRejectionFeedback.some((f) => /does-not-exist\.js/.test(f)), 'feedback must name the offending citation');
  assert.ok(requeued.history.some((h) => h.stage === 'requeued' && /cleared stale plan\/implement state/.test(h.detail || '')));
});

test('rejectRetryCheck exhausts a non-adhoc pre-implement block at the retry cap without escalating to needs-clarification', () => {
  const { blockedDir, pendingDir } = setupDirs();
  writeBlockedTask(blockedDir, 'task-1', {
    blockedStage: 'pre-implement',
    blockedReason: 'plan cites missing-file target(s): src/does-not-exist.js',
    localRejectCount: 2,
  });
  const needsClarificationDir = path.join(pendingDir, '..', 'needs-clarification');
  fs.mkdirSync(needsClarificationDir, { recursive: true });

  const summary = rejectRetryCheck({ blockedDir, pendingDir, needsClarificationDir, recordModelOutcome: () => {} });

  assert.equal(summary.exhausted, 1);
  assert.equal(summary.requeued, 0);
  assert.ok(fs.existsSync(path.join(blockedDir, 'task-1.json')), 'non-adhoc exhausted task stays in blocked/');
  const stayed = JSON.parse(fs.readFileSync(path.join(blockedDir, 'task-1.json'), 'utf8'));
  assert.ok(stayed.history.some((h) => h.stage === 'exhausted'));
});

// 2026-09-17: blockedStage:'draft' -- stamped directly by scripts/local-worker.sh (bash),
// not any src/*.js file, so it was missed by the earlier pre-critique audit too (which only
// grepped src/*.js). Same "invisible to this whole sweep" shape as pre-critique, but from a
// different half of the codebase. See isDraftFailureBlock's own header.

test('isDraftFailureBlock / isStructurallyOversizedDraftFailure recognize blockedStage:draft and the oversized reason text', () => {
  assert.equal(isDraftFailureBlock({ blockedStage: 'draft' }), true);
  assert.equal(isDraftFailureBlock({ blockedStage: 'review' }), false);
  assert.equal(isStructurallyOversizedDraftFailure({ blockedStage: 'draft', blockedReason: 'STRUCTURALLY OVERSIZED: ran out of turns twice' }), true);
  assert.equal(isStructurallyOversizedDraftFailure({ blockedStage: 'draft', blockedReason: 'draft call failed 5 times in a row' }), false);
  assert.equal(isStructurallyOversizedDraftFailure({ blockedStage: 'review', blockedReason: 'STRUCTURALLY OVERSIZED' }), false);
});

test('rejectRetryCheck escalates a structurally-oversized draft failure straight to needs-clarification, never blind-retrying it', () => {
  const { blockedDir, pendingDir } = setupDirs();
  writeBlockedTask(blockedDir, 'task-1', {
    blockedStage: 'draft',
    blockedReason: 'STRUCTURALLY OVERSIZED: draft call ran out of turns twice in a row on the very first attempt',
    localRejectCount: 0,
  });
  const needsClarificationDir = path.join(pendingDir, '..', 'needs-clarification');
  fs.mkdirSync(needsClarificationDir, { recursive: true });

  const summary = rejectRetryCheck({ blockedDir, pendingDir, needsClarificationDir, recordModelOutcome: () => {} });

  assert.equal(summary.exhausted, 1);
  assert.equal(summary.requeued, 0);
  assert.ok(!fs.existsSync(path.join(blockedDir, 'task-1.json')));
  assert.ok(fs.existsSync(path.join(needsClarificationDir, 'task-1.json')));
  const escalated = JSON.parse(fs.readFileSync(path.join(needsClarificationDir, 'task-1.json'), 'utf8'));
  assert.equal(escalated.needsClarification.reason, 'design-decision');
  assert.match(escalated.needsClarification.openQuestions, /ran out of turns twice/);
  assert.ok(escalated.history.some((h) => h.stage === 'needs-clarification' && /structurally-oversized/.test(h.detail || '')));
});

test('rejectRetryCheck blind-retries a generic (non-oversized) draft-call failure under the retry cap', () => {
  const { blockedDir, pendingDir } = setupDirs();
  writeBlockedTask(blockedDir, 'task-1', {
    blockedStage: 'draft',
    blockedReason: 'draft call failed 5 times in a row (most recent: connection reset) -- giving up rather than retrying every tick forever',
    localRejectCount: 0,
    planResponse: '# Plan\n1. Do the thing.',
    implementResponse: 'partial garbage from a crashed call',
  });

  const summary = rejectRetryCheck({ blockedDir, pendingDir, recordModelOutcome: () => {} });

  assert.equal(summary.requeued, 1);
  assert.equal(summary.exhausted, 0);
  assert.ok(fs.existsSync(path.join(pendingDir, 'task-1.json')));
  assert.ok(!fs.existsSync(path.join(blockedDir, 'task-1.json')));
  const requeued = JSON.parse(fs.readFileSync(path.join(pendingDir, 'task-1.json'), 'utf8'));
  assert.equal(requeued.localRejectCount, 1);
  assert.equal(requeued.planResponse, undefined, 'stale plan must not survive a draft-call-failure requeue');
  assert.equal(requeued.implementResponse, undefined, 'stale implement response must not survive a draft-call-failure requeue');
  assert.ok(requeued.priorRejectionFeedback.some((f) => /failed outright/.test(f)));
  assert.ok(requeued.history.some((h) => h.stage === 'requeued' && /draft-call failure/.test(h.detail || '')));
});

test('rejectRetryCheck exhausts a non-adhoc generic draft-call failure at the retry cap without escalating', () => {
  const { blockedDir, pendingDir } = setupDirs();
  writeBlockedTask(blockedDir, 'task-1', {
    blockedStage: 'draft',
    blockedReason: 'draft call failed 5 times in a row -- giving up rather than retrying every tick forever',
    localRejectCount: 2,
  });
  const needsClarificationDir = path.join(pendingDir, '..', 'needs-clarification');
  fs.mkdirSync(needsClarificationDir, { recursive: true });

  const summary = rejectRetryCheck({ blockedDir, pendingDir, needsClarificationDir, recordModelOutcome: () => {} });

  assert.equal(summary.exhausted, 1);
  assert.equal(summary.requeued, 0);
  assert.ok(fs.existsSync(path.join(blockedDir, 'task-1.json')), 'non-adhoc exhausted task stays in blocked/');
  assert.ok(!fs.existsSync(path.join(needsClarificationDir, 'task-1.json')));
});

// 2026-09-17: blockedStage:'plan' -- local-draft.js's plan-pass degenerate check used
// to set NO blockedStage at all (nor flip task.status off 'pending'), so it was
// invisible to every check in this file. See isPlanDegenerateBlock's own header.

test('isPlanDegenerateBlock recognizes blockedStage:plan', () => {
  assert.equal(isPlanDegenerateBlock({ blockedStage: 'plan' }), true);
  assert.equal(isPlanDegenerateBlock({ blockedStage: 'draft' }), false);
  assert.equal(isPlanDegenerateBlock({}), false);
});

test('rejectRetryCheck requeues a plan-degenerate block under the retry cap, even though task.status was left at pending', () => {
  const { blockedDir, pendingDir } = setupDirs();
  writeBlockedTask(blockedDir, 'task-1', {
    status: 'pending', // local-draft.js's real behavior: never flipped to 'blocked'
    blockedStage: 'plan',
    blockedReason: 'Plan pass degenerate: truncated',
    localRejectCount: 0,
    planResponse: 'a truncated, unusable plan',
  });

  const summary = rejectRetryCheck({ blockedDir, pendingDir, recordModelOutcome: () => {} });

  assert.equal(summary.requeued, 1);
  assert.equal(summary.exhausted, 0);
  assert.ok(fs.existsSync(path.join(pendingDir, 'task-1.json')));
  assert.ok(!fs.existsSync(path.join(blockedDir, 'task-1.json')));
  const requeued = JSON.parse(fs.readFileSync(path.join(pendingDir, 'task-1.json'), 'utf8'));
  assert.equal(requeued.localRejectCount, 1);
  assert.equal(requeued.planResponse, undefined, 'stale degenerate plan must not survive the requeue');
  assert.ok(requeued.priorRejectionFeedback.some((f) => /degenerate/.test(f)));
  assert.ok(requeued.history.some((h) => h.stage === 'requeued' && /plan-pass degenerate/.test(h.detail || '')));
});

test('rejectRetryCheck exhausts a non-adhoc plan-degenerate block at the retry cap without escalating', () => {
  const { blockedDir, pendingDir } = setupDirs();
  writeBlockedTask(blockedDir, 'task-1', {
    status: 'pending',
    blockedStage: 'plan',
    blockedReason: 'Plan pass degenerate: truncated',
    localRejectCount: 2,
  });
  const needsClarificationDir = path.join(pendingDir, '..', 'needs-clarification');
  fs.mkdirSync(needsClarificationDir, { recursive: true });

  const summary = rejectRetryCheck({ blockedDir, pendingDir, needsClarificationDir, recordModelOutcome: () => {} });

  assert.equal(summary.exhausted, 1);
  assert.equal(summary.requeued, 0);
  assert.ok(fs.existsSync(path.join(blockedDir, 'task-1.json')), 'non-adhoc exhausted task stays in blocked/');
  assert.ok(!fs.existsSync(path.join(needsClarificationDir, 'task-1.json')));
});

// 2026-09-17: every escalation site here used to check "has this task EVER, in its
// whole lifetime, carried a needs-clarification stage" -- correct the first time, but
// permanently wrong once a task is legitimately re-admitted and exhausts AGAIN. Root-
// caused live against the real blocked/ backlog: dozens of tasks stuck in exactly this
// shape. See alreadyEscalatedSinceLastReadmission's own header.

test('alreadyEscalatedSinceLastReadmission: false when a task has never been escalated', () => {
  assert.equal(alreadyEscalatedSinceLastReadmission({ history: [{ stage: 'created' }, { stage: 'draft-started' }] }), false);
  assert.equal(alreadyEscalatedSinceLastReadmission({ history: [] }), false);
  assert.equal(alreadyEscalatedSinceLastReadmission({}), false);
});

test('alreadyEscalatedSinceLastReadmission: true right after an escalation, with nothing since proving a fresh cycle began', () => {
  const task = { history: [
    { stage: 'created' }, { stage: 'exhausted' }, { stage: 'needs-clarification' },
  ] };
  assert.equal(alreadyEscalatedSinceLastReadmission(task), true);
});

test('alreadyEscalatedSinceLastReadmission: false once a fresh draft-started cycle began AFTER the escalation -- eligible to escalate again', () => {
  const task = { history: [
    { stage: 'created' }, { stage: 'exhausted' }, { stage: 'needs-clarification' },
    { stage: 'requeued', detail: 'needs-clarification-triage: requeued for a fresh attempt' },
    { stage: 'draft-started' }, { stage: 'plan-done' }, { stage: 'blocked' },
  ] };
  assert.equal(alreadyEscalatedSinceLastReadmission(task), false, 'a draft-started cycle after the escalation proves this is a NEW exhaustion, not the old one');
});

test('alreadyEscalatedSinceLastReadmission: only the MOST RECENT escalation matters, even with an older one further back', () => {
  const task = { history: [
    { stage: 'needs-clarification' }, // escalation #1, long ago
    { stage: 'draft-started' }, { stage: 'blocked' }, // re-admitted, fresh cycle
    { stage: 'needs-clarification' }, // escalation #2, current -- nothing after it
  ] };
  assert.equal(alreadyEscalatedSinceLastReadmission(task), true, 'the SECOND escalation has nothing after it -- correctly still "already escalated"');
});

test('rejectRetryCheck re-escalates an adhoc task that exhausted a SECOND time after being legitimately re-admitted from needs-clarification', () => {
  const { blockedDir, pendingDir } = setupDirs();
  writeBlockedTask(blockedDir, 'task-1', {
    domain: 'adhoc', source: 'manual',
    localRejectCount: 2,
    history: [
      { stage: 'created' },
      { stage: 'exhausted', detail: '2/2 retries used' },
      { stage: 'needs-clarification', detail: 'escalated to a human after exhausting redraft retries' },
      { stage: 'requeued', detail: 'needs-clarification-triage: requeued for a fresh attempt' },
      { stage: 'draft-started' },
      { stage: 'blocked' },
    ],
  });
  const needsClarificationDir = path.join(pendingDir, '..', 'needs-clarification');
  fs.mkdirSync(needsClarificationDir, { recursive: true });

  const summary = rejectRetryCheck({ blockedDir, pendingDir, needsClarificationDir, recordModelOutcome: () => {} });

  assert.equal(summary.exhausted, 1);
  assert.ok(!fs.existsSync(path.join(blockedDir, 'task-1.json')), 'must move OUT of blocked/ this time -- not silently stay forever');
  assert.ok(fs.existsSync(path.join(needsClarificationDir, 'task-1.json')), 'the SECOND exhaustion must reach a human -- the bug was refusing to re-escalate here');
});
