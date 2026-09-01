'use strict';

// Deterministic staleness recheck for scanner-originated findings (2026-08-23, Grimmethy:
// "How do we systematically solve this issue in the future. We need to harden the system
// so that we don't have to keep manually following up on these.") -- caught live: a
// staleness_audit task auditing an observability_review finding (silent-catch-block,
// src/task-sources.js:55) burned all 3 infra-requeue rounds on real, populated local-model
// timeouts (~225-240s every attempt, 14 attempts, ~2 hours) and permanently blocked,
// needing a human to manually re-derive the one thing staleness_audit exists to answer:
// "is the flagged code still there." That answer was a git-diff and a regex away the
// whole time -- the scanner that raised the finding already expresses each rule as a
// pure, deterministic (text, relPath) -> findings function. Re-running the SAME rule
// against the file's CURRENT content answers "is this still true" with certainty, in
// milliseconds, with zero chance of a model timeout ever blocking the audit.
//
// ADR-0022 Stage B: which rules are re-runnable, and how, is no longer hardcoded here.
// The source that owns a scanner registers its rechecks via
// deterministic-recheck-registry.js's registerDeterministicRecheck() (agent-manager-hygiene
// does this for observability_review / performance_review). This file stays a pure,
// core-side consumer -- it holds the file IO, the repoRoot path-safety check, and the
// report-text templates (all generic), and imports nothing from src/maintenance/. A source
// with no registered recheck -> deterministicRecheck returns null -> the existing
// harness-grounded local-model path (local-draft.js's own staleness_audit branch) runs,
// unchanged, exactly as it did before this file existed.
//
// Scope: only a staleness_audit task whose ORIGINAL finding carried a real
// {originalSource, originalRule[, originalFile]} in its promptContext (stamped at filing
// time -- see staleness-audit.js's buildStalenessAuditTask). Anything else returns null.
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
const { getDeterministicRecheck } = require('./deterministic-recheck-registry.js');

function toHits(findings) {
  return findings.map((f) => ({ file: f.file, line: f.line, query: 'deterministic-rescan', text: f.detail }));
}

function repoWideArchive(originalRule) {
  return {
    recommendation: 'archive',
    hits: [],
    reportText: [
      `1. The original concern no longer applies: re-running the original scanner rule ("${originalRule}", a repo-wide check) against this repo's CURRENT content finds nothing missing.`,
      '2. N/A -- not a fabrication-repeat case.',
      `3. RECOMMENDATION: archive -- deterministic recheck (re-ran the original scanner rule directly, not a model judgment call): "${originalRule}" no longer fires anywhere in this repo.`,
    ].join('\n'),
  };
}

function repoWideInvestigate(originalRule, findings) {
  return {
    recommendation: 'investigate',
    hits: toHits(findings),
    reportText: [
      `1. The original concern still holds: re-running the original scanner rule ("${originalRule}", a repo-wide check) against this repo's CURRENT content still finds it missing.`,
      '2. N/A -- not a fabrication-repeat case.',
      `3. RECOMMENDATION: worth a fresh investigation -- deterministic recheck (re-ran the original scanner rule directly, not a model judgment call): "${originalRule}" still fires in this repo.`,
    ].join('\n'),
  };
}

function fileGoneArchive() {
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

function perFileArchive(originalRule, originalFile) {
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

function perFileInvestigate(originalRule, originalFile, findings) {
  return {
    recommendation: 'investigate',
    hits: toHits(findings),
    reportText: [
      `1. The original concern still holds: re-running the original scanner rule ("${originalRule}") against ${originalFile}'s CURRENT content still finds it, at line ${findings[0].line} (${findings.map((f) => f.line).join(', ')} total match(es)).`,
      '2. N/A -- not a fabrication-repeat case.',
      `3. RECOMMENDATION: worth a fresh investigation -- deterministic recheck (re-ran the original scanner rule directly, not a model judgment call): "${originalRule}" still fires in ${originalFile}.`,
    ].join('\n'),
  };
}

// task = the staleness_audit task (NOT the original flagged task) -- reads the
// originalSource/originalRule/originalFile fields buildStalenessAuditTask stamps onto
// promptContext at filing time. Returns null (unsupported -- fall back to the LLM path)
// or { recommendation: 'archive'|'investigate', reportText, hits }.
function deterministicRecheck(task, repoRoot) {
  const ctx = (task && task.promptContext) || {};
  const { originalSource, originalRule, originalFile } = ctx;
  if (!repoRoot || !originalSource || !originalRule) return null;

  const config = getDeterministicRecheck(originalSource);
  if (!config) return null;

  const repoWideDetector = config.repoWideRules[originalRule];
  if (repoWideDetector) {
    const findings = repoWideDetector(repoRoot);
    return findings.length === 0 ? repoWideArchive(originalRule) : repoWideInvestigate(originalRule, findings);
  }

  if (!originalFile) return null;
  const detector = config.perFileRules[originalRule];
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
    if (e.code === 'ENOENT') return fileGoneArchive();
    console.warn('fastpath read failed (non-ENOENT):', e.code, e.errno, e.syscall, absPath);
    return null; // any other read failure (permissions, etc.) -- not confident enough to auto-resolve, fall back to the LLM path
  }

  const findings = detector(text, originalFile);
  return findings.length === 0
    ? perFileArchive(originalRule, originalFile)
    : perFileInvestigate(originalRule, originalFile, findings);
}

module.exports = { deterministicRecheck };
