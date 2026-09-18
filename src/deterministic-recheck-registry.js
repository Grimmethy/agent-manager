'use strict';

// Registry of deterministic staleness-recheck rules, keyed by the ORIGINAL flagged task's
// source (observability_review, performance_review, ...). staleness-fastpath.js's
// deterministicRecheck() consults this instead of a hardcoded rule->detector map, so the
// scanners that own these rules can live in a plugin (agent-manager-hygiene) without
// staleness-fastpath.js -- a core file on a deterministic hot path -- importing anything
// from src/maintenance/ or naming a plugin source. ADR-0022 Stage B.
//
// A source registers ONE config:
//   registerDeterministicRecheck('observability_review', {
//     perFileRules: {            // rule -> (text, relPath) => findings[]  (needs originalFile)
//       'silent-catch-block': (text, rel) => [...],
//     },
//     repoWideRules: {           // rule -> (repoRoot) => findings[]  (originalFile is null)
//       'missing-reserved-attribute': (repoRoot) => [...],
//     },
//   });
// Each findings entry is { file, line, detail } (scanProject's own shape). Nothing
// registered for a source => deterministicRecheck returns null => the LLM path runs,
// exactly as it did before the fastpath existed.
//
// 2026 caveat -- 'Cheap Verifiers, Large Blind Spots': the cheap-model verifier
// (qwen2.5:3b grounding-check fallback) is a better-than-nothing second layer, NOT a
// substitute for a deterministic check. Its blind spot (the fraction of wrong answers
// wrongly waved through) is LARGEST and moves adversarially in the cheap-student /
// cheap-verifier config. A 'pass' from the 3B verifier is a probability gate, not a
// proof -- the deterministic recheck above is the only layer that can certify a
// staleness finding as resolved.

const registry = {};

// ─── Pre-dispatch gate registry (Map-based, parallel to the object registry above) ───
//
// Gates are consulted BEFORE a task is dispatched to an agent. Each gate receives
// the flagged code snippet and returns a verdict:
//   { verdict: 'archive' | 'investigate', reason: string }
//
// 'archive'   -- the flagged pattern is safe (e.g. fan-out / parallel await); safe to dismiss.
// 'investigate' -- the flagged pattern is potentially problematic (e.g. sequential await in
//                  a loop); route to human/agent for review.
//
// A Map is used (vs. the object above) so that rule IDs with spaces or special characters
// work as keys without Symbol.for or escape acrobatics, and iteration order is stable.

const preDispatchGateRegistry = new Map();

function registerPreDispatchGate(ruleId, detector) {
  if (!ruleId || typeof ruleId !== 'string') {
    throw new TypeError('registerPreDispatchGate: ruleId must be a non-empty string');
  }
  if (typeof detector !== 'function') {
    throw new TypeError('registerPreDispatchGate: detector must be a function');
  }
  if (preDispatchGateRegistry.has(ruleId)) {
    throw new Error(`registerPreDispatchGate: "${ruleId}" is already registered`);
  }
  preDispatchGateRegistry.set(ruleId, detector);
}

function getPreDispatchGate(ruleId) {
  if (!ruleId || typeof ruleId !== 'string') {
    throw new TypeError('getPreDispatchGate: ruleId must be a non-empty string');
  }
  return preDispatchGateRegistry.get(ruleId);
}

function clearPreDispatchGateRegistry() {
  preDispatchGateRegistry.clear();
}

// ─── Detector: sequential-await-in-loop ───
//
// Pure function. Given a snippet of flagged code, decides whether the await usage
// is sequential (inside a loop -- investigate) or a fan-out (parallel -- archive).
//
// Heuristic rules (checked in order):
//   1. Fan-out: snippet contains a parallel promise combinator (Promise.all,
//      Promise.allSettled, Promise.race) AND contains 'await' → 'archive'.
//   2. Loop-bound: snippet contains a loop construct (for / while / do{) AND
//      contains 'await' → 'investigate'.
//   3. Default: neither clearly matches → 'investigate' (fail-safe).

function gateSequentialAwaitInLoop(flaggedCode) {
  if (typeof flaggedCode !== 'string' || flaggedCode.length === 0) {
    throw new TypeError('gateSequentialAwaitInLoop: flaggedCode must be a non-empty string');
  }

  const hasAwait = /\bawait\b/.test(flaggedCode);

  if (!hasAwait) {
    // No await at all -- nothing to gate; treat as safe to archive.
    return { verdict: 'archive', reason: 'No await expression found in flagged snippet' };
  }

  // Fan-out rule: parallel promise combinators indicate concurrent dispatch.
  const fanOutPattern = /\bPromise\s*\.\s*(all|allSettled|race)\s*\(/;
  if (fanOutPattern.test(flaggedCode)) {
    return {
      verdict: 'archive',
      reason: 'Await is fan-out (parallel): Promise.all/allSettled/race detected',
    };
  }

  // Loop-bound rule: await inside a loop body means sequential iteration.
  const loopPattern = /\b(?:for|while)\s*[\({]|do\s*\{/;
  if (loopPattern.test(flaggedCode)) {
    return {
      verdict: 'investigate',
      reason: 'Sequential await inside a loop-bound iteration',
    };
  }

  // Default: could not confirm fan-out; fail safe.
  return {
    verdict: 'investigate',
    reason: 'Ambiguous: could not confirm fan-out; treating as potential sequential await',
  };
}

// Register the detector under both the canonical machine-readable key and the
// human-readable alias.
registerPreDispatchGate('sequential-await-in-loop', gateSequentialAwaitInLoop);
registerPreDispatchGate('sequential await in loop', gateSequentialAwaitInLoop);

// ─── End pre-dispatch gate registry ───

function registerDeterministicRecheck(sourceName, config) {
  if (!sourceName || typeof sourceName !== 'string') {
    throw new Error('registerDeterministicRecheck: sourceName must be a non-empty string');
  }
  if (registry[sourceName]) {
    throw new Error(`registerDeterministicRecheck: "${sourceName}" is already registered`);
  }
  const { perFileRules = {}, repoWideRules = {} } = config || {};
  registry[sourceName] = { perFileRules, repoWideRules };
}

function getDeterministicRecheck(sourceName) {
  return registry[sourceName] || null;
}

function getRecheckSources() {
  return Object.keys(registry);
}

// Test hook only -- mirrors task-source-registry.js's clearRegistry().
function clearDeterministicRecheckRegistry() {
  Object.keys(registry).forEach((key) => delete registry[key]);
}

module.exports = {
  registerDeterministicRecheck,
  getDeterministicRecheck,
  getRecheckSources,
  clearDeterministicRecheckRegistry,
  // Pre-dispatch gate registry
  registerPreDispatchGate,
  getPreDispatchGate,
  clearPreDispatchGateRegistry,
  gateSequentialAwaitInLoop,
};
