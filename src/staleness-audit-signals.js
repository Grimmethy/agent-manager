'use strict';

// staleness-audit-signals.js -- extracted from src/staleness-audit.js ([[hub-task-integration]] node-module decompose).

const path = require('path');
const { execFileSync } = require('child_process');
const { REASON_CATEGORIES } = require('./pipeline-self-audit.js');
const { extractFilePaths, resolveAgainstRepo } = require('./fact-checker.js');
const { normalizeTokens, jaccardSimilarity: jaccard, STOPWORDS: DUP_STOPWORDS, distinctivePhrases: sharedDistinctivePhrases } = require('./text-similarity.js');

const DEFAULT_STALENESS_THRESHOLD_DAYS = 7;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const FABRICATION_KEYWORDS = REASON_CATEGORIES.find((c) => c.key === 'fabricated-ungrounded-claim').keywords;

const NON_PROGRESS_STAGES = new Set(['exhausted']);

const GIT_LOG_TIMEOUT_MS = 15_000;

const GENERATED_DOC_RE = /(_CANDIDATES\.md$|PRODUCT_SPEC(_OUTLINE)?\.md$|TROUBLE_LOG\.md$|BACKLOG_CANDIDATES\.md$)/;

const CREATE_VERB_RE = /\b(create|add|introduce|implement|build|write|new)\b[^.\n]{0,60}?`([A-Za-z0-9_./-]{3,})`/gi;

const TITLE_PREFIX_RE = /^[^:>]*[>:]\s*/;

function envDays(name, fallback) {
  const raw = process.env[name];
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback;
}

function stalenessThresholdMs() {
  return envDays('AGENT_MANAGER_STALENESS_THRESHOLD_DAYS', DEFAULT_STALENESS_THRESHOLD_DAYS) * MS_PER_DAY;
}

function lastActivityTs(task) {
  const hist = Array.isArray(task.history) ? task.history : [];
  const timestamps = hist
    .filter((h) => !NON_PROGRESS_STAGES.has(h.stage))
    .map((h) => Date.parse(h.at))
    .filter((t) => Number.isFinite(t));
  if (timestamps.length > 0) return Math.max(...timestamps);
  const created = Date.parse(task.createdAt);
  return Number.isFinite(created) ? created : null;
}

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

function candidateFilePaths(task) {
  const ctx = task.promptContext || {};
  const feedback = Array.isArray(task.priorRejectionFeedback)
    ? task.priorRejectionFeedback.join(' ')
    : (task.priorRejectionFeedback || '');
  const text = [ctx.rawText, task.title, task.blockedReason, feedback].filter(Boolean).join('\n');
  return extractFilePaths(text).filter((p) => !GENERATED_DOC_RE.test(p));
}

function extractCreatedSymbols(text) {
  const out = new Set();
  const s = String(text || '');
  let m;
  CREATE_VERB_RE.lastIndex = 0;
  while ((m = CREATE_VERB_RE.exec(s))) {
    const tok = m[2];
    if (/[./]/.test(tok)) out.add(tok);           // a path
    else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(tok)) out.add(tok); // an identifier
  }
  return [...out];
}

function symbolDefinedInRepo(repoRoot, symbol) {
  if (!repoRoot || !symbol) return null;
  // A DEFINITION, not any mention -- function/const/let/class/def, JS or Python.
  const pattern = `(function|class|const|let|var|def)\\s+${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`;
  try {
    const out = execFileSync(
      'git', ['grep', '-l', '-E', pattern, '--', 'src', 'python', 'scripts'],
      { cwd: repoRoot, encoding: 'utf8', timeout: GIT_LOG_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const first = out.split('\n').map((x) => x.trim()).filter(Boolean)[0];
    return first || null;
  } catch (e) {
    return null; // git grep exits 1 on no match -> not defined
  }
}

function distinctivePhrases(task) {
  const line = String((task.promptContext && task.promptContext.rawText) || task.title || '')
    .split('\n')[0].replace(TITLE_PREFIX_RE, '');
  return sharedDistinctivePhrases(line);
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

module.exports = { isStaleByAge, isFabricationRepeat, hasExhaustedRetries, alreadyImplementedSignal, invalidPremiseSignal, isDecomposeLoop, candidateFilePaths, distinctivePhrases, extractCreatedSymbols, lastActivityTs, stalenessThresholdMs, symbolDefinedInRepo, envDays, FABRICATION_KEYWORDS, GIT_LOG_TIMEOUT_MS, CREATE_VERB_RE, DEFAULT_STALENESS_THRESHOLD_DAYS, GENERATED_DOC_RE, MS_PER_DAY, NON_PROGRESS_STAGES, TITLE_PREFIX_RE };
