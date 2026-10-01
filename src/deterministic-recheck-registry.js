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

// ─── Detector: sync-io-in-loop ───
//
// 2026-09-30: startup bounded-loop exemption (brain-dump bd-1788781713129) -- a 2026-09-16
// triage window ended 25/25 "false-positive dismissal": the sync-io-in-loop rule flagged
// startup-time bounded loops (hardcoded arrays, 3-10 directory walks) identically to
// request-hot-path loops, and every one of them burned a full plan+implement+review cycle
// to be dismissed. Finding's own recommendation: the rule itself (or a suppression list
// keyed on "startup"/"bounded"/"hardcoded") should be the first thing a human looks at.
// Before this gate existed, getPreDispatchGate('sync-io-in-loop') was undefined, so EVERY
// such flag fell through to the multi-agent cycle -- that fall-through is the 100%
// false-positive window.
//
// Pure function. Given a snippet of flagged code, decides whether the sync I/O is in a
// startup-time bounded loop (safe to archive -- runs once at process start, bounded, no
// event-loop contention) or in a hot-path / unbounded loop (investigate).
//
// Heuristic rules (checked in order):
//   1. No loop construct at all -> 'investigate' (nothing to exempt; fail-safe).
//   2. Bounded + startup: the loop bound is a numeric literal <= 10 (or the loop is
//      over a small literal array) AND the enclosing scope names a startup initializer
//      (init/main/bootstrap/setup/load/start) -> 'archive'.
//   3. Hot-path scope (request handler / listener / socket / connection path) ->
//      'investigate' regardless of bound.
//   4. Default: bound above 10, or startup context not confirmable -> 'investigate'
//      (fail-safe, exactly like the await-in-loop detector's ambiguous branch).

const SYNC_IO_BOUND_THRESHOLD = 10;

const SYNC_IO_LOOP_PATTERN = /\b(?:for|while)\s*[\({]|do\s*\{|\.map\s*\(/;
// Comparison operators only (< / <=): `i = 0` loop initializers must NOT count as a bound.
const SYNC_IO_BOUND_PATTERN = /\bi\s*<=?\s*(\d+)|\blength\s*<=?\s*(\d+)/;
const SYNC_IO_ARRAY_BOUND_PATTERN = /for\s*\(.*\bof\s+(\[[^\]]*\])/;
const SYNC_IO_ARRAY_ELEMENT_RE = /'[^']*'|"[^"]*"|`[^`]*`|\b[A-Za-z_$][\w$]*\b/g;
// Startup scope is a function DEFINED with a startup name (function main() / def setup() / const bootstrapAll = () =>), never merely a call to one: a request
// handler or a per-item helper that happens to call loadConfig() or init() is not startup code, and treating the call as proof of startup archived real findings.
const SYNC_IO_STARTUP_NAME = '(?:init|initialize|main|bootstrap|setup|load|start)[\\w]*';
const SYNC_IO_STARTUP_SCOPE_PATTERN = new RegExp(`\\b(?:function\\*?|def)\\s+${SYNC_IO_STARTUP_NAME}\\s*\\(|\\b(?:const|let|var)\\s+${SYNC_IO_STARTUP_NAME}\\s*=\\s*(?:async\\s*)?(?:function\\b|\\([^)]*\\)\\s*=>|[A-Za-z_$][\\w$]*\\s*=>)`);
const SYNC_IO_HOT_PATH_PATTERN = /\b(?:req|request|res|response|socket|client)\b|\bapp\.(?:get|post|put|delete|use|listen)\s*\(|\bon\w*\s*\(/;
// Quoted text is removed before the hot-path test: a startup list that names a directory 'client' is not a request path.
const SYNC_IO_QUOTED_RE = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;

function syncIoBoundedBound(flaggedCode) {
  const boundMatch = flaggedCode.match(SYNC_IO_BOUND_PATTERN);
  if (boundMatch) {
    const n = Number(boundMatch[1] !== undefined ? boundMatch[1] : boundMatch[2]);
    if (Number.isFinite(n) && n <= SYNC_IO_BOUND_THRESHOLD) return true;
    return false; // bound present but above the threshold -> not a bounded-startup loop
  }
  const arrayMatch = flaggedCode.match(SYNC_IO_ARRAY_BOUND_PATTERN);
  if (arrayMatch) {
    const elements = (arrayMatch[1].match(SYNC_IO_ARRAY_ELEMENT_RE) || []).length;
    return Number.isFinite(elements) && elements > 0 && elements <= SYNC_IO_BOUND_THRESHOLD;
  }
  return false; // no literal bound at all (while(true), unbounded iterator) -> not bounded
}

function gateSyncIoInLoop(flaggedCode) {
  if (typeof flaggedCode !== 'string' || flaggedCode.length === 0) {
    throw new TypeError('gateSyncIoInLoop: flaggedCode must be a non-empty string');
  }

  if (!SYNC_IO_LOOP_PATTERN.test(flaggedCode)) {
    return {
      verdict: 'investigate',
      reason: 'No loop construct found in flagged snippet; sync I/O outside a loop cannot be exempted',
    };
  }

  // Hot path FIRST (rule 3 above: hot-path scope is 'investigate' regardless of bound). The first version ran the startup exemption ahead of this test, so a
  // request handler that also called loadConfig() or init() was archived (verified 2026-09-30).
  if (SYNC_IO_HOT_PATH_PATTERN.test(flaggedCode.replace(SYNC_IO_QUOTED_RE, "''"))) {
    return {
      verdict: 'investigate',
      reason: 'Sync I/O inside a loop in request/socket hot-path scope',
    };
  }

  // 2026-09-30: startup bounded-loop exemption (brain-dump bd-1788781713129) --
  // a loop whose bound is a numeric literal <= 10 (or a small hardcoded array) inside a
  // function DEFINED as startup/initialization code runs once at process start and does
  // not block the event loop under request load: dismiss the flag instead of spending a
  // full plan+implement+review cycle on it.
  if (syncIoBoundedBound(flaggedCode) && SYNC_IO_STARTUP_SCOPE_PATTERN.test(flaggedCode)) {
    return {
      verdict: 'archive',
      reason: 'Bounded (<=10) loop in startup/initialization scope: one-time bounded work, not a hot-path violation',
    };
  }

  // Fail-safe: unbounded loop, or startup context not confirmable from the snippet.
  return {
    verdict: 'investigate',
    reason: 'Sync I/O inside a loop; startup bounded-loop exemption not confirmed (bound > 10, unbounded, or no startup scope)',
  };
}

// Register the detector under both the canonical machine-readable key and the
// human-readable alias.
registerPreDispatchGate('sync-io-in-loop', gateSyncIoInLoop);
registerPreDispatchGate('sync io in loop', gateSyncIoInLoop);

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
  gateSyncIoInLoop,
  SYNC_IO_BOUND_THRESHOLD,
};
