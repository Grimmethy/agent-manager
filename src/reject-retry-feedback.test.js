'use strict';

// selectFeedbackBranch / buildFeedbackString and the cleanup that follows them in rejectRetryCheck (HUB0086 3/4). The feedback chain was `if / else if`: only the
// FIRST matching branch supplies the text and only that branch clears its own fields. These tests pin that exclusivity, because a first extraction made every
// branch's cleanup an independent `if` and so deleted feedback fields that were never shown and overwrote promptContext.rawText.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { selectFeedbackBranch, buildFeedbackString, rejectRetryCheck } = require('./reject-retry-check.js');

const NONE = { isContinuation: false, retryableDraftBlock: false, preCritiqueBlock: false, preImplementBlock: false, draftFailureBlock: false, planDegenerateBlock: false };
const sel = (task, over = {}) => selectFeedbackBranch({ task, ...NONE, ...over });

test('each condition on its own selects its branch, and a task with none of them gets the default', () => {
  const R = { retryableDraftBlock: true };
  assert.equal(sel({}, { retryableDraftBlock: true, isContinuation: true }), 'continuation');
  assert.equal(sel({ rescopedFromDecompose: true, rescopedRawText: 'x' }, R), 'rescoped');
  assert.equal(sel({ turnBudgetExhausted: true }, R), 'turn-budget');
  assert.equal(sel({ adhocDiffSubstanceFeedback: 'f' }, R), 'diff-substance');
  assert.equal(sel({ adhocNoChangesClaimFeedback: 'f' }, R), 'no-changes-claim');
  assert.equal(sel({ infraErrorNote: 'n' }, R), 'infra-error');
  assert.equal(sel({}, R), 'malformed-decompose');
  assert.equal(sel({}, { preCritiqueBlock: true }), 'pre-critique');
  assert.equal(sel({}, { preImplementBlock: true }), 'pre-implement');
  assert.equal(sel({}, { draftFailureBlock: true }), 'draft-failure');
  assert.equal(sel({}, { planDegenerateBlock: true }), 'plan-degenerate');
  assert.equal(sel({}), 'default');
});

test('when several conditions hold, the first in the documented precedence wins', () => {
  const R = { retryableDraftBlock: true };
  const all = { rescopedFromDecompose: true, rescopedRawText: 'x', turnBudgetExhausted: true, adhocDiffSubstanceFeedback: 'd', adhocNoChangesClaimFeedback: 'n', infraErrorNote: 'i' };
  assert.equal(sel(all, { ...R, isContinuation: true }), 'continuation');
  assert.equal(sel(all, R), 'rescoped');
  const { rescopedFromDecompose, rescopedRawText, ...noRescope } = all;
  assert.equal(sel(noRescope, R), 'turn-budget');
  const { turnBudgetExhausted, ...noTurn } = noRescope;
  assert.equal(sel(noTurn, R), 'diff-substance');
  const { adhocDiffSubstanceFeedback, ...noDiff } = noTurn;
  assert.equal(sel(noDiff, R), 'no-changes-claim');
  const { adhocNoChangesClaimFeedback, ...onlyInfra } = noDiff;
  assert.equal(sel(onlyInfra, R), 'infra-error');
  // every retryable condition outranks the stage-based ones
  assert.equal(sel({ infraErrorNote: 'i' }, { ...R, preCritiqueBlock: true, draftFailureBlock: true }), 'infra-error');
  assert.equal(sel({}, { ...R, planDegenerateBlock: true }), 'malformed-decompose');
});

test('the retryable-only conditions are ignored unless the block is retryable, and blank feedback fields do not count', () => {
  const flags = { rescopedFromDecompose: true, rescopedRawText: 'x', turnBudgetExhausted: true, adhocDiffSubstanceFeedback: 'd', adhocNoChangesClaimFeedback: 'n', infraErrorNote: 'i' };
  assert.equal(sel(flags), 'default');
  assert.equal(sel(flags, { preCritiqueBlock: true }), 'pre-critique');
  const R = { retryableDraftBlock: true };
  assert.equal(sel({ rescopedFromDecompose: true, rescopedRawText: '   ' }, R), 'malformed-decompose', 'a rescope with no text is not a rescope');
  assert.equal(sel({ rescopedFromDecompose: false, rescopedRawText: 'x' }, R), 'malformed-decompose');
  assert.equal(sel({ adhocDiffSubstanceFeedback: '  ', adhocNoChangesClaimFeedback: '', infraErrorNote: '\n' }, R), 'malformed-decompose');
  assert.equal(sel({ turnBudgetExhausted: 'true' }, R), 'malformed-decompose', 'only the boolean true counts');
});

