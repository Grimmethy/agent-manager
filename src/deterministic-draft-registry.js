'use strict';

// Deterministic-draft hook (S4a of the hub-tasks extraction, 2026-09-24). Found live while
// verifying the S4a file move: src/lib/deterministic-extract.js (required by local-draft.js,
// the main draft entrypoint -- hub KERNEL code, stays in core) also called directly into
// script-extract.js's / decompose-one-pass.js's / decompose-node-module.js's /
// decompose-flask-blueprint.js's real build functions -- a THIRD kernel coupling point
// alongside review (decompose-review-registry.js, S4a) and merge (mechanical-move-registry.js,
// S3). Same registry shape as those two: whoever DEFINES a deterministicApply kind registers
// its own tryDraft here; lib/deterministic-extract.js keeps only each kind's cheap gate check
// and dispatches.

const fs = require('fs');
const path = require('path');
const { getConfig } = require('./config.js');
const { appendHistoryEvent } = require('./task-history.js');
const { recordPlan, recordImplement, recordCritique } = require('./draft-attempt-record.js');
const { concludeDraft } = require('./lib/draft-lifecycle.js');
const { captureGroupBDiffInWorktree } = require('./group-b-worktree-diff.js');

const registry = new Map();

// @param {string} kind - the promptContext.deterministicApply value this producer stamps.
// @param {{tryDraft: (task: object, attempt: object) => (null | {succeeded: boolean, blocked: boolean})}} impl
//
// Idempotent overwrite, not throw, on a re-registered kind -- same discipline as
// mechanical-move-registry.js / decompose-review-registry.js (a producer module's
// registration call is a plain load-time side effect that can legitimately re-run after a
// test clears its require cache).
function registerDeterministicDraft(kind, impl) {
  if (!kind || typeof kind !== 'string') throw new Error('registerDeterministicDraft: kind must be a non-empty string');
  if (!impl || typeof impl.tryDraft !== 'function') throw new Error(`registerDeterministicDraft('${kind}'): impl.tryDraft must be a function`);
  registry.set(kind, impl);
}

// null (no kind, or kind unregistered -- caller falls through to the normal drafting path)
// | the registered kind's own tryDraft() result.
function tryRegisteredDeterministicDraft(task, attempt) {
  const kind = task && task.promptContext && task.promptContext.deterministicApply;
  if (!kind) return null;
  const impl = registry.get(kind);
  if (!impl) return null;
  return impl.tryDraft(task, attempt);
}

// Shared "N creates + one edit" draft-construction flow for the one-pass-decompose /
// node-module-decompose / blueprint-decompose family -- moved verbatim from
// lib/deterministic-extract.js's three near-identical functions, which differed only in
// which builder they called and how they described the work. A producer supplies only its
// own `rebuild(sourceText, sourceFile, moves, repoRoot) => {ok, changes, reason?}` and
// `describe(ctx) => {label, plan, implementNote, implementEvent}`.
function runOnePassStyleDraft(task, attempt, rebuild, describe) {
  const ctx = task.promptContext;
  let repoRoot;
  let pipelineDir;
  try { ({ repoRoot, pipelineDir } = getConfig()); } catch { return null; }
  if (!repoRoot) return null;

  let sourceText;
  try { sourceText = fs.readFileSync(path.join(repoRoot, ctx.sourceFile), 'utf8'); } catch { return null; }

  const desc = describe(ctx);
  const built = rebuild(sourceText, ctx.sourceFile, ctx.moves, repoRoot);
  if (!built.ok) {
    appendHistoryEvent(task, 'advisory', `${desc.label} not applicable (${built.reason}) -- falling through to the normal drafting path`);
    return null;
  }

  let rawDiff;
  try {
    rawDiff = captureGroupBDiffInWorktree({
      repoRoot, pipelineDir, implementResponse: JSON.stringify(built.changes), worktreeSuffix: task.id, task,
    });
  } catch (e) {
    appendHistoryEvent(task, 'advisory', `${desc.label} diff capture failed (${String((e && e.message) || e).slice(0, 200)}) -- falling through to the normal drafting path`);
    return null;
  }
  if (!rawDiff) {
    appendHistoryEvent(task, 'advisory', `${desc.label} produced an empty diff against real origin content -- falling through to the normal drafting path`);
    return null;
  }

  task.planResponse = desc.plan;
  recordPlan(attempt, { text: task.planResponse, attempts: 0 });
  appendHistoryEvent(task, 'plan-done', `${desc.label}, no model call`);

  task.implementResponse = JSON.stringify(built.changes);
  task.rawDiff = rawDiff;
  task.adhocResolution = 'implemented';
  recordImplement(attempt, { text: task.implementResponse, note: desc.implementNote });
  appendHistoryEvent(task, 'implement-done', desc.implementEvent);

  task.critiqueOutcome = 'no-issues';
  recordCritique(attempt, { outcome: 'no-issues' });
  appendHistoryEvent(task, 'critique-done', 'no-issues (deterministic move, nothing for a critique pass to add)');

  concludeDraft(task);
  return { succeeded: true, blocked: false };
}

// Test-only: mirrors mechanical-move-registry.js's clearMechanicalMoveRegistry().
function clearDeterministicDraftRegistry() {
  registry.clear();
}

module.exports = {
  registerDeterministicDraft, tryRegisteredDeterministicDraft, runOnePassStyleDraft, clearDeterministicDraftRegistry,
};
