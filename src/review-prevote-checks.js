'use strict';

// The checks of runReview that run just before the vote (roadmap step 1, piece P6.5a): the edit-set syntax gate, the executed-verification stage, the advisory
// checks and the hit-count gate. Each returns a final review result or null to fall through; runPreVoteChecks runs them in the original order.
// Moved out of review-task.js unchanged (the executed-verification and advisory stages already live in their own modules and are only called here).

const { parseJsonMaybeFenced } = require('./json-fence.js');
const { appendHistoryEvent } = require('./task-history.js');
const { runExecutedVerificationStage } = require('./review-executed-verification.js');
const { runAdvisoryChecks } = require('./review-advisory-checks.js');

// ctx: { task, repoRoot, factCheckVerdict, recordModelOutcome, trimmedImplResponse }
function editSetSyntaxGate(ctx) {
  const { task, repoRoot, factCheckVerdict, recordModelOutcome, trimmedImplResponse } = ctx;
  // Edit-set syntax gate (lib/edit-set-syntax.js, 2026-10-08, TaxHarvest AC-271): the executed-verification block below runs only for adhoc drafts that carry
  // a rawDiff, so a Group B draft (a JSON edit set -- arch_review / function_length_fix / observability_fix / change_review_fix ...) was never syntax-checked and
  // an edit that split an import reached pending-merge. Replays the set against the repo and parses every created/edited file; a file that parsed before the
  // edit and does not now is a deterministic block, same discipline as the gates above (no vote is spent). Coverage (checked / skipped with reasons) is
  // stamped on task.editSetSyntax for the voters. Never throws; AGENT_MANAGER_EDIT_SYNTAX_GATE=advisory|off.
  try {
    const { usesGroupB } = require('./lib/apply-core.js');
    const ess = require('./lib/edit-set-syntax.js');
    const essMode = ess.syntaxGateMode();
    if (essMode !== 'off' && usesGroupB(task) && trimmedImplResponse) {
      let editItems = null;
      try { const v = parseJsonMaybeFenced(trimmedImplResponse); editItems = v ? (Array.isArray(v) ? v : [v]) : null; } catch { editItems = null; }
      if (editItems && editItems.some((i) => i && (i.mode === 'edit' || i.mode === 'create'))) {
        const syn = ess.checkEditSetSyntax(editItems, repoRoot);
        task.editSetSyntax = { at: new Date().toISOString(), checked: syn.checked, skipped: syn.skipped, failed: syn.failed.map((f) => f.file), preexisting: syn.preexisting };
        if (syn.failed.length) {
          const reason = `Deterministic gate: edit-set-syntax -- ${ess.syntaxFeedbackFor(syn.failed)}`.slice(0, 900);
          if (essMode === 'advisory') {
            appendHistoryEvent(task, 'advisory', reason.slice(0, 600));
          } else {
            task.reviewProvider = 'deterministic-edit-set-syntax';
            recordModelOutcome({ callId: task.abCallId, outcome: 'rejected', outcomeStage: 'review', outcomeReason: reason });
            appendHistoryEvent(task, 'blocked', reason);
            return { succeeded: true, verdict: 'blocked', blockedReason: reason, blockedStage: 'review', factCheckVerdict };
          }
        }
      }
    }
  } catch (e) {
    console.error(`[review] edit-set syntax gate errored for ${task.id} (non-fatal, continuing): ${e && e.message}`);
  }
  return null;
}

// ctx: { task, repoRootForCheck, factCheckVerdict, recordModelOutcome }
function hitCountGate(ctx) {
  const { task, repoRootForCheck, factCheckVerdict, recordModelOutcome } = ctx;
  // Deterministic hit-count gate (2026-09-13, pipeline-debrief Task 2 / Flag 2): when an
  // acceptance criterion asserts a SPECIFIC grep hit count (`grep -n <symbol> <file>` ...
  // "exactly N hits" / "returns N hits"), the count is mechanically determinable via
  // `grep -c <symbol> <file>` -- block the draft with the actual count BEFORE any
  // model-reviewer call, instead of spending a vote re-discovering the same systematic
  // mismatch (the model repeats the symbol in comment + code). No-op when no criterion
  // matches the pattern; never throws (a gate error falls through to the normal vote,
  // same non-fatal discipline as the skip-path / policy-change checks above).
  if (process.env.AGENT_MANAGER_HIT_COUNT_GATE !== 'false'
      && Array.isArray(task.acceptanceCriteria) && task.acceptanceCriteria.length) {
    try {
      const { checkHitCountGate } = require('./hit-count-gate.js');
      const gate = checkHitCountGate({ repoRoot: repoRootForCheck, criteria: task.acceptanceCriteria, rawDiff: task.rawDiff });
      if (gate && gate.verdict === 'blocked') {
        task.reviewProvider = 'deterministic-hit-count';
        recordModelOutcome({ callId: task.abCallId, outcome: 'rejected', outcomeStage: 'review', outcomeReason: gate.blockedReason });
        appendHistoryEvent(task, 'blocked', gate.blockedReason);
        return { succeeded: true, verdict: 'blocked', blockedReason: gate.blockedReason, blockedStage: 'review', factCheckVerdict };
      }
    } catch (e) {
      console.error(`[review] hit-count gate errored for ${task.id} (non-fatal, continuing to the vote): ${e && e.message}`);
    }
  }
  return null;
}

// base: { task, repoRoot, repoRootForCheck, pipelineDir, factCheckVerdict, recordModelOutcome, trimmedImplResponse, verifyDiffFn, findInertFn, findOverlapFn,
// findUndefinedFn, findSkipPathsFn } -> a final review result, or null when the draft goes on to the vote.
function runPreVoteChecks(base) {
  const { task, repoRoot, pipelineDir, factCheckVerdict, recordModelOutcome, verifyDiffFn, findInertFn, findOverlapFn, findUndefinedFn, findSkipPathsFn } = base;
  const editSetBlock = editSetSyntaxGate(base);
  if (editSetBlock) return editSetBlock;

  const executedVerificationBlock = runExecutedVerificationStage({ task, repoRoot, pipelineDir, verifyDiffFn, recordModelOutcome, factCheckVerdict });
  if (executedVerificationBlock) return executedVerificationBlock;

  const advisoryBlock = runAdvisoryChecks({ task, repoRoot, factCheckVerdict, recordModelOutcome, findInertFn, findOverlapFn, findUndefinedFn, findSkipPathsFn });
  if (advisoryBlock) return advisoryBlock;

  return hitCountGate(base);
}

module.exports = { editSetSyntaxGate, hitCountGate, runPreVoteChecks };
