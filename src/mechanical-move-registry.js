'use strict';

// verifyMove hook (S3 of the hub-tasks extraction, 2026-09-23, Docs/hub-tasks-extraction-plan.md
// section 3 design point 2). decompose-auto-merge.js (hub KERNEL code -- moved to
// agent-manager-hub-tasks in S5e, 2026-09-25, per the plan's own layering) used to hardcode the vocabulary of
// `promptContext.deterministicApply` kind strings that are safe to auto-merge
// (isMechanicalMoveChild's `=== 'script-extract' || === 'one-pass-decompose'` chain) --
// but that vocabulary belongs to the file-decompose PRODUCER family (script-extract.js,
// decompose-one-pass.js, file-decompose-to-hub.js, ...), which the plan's layering
// decision sends to agent-manager-hygiene, a SEPARATE repo, in S4a. Once that split
// happens, the kernel hardcoding another repo's kind names would be exactly the
// plugin-to-plugin coupling the whole extraction exists to avoid.
//
// Whoever DEFINES a deterministicApply kind registers it here once, with a `verifyMove`
// predicate the kernel calls instead of knowing the kind's name. A kind's own earlier
// validation (e.g. file-decompose's validatePlan proving every symbol resolves, BEFORE the
// move child is even queued) is what actually proves a move mechanical -- verifyMove for
// today's two kinds is `() => true` because membership in a registered kind IS the proof;
// a kind that needs a live re-check at merge time can do real work in its own verifyMove
// instead. An unregistered kind (e.g. 'blueprint-decompose', 'node-module-decompose') falls
// through to `false`, same as today's "not in this list -- pending-merge for a human."

const registry = new Map();

// @param {string} kind - the promptContext.deterministicApply value this producer stamps.
// @param {{verifyMove: (task: object) => boolean}} impl
//
// Re-registering the SAME kind overwrites rather than throws (unlike
// task-source-registry.js's registerTaskSource) -- a producer module's own
// registerMechanicalMoveKind call is a plain module-load side effect, and at least one
// existing test (file-decompose-to-hub.test.js) legitimately clears and re-requires
// decompose-one-pass.js mid-suite, which re-runs that side effect. Throwing there would
// make this registry's own existence a breaking change to an unrelated test's established
// require-cache-clear pattern.
function registerMechanicalMoveKind(kind, impl) {
  if (!kind || typeof kind !== 'string') throw new Error('registerMechanicalMoveKind: kind must be a non-empty string');
  if (!impl || typeof impl.verifyMove !== 'function') throw new Error(`registerMechanicalMoveKind('${kind}'): impl.verifyMove must be a function`);
  registry.set(kind, impl);
}

// True only when the task's deterministicApply kind is registered AND that kind's own
// verifyMove says yes. Mirrors isMechanicalMoveChild's exact prior signature/defaults
// (false for a missing/malformed promptContext or an unregistered kind).
function isVerifiedMechanicalMove(task) {
  const kind = task && task.promptContext && task.promptContext.deterministicApply;
  if (!kind) return false;
  const impl = registry.get(kind);
  if (!impl) return false;
  return !!impl.verifyMove(task);
}

// Test-only: unregister everything so a fresh require gets a clean registry, mirroring
// task-source-registry.js's clearRegistry().
function clearMechanicalMoveRegistry() {
  registry.clear();
}

module.exports = { registerMechanicalMoveKind, isVerifiedMechanicalMove, clearMechanicalMoveRegistry };
