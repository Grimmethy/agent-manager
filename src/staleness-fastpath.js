'use strict';

// Deterministic staleness recheck for scanner-originated findings (2026-08-23, Grimmethy:
// "How do we systematically solve this issue in the future. We need to harden the system
// so that we don't have to keep manually following up on these.") -- caught live: a
// staleness_audit task auditing an observability_review finding (silent-catch-block,
// src/task-sources.js:55) burned all 3 infra-requeue rounds on real, populated local-model
// timeouts (~225-240s every attempt, 14 attempts, ~2 hours) and permanently blocked,
// needing a human to manually re-derive the one thing staleness_audit exists to answer:
// "is the flagged code still there." That answer was a git-diff and a regex away the
// whole time -- observability_review/performance_review's OWN scanners
// (src/maintenance/*-scan.js) already express each rule as a pure, deterministic
// (text, relPath) -> findings function. Re-running the SAME rule against the file's
// CURRENT content answers "is this still true" with certainty, in milliseconds, with zero
// chance of a model timeout ever blocking the audit.
//
// Scope: only observability_review/performance_review findings with a real
// {rule, file} the ORIGINAL task's own promptContext named (stamped onto the
// staleness_audit task at filing time -- see staleness-audit.js's buildStalenessAuditTask).
// Anything else (adhoc, project_search, arch_review, function_length_review's non-
// line-based shape, or a rule this file doesn't recognize) returns null -- the existing
// harness-grounded local-model path (local-draft.js's own staleness_audit branch) is the
// right tool for a claim a regex can't re-derive, unchanged.
//
// Deliberately conservative in the safe direction: "the rule still fires SOMEWHERE in the
// file" (not an exact line match, which line-drift from unrelated edits would break)
// counts as still-live even if the exact line moved. Only "the rule fires nowhere in the
// file at all, and the file still exists" counts as resolved. A false "still-live" costs
// nothing beyond falling back to the same LLM path that ran before this file existed; a
// false "resolved" is the risky direction, so it demands the rule provably not firing
// anywhere in the file, not just near the original line.

const fs = require('fs');
const path = require('path');

function silentCatchBlocks(text, relPath) {
  return require('./maintenance/observability-scan.js').findSilentCatchBlocks(text, relPath);
}
function unguardedLoops(text, relPath) {
  return require('./maintenance/observability-scan.js').findUnguardedLoops(text, relPath);
}
function otelNaming(text, relPath) {
  return require('./maintenance/observability-scan.js').findOtelNamingViolations(text, relPath);
}
function syncIoInLoop(text, relPath) {
  return require('./maintenance/performance-scan.js').findLoopBodyIssues(text, relPath).filter((f) => f.rule === 'sync-io-in-loop');
}
function sequentialAwaitInLoop(text, relPath) {
  return require('./maintenance/performance-scan.js').findLoopBodyIssues(text, relPath).filter((f) => f.rule === 'sequential-await-in-loop');
}
function jsonDeepClone(text, relPath) {
  return require('./maintenance/performance-scan.js').findJsonDeepCloneAntipattern(text, relPath);
}

// Repo-wide rules (observability_review's missing-reserved-attribute) and
// function_length_review's length-not-pattern shape are deliberately absent here -- a
// single-file (text, relPath) recheck isn't the right shape for either; they fall back
// to the LLM path same as any other unsupported rule.
const RULE_DETECTORS = {
  'silent-catch-block': silentCatchBlocks,
  'unguarded-long-running-loop': unguardedLoops,
  'otel-naming-convention': otelNaming,
  'sync-io-in-loop': syncIoInLoop,
  'sequential-await-in-loop': sequentialAwaitInLoop,
  'json-deep-clone-antipattern': jsonDeepClone,
};

const SUPPORTED_SOURCES = new Set(['observability_review', 'performance_review']);

// task = the staleness_audit task (NOT the original flagged task) -- reads the
// originalSource/originalRule/originalFile fields buildStalenessAuditTask stamps onto
// promptContext at filing time. Returns null (unsupported -- fall back to the LLM path)
// or { recommendation: 'archive'|'investigate', reportText, hits }.
function deterministicRecheck(task, repoRoot) {
  const ctx = (task && task.promptContext) || {};
  const { originalSource, originalRule, originalFile } = ctx;
  if (!repoRoot || !originalSource || !originalRule || !originalFile) return null;
  if (!SUPPORTED_SOURCES.has(originalSource)) return null;
  const detector = RULE_DETECTORS[originalRule];
  if (!detector) return null;

  const absPath = path.resolve(repoRoot, originalFile);
  // resolve() must stay inside repoRoot -- originalFile came from a task filed against
  // THIS repo's own scanner, but never trust a path string enough to read outside the
  // tree it claims to be relative to.
  if (!absPath.startsWith(path.resolve(repoRoot) + path.sep)) return null;

  let text;
  try {
    text = fs.readFileSync(absPath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      return {
        recommendation: 'archive',
        hits: [],
        reportText: [
          '1. The original concern no longer applies: the file it named no longer exists in this repo (deleted or moved since the finding was filed).',
          '2. N/A -- not a fabrication-repeat case.',
          '3. RECOMMENDATION: archive -- deterministic recheck (re-ran the original scanner rule directly, not a model judgment call): the file no longer exists.',
        ].join('\n'),
      };
    }
    return null; // any other read failure (permissions, etc.) -- not confident enough to auto-resolve, fall back to the LLM path
  }

  const findings = detector(text, originalFile);
  if (findings.length === 0) {
    return {
      recommendation: 'archive',
      hits: [],
      reportText: [
        `1. The original concern no longer applies: re-running the original scanner rule ("${originalRule}") against ${originalFile}'s CURRENT content finds no match anywhere in the file -- the flagged pattern is provably gone, not just moved.`,
        '2. N/A -- not a fabrication-repeat case.',
        `3. RECOMMENDATION: archive -- deterministic recheck (re-ran the original scanner rule directly, not a model judgment call): "${originalRule}" no longer fires anywhere in ${originalFile}.`,
      ].join('\n'),
    };
  }

  const hits = findings.map((f) => ({ file: f.file, line: f.line, query: 'deterministic-rescan', text: f.detail }));
  return {
    recommendation: 'investigate',
    hits,
    reportText: [
      `1. The original concern still holds: re-running the original scanner rule ("${originalRule}") against ${originalFile}'s CURRENT content still finds it, at line ${findings[0].line} (${findings.map((f) => f.line).join(', ')} total match(es)).`,
      '2. N/A -- not a fabrication-repeat case.',
      `3. RECOMMENDATION: worth a fresh investigation -- deterministic recheck (re-ran the original scanner rule directly, not a model judgment call): "${originalRule}" still fires in ${originalFile}.`,
    ].join('\n'),
  };
}

module.exports = { deterministicRecheck, RULE_DETECTORS, SUPPORTED_SOURCES };
