'use strict';

// Pre-dispatch gate registry. Gates are consulted BEFORE a task is dispatched to an agent.
// Each gate receives the flagged code snippet and returns a verdict:
//   { verdict: 'archive' | 'investigate', reason: string }
//
// 'archive'   -- the flagged pattern is safe (e.g. fan-out / parallel await); safe to dismiss.
// 'investigate' -- the flagged pattern is potentially problematic; route to human/agent review.
//
// Nothing is registered at import time. Call registerPreDispatchGates() to register the
// built-in detectors (idempotent).

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
// Heuristic rules (checked in order):
//   1. Fan-out: snippet contains Promise.all / allSettled / race AND 'await' -> 'archive'.
//   2. Loop-bound: snippet contains a loop construct AND 'await' -> 'investigate'.
//   3. Default: neither clearly matches -> 'investigate' (fail-safe).

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

// ─── Detector: sync-io-in-loop ───
//
// Heuristic rules (checked in order):
//   1. No loop construct at all -> 'investigate' (fail-safe).
//   2. Hot-path scope (request handler / listener / socket / connection) -> 'investigate'
//      regardless of bound. This check runs BEFORE the startup exemption.
//   3. Bounded (<=10) loop inside a function DEFINED with a startup name -> 'archive'.
//   4. Default -> 'investigate' (fail-safe).

const SYNC_IO_BOUND_THRESHOLD = 10;

const SYNC_IO_LOOP_PATTERN = /\b(?:for|while)\s*[\({]|do\s*\{|\.map\s*\(/;
// Comparison operators only (< / <=): `i = 0` loop initializers must NOT count as a bound.
const SYNC_IO_BOUND_PATTERN = /\bi\s*<=?\s*(\d+)|\blength\s*<=?\s*(\d+)/;
const SYNC_IO_ARRAY_BOUND_PATTERN = /for\s*\(.*\bof\s+(\[[^\]]*\])/;
const SYNC_IO_ARRAY_ELEMENT_RE = /'[^']*'|"[^"]*"|`[^`]*`|\b[A-Za-z_$][\w$]*\b/g;
// Startup scope is a function DEFINED with a startup name (function main() / def setup() / const bootstrapAll = () =>), never merely a call to one.
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

  // Hot path FIRST (hot-path scope is 'investigate' regardless of bound).
  if (SYNC_IO_HOT_PATH_PATTERN.test(flaggedCode.replace(SYNC_IO_QUOTED_RE, "''"))) {
    return {
      verdict: 'investigate',
      reason: 'Sync I/O inside a loop in request/socket hot-path scope',
    };
  }

  // Startup bounded-loop exemption: a loop bounded by a literal <= 10 (or a small hardcoded
  // array) inside a function DEFINED as startup/initialization code runs once at process start.
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

// ─── Idempotent registration of the built-in detectors ───
//
// Registers each rule only if it is not already present, so repeated calls are safe.
// Performs no registration at import time.

const BUILT_IN_GATES = [
  ['sequential-await-in-loop', gateSequentialAwaitInLoop],
  ['sequential await in loop', gateSequentialAwaitInLoop],
  ['sync-io-in-loop', gateSyncIoInLoop],
  ['sync io in loop', gateSyncIoInLoop],
];

function registerPreDispatchGates() {
  for (const [ruleId, detector] of BUILT_IN_GATES) {
    if (!preDispatchGateRegistry.has(ruleId)) {
      registerPreDispatchGate(ruleId, detector);
    }
  }
}

// ─── Consult with an audit record ───
//
// Runs the gate registered for ruleId against flaggedCode. Returns null when no gate is
// registered (caller falls through to the normal dispatch path). Otherwise returns the
// dismissal/route record for every verdict:
//   { verdict, ruleId, file, line, reason }
// location is { file, line }; both are null when the caller does not supply them.

function consultPreDispatchGate(ruleId, flaggedCode, location) {
  const detector = getPreDispatchGate(ruleId);
  if (!detector) return null;
  const result = detector(flaggedCode);
  const loc = location || {};
  return {
    verdict: result.verdict,
    ruleId,
    file: loc.file !== undefined ? loc.file : null,
    line: loc.line !== undefined ? loc.line : null,
    reason: result.reason,
  };
}

module.exports = {
  registerPreDispatchGates,
  registerPreDispatchGate,
  getPreDispatchGate,
  clearPreDispatchGateRegistry,
  consultPreDispatchGate,
  gateSequentialAwaitInLoop,
  gateSyncIoInLoop,
  SYNC_IO_BOUND_THRESHOLD,
};
