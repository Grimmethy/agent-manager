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
};