test('buildFeedbackString gives each branch its own text, whether the branch is passed in or worked out', () => {
  const T = (extra = {}) => ({ blockedReason: 'BLOCK-REASON', ...extra });
  const text = (task, over = {}, branch) => buildFeedbackString({ task, ...NONE, ...over, ...(branch ? { branch } : {}) });
  assert.match(text(T({ agenticContinuationNote: 'NOTE-123', priorPartialDiff: 'd' }), { retryableDraftBlock: true, isContinuation: true }), /CONTINUATION[\s\S]*NOTE-123[\s\S]*ALREADY APPLIED/);
  assert.doesNotMatch(text(T({ agenticContinuationNote: 'NOTE-123' }), { retryableDraftBlock: true, isContinuation: true }), /ALREADY APPLIED/, 'no carried diff, no sentence about it');
  assert.match(text(T({ rescopedFromDecompose: true, rescopedRawText: 'SCOPE-X' }), { retryableDraftBlock: true }), /real scope is exactly: SCOPE-X[\s\S]*Do not decompose again/);
  assert.match(text(T({ turnBudgetExhausted: true }), { retryableDraftBlock: true }), /made ZERO edits/);
  assert.equal(text(T({ adhocDiffSubstanceFeedback: 'DIFF-FEEDBACK' }), { retryableDraftBlock: true }), 'DIFF-FEEDBACK');
  assert.equal(text(T({ adhocNoChangesClaimFeedback: 'NCC-FEEDBACK' }), { retryableDraftBlock: true }), 'NCC-FEEDBACK');
  assert.match(text(T({ infraErrorNote: 'NOTE-EACCES' }), { retryableDraftBlock: true }), /tool\/environment failure[\s\S]*NOTE-EACCES[\s\S]*BLOCKER-TYPE: infra-error/);
  assert.match(text(T(), { retryableDraftBlock: true }), /sub-task JSON was malformed/);
  assert.match(text(T(), { preCritiqueBlock: true }), /cited a file that does not actually exist[\s\S]*BLOCK-REASON/);
  assert.match(text(T(), { preImplementBlock: true }), /edit target that does not actually exist[\s\S]*BLOCK-REASON/);
  assert.match(text(T(), { draftFailureBlock: true }), /draft attempt failed outright[\s\S]*BLOCK-REASON[\s\S]*Try again from a clean pass/);
  assert.match(text(T(), { planDegenerateBlock: true }), /degenerate \(truncated or empty\) plan[\s\S]*BLOCK-REASON/);
  assert.equal(text(T()), 'BLOCK-REASON');
  assert.equal(text({}), '', 'no blockedReason -> empty default');
  assert.equal(text(T({ infraErrorNote: 'N' }), { retryableDraftBlock: true }, 'default'), 'BLOCK-REASON', 'an explicit branch overrides the one the flags would pick');
});

// --- end to end through rejectRetryCheck: only the winning branch's fields are cleared ------------------------------------------------------------
function requeue(extra) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rrc-feedback-'));
  const d = { blockedDir: path.join(root, 'queue', 'blocked'), pendingDir: path.join(root, 'queue', 'pending'), adhocDir: path.join(root, 'queue', 'adhoc'), needsClarificationDir: path.join(root, 'queue', 'needs-clarification') };
  for (const x of Object.values(d)) fs.mkdirSync(x, { recursive: true });
  const task = { id: 't1', domain: 'adhoc', source: 'manual', retryableDraftBlock: true, blockedReason: 'some block', localRejectCount: 0, history: [], promptContext: { rawText: 'ORIGINAL TEXT' }, stacked: { branch: 'agent/x', seq: 2, total: 3 }, dependsOn: ['a'], ...extra };
  fs.writeFileSync(path.join(d.blockedDir, 't1.json'), JSON.stringify(task));
  rejectRetryCheck({ ...d, recordModelOutcome: () => {} });
  return JSON.parse(fs.readFileSync(path.join(d.adhocDir, 't1.json'), 'utf8'));
}

