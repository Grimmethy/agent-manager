'use strict';

// staleness-audit-signals.js -- extracted from src/staleness-audit.js ([[hub-task-integration]] node-module decompose).

const path = require('path');
const { execFileSync } = require('child_process');
const { REASON_CATEGORIES } = require('./pipeline-self-audit.js');
const { extractFilePaths, resolveAgainstRepo } = require('./fact-checker.js');
const { normalizeTokens, jaccardSimilarity: jaccard, STOPWORDS: DUP_STOPWORDS, distinctivePhrases: sharedDistinctivePhrases } = require('./text-similarity.js');

function isStaleByAge(task, now, thresholdMs = stalenessThresholdMs()) {
  const last = lastActivityTs(task);
  if (last == null) return false; // no timestamp at all -- can't confidently call this stale, not a guess this module makes
  return now - last > thresholdMs;
}

function isFabricationRepeat(task) {
  if (!((task.localRejectCount || 0) >= 2)) return false;
  const feedback = Array.isArray(task.priorRejectionFeedback)
    ? task.priorRejectionFeedback.join(' ')
    : (task.priorRejectionFeedback || '');
  const text = `${task.blockedReason || ''} ${feedback}`.toLowerCase();
  return FABRICATION_KEYWORDS.some((kw) => text.includes(kw));
}

function hasExhaustedRetries(task) {
  const hist = Array.isArray(task.history) ? task.history : [];
  return hist.some((h) => h.stage === 'exhausted');
}

function alreadyImplementedSignal(repoRoot, task) {
  if (!repoRoot) return { strong: false, strongEvidence: [], phraseHits: [] };
  const strongEvidence = [];
  const ctx = task.promptContext || {};
  const text = [ctx.rawText, task.title].filter(Boolean).join('\n');

  for (const sym of extractCreatedSymbols(text)) {
    if (/[./]/.test(sym)) {
      const resolved = resolveAgainstRepo(repoRoot, sym);
      if (resolved) strongEvidence.push(`asks to create \`${sym}\` -- but ${path.relative(repoRoot, resolved)} already exists`);
    } else {
      const where = symbolDefinedInRepo(repoRoot, sym);
      if (where) strongEvidence.push(`asks to add \`${sym}\` -- but it is already defined in ${where}`);
    }
  }

  const phraseHits = [];
  const namedFiles = candidateFilePaths(task)
    .map((p) => resolveAgainstRepo(repoRoot, p)).filter(Boolean)
    .map((abs) => path.relative(repoRoot, abs));
  if (namedFiles.length > 0 && namedFiles.length <= 12) {
    for (const phrase of distinctivePhrases(task)) {
      try {
        const line = execFileSync(
          'git', ['grep', '-n', '-F', '-i', '--', phrase, ...namedFiles],
          { cwd: repoRoot, encoding: 'utf8', timeout: GIT_LOG_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] },
        ).split('\n').map((x) => x.trim()).filter(Boolean)[0];
        // Skip a line that is itself just quoting the brain-dump / this task.
        if (line && !/brain[- ]?dump|see task|the task's|rawText/i.test(line)) {
          phraseHits.push(`grep for the task's phrase "${phrase}" -> ${line.slice(0, 160)}`);
        }
      } catch (e) { /* git grep exit 1 = no match */ }
    }
  }

  return { strong: strongEvidence.length > 0, strongEvidence, phraseHits };
}

function invalidPremiseSignal(repoRoot, task) {
  if (!repoRoot) return { hit: false, evidence: [] };
  const ownCreateTarget = task.promptContext && task.promptContext.newFile;
  const named = candidateFilePaths(task).filter((p) => p !== ownCreateTarget);
  if (named.length === 0) return { hit: false, evidence: [] };
  const missing = named.filter((p) => !resolveAgainstRepo(repoRoot, p));
  if (missing.length !== named.length) return { hit: false, evidence: [] };
  return { hit: true, evidence: [`every file this task names is absent from the repo: ${missing.join(', ')}`] };
}

function isDecomposeLoop(task) {
  const attempts = Array.isArray(task.draftAttempts) ? task.draftAttempts : [];
  if (attempts.length < 2) return false;
  const allDecompose = attempts.every((a) => {
    const r = `${a.adhocResolution || ''} ${a.resolution || ''} ${(a.outcome && a.outcome.resolution) || ''}`.toLowerCase();
    return r.includes('decompose');
  });
  return allDecompose && hasExhaustedRetries(task);
}

module.exports = { isStaleByAge, isFabricationRepeat, hasExhaustedRetries, alreadyImplementedSignal, invalidPremiseSignal, isDecomposeLoop };
