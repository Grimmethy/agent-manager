'use strict';

// Deterministic-review hook (S4a of the hub-tasks extraction, 2026-09-24,
// Docs/hub-tasks-extraction-plan.md section 3). review-task.js used to require
// script-extract.js / decompose-one-pass.js / decompose-node-module.js /
// decompose-flask-blueprint.js DIRECTLY to re-derive a deterministic decompose draft
// and byte-compare it, rather than just checking a boolean like S3's
// mechanical-move-registry.js -- a much deeper coupling, since review-task.js is hub
// KERNEL code (stays in agent-manager-hub-tasks per the plan's layering) and those four
// files are the file-decompose PRODUCER family the plan sends to agent-manager-hygiene
// in S4a. Whoever DEFINES a deterministicApply kind registers its own re-derivation
// verdict here; review-task.js only ever calls verifyDeterministicDraft(task, ...).
//
// Same idempotent-overwrite discipline as mechanical-move-registry.js (a producer
// module re-required after a test clears its module cache re-runs the registration).

const registry = new Map();

// @param {string} kind - the promptContext.deterministicApply value this producer stamps.
// @param {{verify: (task: object, repoRoot: string, groundingRef?: string) => (null | {ok: boolean, reason?: string})}} impl
function registerDeterministicReview(kind, impl) {
  if (!kind || typeof kind !== 'string') throw new Error('registerDeterministicReview: kind must be a non-empty string');
  if (!impl || typeof impl.verify !== 'function') throw new Error(`registerDeterministicReview('${kind}'): impl.verify must be a function`);
  registry.set(kind, impl);
}

// null (kind unregistered, or the caller should gate on kind itself before calling this --
// see review-task.js's thin wrappers) | the registered kind's own verify() result.
function verifyDeterministicDraft(task, repoRoot, groundingRef) {
  const kind = task && task.promptContext && task.promptContext.deterministicApply;
  if (!kind) return null;
  const impl = registry.get(kind);
  if (!impl) return null;
  return impl.verify(task, repoRoot, groundingRef);
}

// Shared re-derivation shape for the "N creates + one edit" family (one-pass-decompose,
// node-module-decompose, blueprint-decompose) -- extracted verbatim from review-task.js's
// former verifyDeterministicOnePassDecomposeDraft, which handled all three with one
// switch on `rebuild`. script-extract's shape is genuinely different (a single
// create+edit pair with its own field names -- newFileContent/newHtml/newSource) and
// registers its own full `verify` instead of using this helper.
//
// @param {object} task
// @param {string} repoRoot
// @param {(sourceText: string, sourceFile: string, moves: object[], repoRoot: string) => {ok: boolean, changes?: any[], reason?: string}} rebuild
function verifyOnePassStyleRederivation(task, repoRoot, rebuild) {
  const fs = require('fs');
  const path = require('path');
  const ctx = task.promptContext;
  if (!(ctx.sourceFile && Array.isArray(ctx.moves) && ctx.moves.length >= 1)) return null;

  let parsed;
  try { parsed = JSON.parse(task.implementResponse); } catch { return null; }
  if (!Array.isArray(parsed) || parsed.length < 2) return null;
  const creates = parsed.slice(0, -1);
  const edit = parsed[parsed.length - 1];
  if (!creates.every((c) => c && c.mode === 'create' && typeof c.content === 'string')) return null;
  if (!(edit && edit.mode === 'edit' && edit.file === ctx.sourceFile && typeof edit.find === 'string' && typeof edit.replace === 'string')) return null;

  let sourceText;
  try { sourceText = fs.readFileSync(path.join(repoRoot, ctx.sourceFile), 'utf8'); } catch (e) {
    return { ok: false, reason: `could not re-read ${ctx.sourceFile}: ${e.message}` };
  }

  const fresh = rebuild(sourceText, ctx.sourceFile, ctx.moves, repoRoot);
  if (!fresh || !fresh.ok) {
    return { ok: false, reason: `plan no longer re-derives cleanly against current repo state: ${(fresh && fresh.reason) || 'unknown'}` };
  }
  if (JSON.stringify(fresh.changes) !== JSON.stringify(parsed)) {
    return { ok: false, reason: `the ${creates.length}-module split no longer byte-matches a fresh re-derivation (${ctx.sourceFile} drifted between draft and review)` };
  }
  return { ok: true, moduleCount: creates.length };
}

// Test-only: mirrors mechanical-move-registry.js's clearMechanicalMoveRegistry().
function clearDeterministicReviewRegistry() {
  registry.clear();
}

module.exports = {
  registerDeterministicReview, verifyDeterministicDraft, verifyOnePassStyleRederivation, clearDeterministicReviewRegistry,
};