test('a continuation that also carries a rescope clears only the continuation note and leaves promptContext and the rescope alone', () => {
  const out = requeue({ isAgenticContinuation: true, agenticContinuationNote: 'partway', priorPartialDiff: 'diff', rescopedFromDecompose: true, rescopedRawText: 'SHARPER' });
  assert.equal(out.agenticContinuationNote, undefined);
  assert.equal(out.priorPartialDiff, 'diff', 'the carried diff is kept for the next pass');
  assert.equal(out.promptContext.rawText, 'ORIGINAL TEXT', 'the rescope did not win, so it must not rewrite the task text');
  assert.equal(out.rescopedRawText, 'SHARPER', 'and it is still there for a later pass');
  assert.match(out.priorRejectionFeedback[0], /CONTINUATION/);
});

test('with several pointed-feedback fields set, only the one shown is consumed; the others survive for later passes', () => {
  const out = requeue({ adhocDiffSubstanceFeedback: 'DIFF-F', adhocNoChangesClaimFeedback: 'NCC-F', infraErrorNote: 'INFRA-N' });
  assert.deepEqual(out.priorRejectionFeedback, ['DIFF-F']);
  assert.equal(out.adhocDiffSubstanceFeedback, undefined, 'consumed');
  assert.equal(out.adhocNoChangesClaimFeedback, 'NCC-F', 'not shown, so not deleted');
  assert.equal(out.infraErrorNote, 'INFRA-N', 'not shown, so not deleted');
  assert.equal(out.retryableDraftBlock, undefined);
  assert.deepEqual(out.stacked, { branch: 'agent/x', seq: 2, total: 3 }, 'coordination fields survive');
  assert.deepEqual(out.dependsOn, ['a']);
  const ncc = requeue({ adhocNoChangesClaimFeedback: 'NCC-F', infraErrorNote: 'INFRA-N' });
  assert.deepEqual(ncc.priorRejectionFeedback, ['NCC-F']);
  assert.equal(ncc.adhocNoChangesClaimFeedback, undefined);
  assert.equal(ncc.infraErrorNote, 'INFRA-N');
  assert.deepEqual(ncc.stacked, { branch: 'agent/x', seq: 2, total: 3 });
});

test('a turn-budget block does not consume an infra-error note or pointed feedback it did not show', () => {
  const out = requeue({ turnBudgetExhausted: true, infraErrorNote: 'INFRA-N', adhocDiffSubstanceFeedback: 'DIFF-F' });
  assert.match(out.priorRejectionFeedback[0], /made ZERO edits/);
  assert.equal(out.infraErrorNote, 'INFRA-N');
  assert.equal(out.adhocDiffSubstanceFeedback, 'DIFF-F');
  assert.equal(out.turnBudgetExhausted, undefined, 'the shared flag clean-up still runs');
});

test('a rescope that wins rewrites the task text and consumes the rescope, exactly once', () => {
  const out = requeue({ rescopedFromDecompose: true, rescopedRawText: 'SHARPER SCOPE', infraErrorNote: 'INFRA-N' });
  assert.equal(out.promptContext.rawText, 'SHARPER SCOPE');
  assert.equal(out.rescopedRawText, undefined);
  assert.equal(out.rescopedFromDecompose, true, 'kept: it caps a second decompose');
  assert.equal(out.infraErrorNote, 'INFRA-N');
  assert.match(out.priorRejectionFeedback[0], /real scope is exactly: SHARPER SCOPE/);
});

test('an infra-error note that wins is consumed and its retry text names the failure', () => {
  const out = requeue({ infraErrorNote: 'EACCES on write' });
  assert.equal(out.infraErrorNote, undefined);
  assert.match(out.priorRejectionFeedback[0], /EACCES on write/);
});
