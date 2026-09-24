'use strict';

// deterministic-extract.js -- extracted from src/local-draft.js ([[hub-task-integration]] node-module decompose).

const { appendHistoryEvent, setHistoryPersistHook } = require('../task-history.js');
const {
  beginDraftAttempt, recordPlan, recordImplement, recordCritique, recordOrient, recordPlanCritique, recordTier, finalizeDraftAttempt,
} = require('../draft-attempt-record.js');
const { getConfig, ensureRegistered } = require('../config.js');
const { localOllamaLockKey, writeTaskJson, researchClaudeStatus, isResearchDomainTask, draftDoneDetail, concludeDraft } = require('./draft-lifecycle.js');
// Deterministic-draft hook (S4a of the hub-tasks extraction, 2026-09-24) -- the four
// functions below now only gate on their own kind and dispatch here; see
// deterministic-draft-registry.js's own header for the full design.
const { tryRegisteredDeterministicDraft } = require('../deterministic-draft-registry.js');
// script-extract.js stays in core (also required directly by scripts/extract-core-ui.js, a
// standalone dev CLI that can't depend on an optional plugin) -- this require reaches its
// registerDeterministicDraft('script-extract', ...) side effect. decompose-one-pass.js/
// decompose-node-module.js/decompose-flask-blueprint.js moved to agent-manager-hygiene and
// register their own kinds via local-draft.js's own ensureRegistered() call instead.
require('../script-extract.js');

function computePlanNumPredict(task) {
  const ctx = task.promptContext;
  const hasLargeEvidenceBundle = !!(ctx && ctx.evidenceText && ctx.evidenceText.length > 10000);
  const hasLargePromptContext = !!(ctx && JSON.stringify(ctx).length > 6000);
  // change_review (2026-09-19, same incident as implement-critique.js's computeImplementBudget
  // comment): its PART 1 plan pass has to walk EVERY hunk of ctx.unitDiff, one line of
  // classification each. The generic "large prompt context" branch below already gives a
  // change_review task with a 9000-char diff the 2800 floor, and that was fine -- but a
  // genuinely large diff (>10000 chars) exhausted that SAME 2800 purely to think:true's
  // reasoning trace before a single plan line got written (confirmed live: change-review-
  // 7eecbfa's 15057-char diff and change-review-b8a6f21's 12202-char diff, both a 0-char
  // plan on every attempt). Only kicks in above the existing threshold's own proven-good
  // range, so the flat 2800 stays exactly as before for every diff size already confirmed
  // to work with it.
  const unitDiffChars = (ctx && ctx.unitDiff) ? ctx.unitDiff.length : 0;
  if (unitDiffChars > 10000) return Math.min(8000, Math.max(6000, Math.ceil(unitDiffChars / 3)));
  return (ctx && ctx.brainDumpEntryId) || hasLargeEvidenceBundle || hasLargePromptContext ? 2800 : 1400;
}

function tryDeterministicScriptExtractEdit(task, attempt) {
  const ctx = task.promptContext;
  if (!(ctx && ctx.deterministicApply === 'script-extract' && ctx.sourceFile && ctx.newFile && Array.isArray(ctx.symbols) && ctx.symbols.length)) {
    return null;
  }
  return tryRegisteredDeterministicDraft(task, attempt);
}

function tryDeterministicOnePassDecompose(task, attempt) {
  const ctx = task.promptContext;
  if (!(ctx && ctx.deterministicApply === 'one-pass-decompose' && ctx.sourceFile
        && Array.isArray(ctx.moves) && ctx.moves.length >= 2)) {
    return null;
  }
  return tryRegisteredDeterministicDraft(task, attempt);
}

function tryDeterministicNodeModuleDecompose(task, attempt) {
  const ctx = task.promptContext;
  if (!(ctx && ctx.deterministicApply === 'node-module-decompose' && ctx.sourceFile
        && Array.isArray(ctx.moves) && ctx.moves.length >= 1)) {
    return null;
  }
  return tryRegisteredDeterministicDraft(task, attempt);
}

function tryDeterministicBlueprintDecompose(task, attempt) {
  const ctx = task.promptContext;
  if (!(ctx && ctx.deterministicApply === 'blueprint-decompose' && ctx.sourceFile
        && Array.isArray(ctx.moves) && ctx.moves.length >= 1)) {
    return null;
  }
  return tryRegisteredDeterministicDraft(task, attempt);
}


function tryDeterministicLiteralEdit(task, attempt) {
  const literalEditLiterals = (task.promptContext && Array.isArray(task.promptContext.fixedLiterals))
    ? task.promptContext.fixedLiterals
    : [];
  if (!(task.promptContext && typeof task.promptContext.file === 'string' && task.promptContext.file
    && typeof task.promptContext.find === 'string' && task.promptContext.find
    && literalEditLiterals.length === 1 && typeof literalEditLiterals[0].content === 'string' && literalEditLiterals[0].content)) {
    return null;
  }
  task.implementResponse = JSON.stringify({
    mode: 'edit',
    file: task.promptContext.file,
    find: task.promptContext.find,
    replace: literalEditLiterals[0].content,
  });
  recordImplement(attempt, { text: task.implementResponse, note: 'deterministic find/replace (fully specified in the task)' });
  appendHistoryEvent(task, 'implement-done', 'deterministic find/replace (file, find, and the single fixedLiterals block were all fully specified in the task -- constructed directly instead of asking the model to reproduce content it was already handed verbatim)');
  concludeDraft(task);
  return { succeeded: true, blocked: false };
}

module.exports = { computePlanNumPredict, tryDeterministicScriptExtractEdit, tryDeterministicOnePassDecompose, tryDeterministicNodeModuleDecompose, tryDeterministicBlueprintDecompose, tryDeterministicLiteralEdit };
