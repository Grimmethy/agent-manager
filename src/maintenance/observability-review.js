'use strict';

// observability_review / observability_fix -- moved into src/maintenance/ 2026-08-23
// (Grimmethy: "Move the observability/performance scanners into src/maintenance/ next"),
// alongside function_length_review/function_length_fix's own move, following the exact
// same self-contained, registry-flag-based pattern (see that file's own header for the
// full design and the extraction this is meant to make cheap later).
//
// REDIRECTED 2026-08-20 (Grimmethy: "What tangible benefits are we getting from the huge
// number of observability review tasks?" -> real numbers showed 2,025 real Ollama calls /
// ~5.6h wall-clock over 5 days scanning deep_dive's cloned EXTERNAL repos, 313 "genuine"
// verdicts, ZERO fixes ever shipped -- there was no follow-up mechanism at all, and even
// a fix would have landed in someone else's unmaintained clone, not this project. "Make
// sure it's fixing our project": now scans repoRoot directly, and a genuine verdict
// becomes a real candidate consumed by observability_fix into an actual code fix.
//
// Unlike a frozen external clone (scan once, coverage done forever), repoRoot changes
// constantly as real commits land, so this tracks a single lastScannedAt and re-scans
// every RESCAN_INTERVAL_MS instead. Findings accumulate in a flags file and are handed to
// the model one at a time, oldest first -- each rescan dedupes against what's already
// flagged (else the SAME unfixed line would get re-flagged every single rescan) and
// prunes any flag whose file no longer exists (deleted/renamed since it was flagged).

const fs = require('fs');
const path = require('path');
const { scanProject } = require('./observability-scan.js');
const { isLikelyMinified } = require('./scan-utils.js');
const { registerTaskSource, updateTaskSource } = require('../task-source-registry.js');
const { applyArchDiscoveryCandidates } = require('../apply-group-a.js');

const RESCAN_INTERVAL_MS = 24 * 60 * 60 * 1000;

function slugifyForId(str) {
  return str.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '').replace(/[^a-z0-9]+/g, '-');
}

function readIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

// Prefix-sharing convention (see prompts.js's own assemblePrompt): stable, cacheable
// instructions first, then the '' separator, then per-call volatile content -- so a
// caching-aware backend (Ollama's KV-cache) can reuse the shared prefix's computation
// across repeated calls of the same task type instead of reprocessing it every time.
function assemblePrompt(stableLines, volatileLines) {
  return [...stableLines, '', ...volatileLines].join('\n');
}

// --- Prompts: review stage (judge genuine vs. false positive, write a candidate) -------

function observabilityReviewPlanPrompt(task) {
  const ctx = task.promptContext;
  const stable = [
    'This is a judgment call, NOT a code-change task (yet). A deterministic scanner flagged a possible observability-hygiene issue in a project this pipeline is reviewing (rule/project/file/snippet given below). Determine whether it is a GENUINE issue or a false positive.',
    'Write a numbered PLAN that is actually a REASONED VERDICT:',
    '- "genuine issue — here\'s the concrete risk (e.g. a real background-task error swallowed silently) and a proposed fix"',
    '- "false positive — here\'s why (e.g. the catch intentionally no-ops for a known-safe case, or the loop\'s health signal is emitted elsewhere the scanner\'s window missed)"',
    '- "uncertain — here\'s what would need to be checked that isn\'t given here"',
    'Do not assume the scanner is right just because it flagged something -- it is a heuristic, not a parser, and false positives are expected.',
  ];
  const volatile = [
    `Rule flagged: ${ctx.rule}`,
    `Project: ${ctx.projectSlug}`,
    ctx.file ? `File: ${ctx.file}:${ctx.line}` : '(repo-wide finding, not tied to one file)',
    `Scanner detail: ${ctx.detail}`,
    '',
    'SURROUNDING SOURCE (if available):',
    ctx.snippet || '(no snippet available for this finding)',
  ];
  return assemblePrompt(stable, volatile);
}

function observabilityReviewImplementPrompt(task, planText) {
  return [
    'Your plan above is the final REASONED VERDICT for this observability-hygiene finding in OUR OWN project.',
    '',
    planText,
    '',
    'If the verdict is FALSE POSITIVE or UNCERTAIN: write ONE short paragraph (2-4 sentences) recording why, for a human to read later. Plain prose only -- no JSON, no code fence, no "steps", no candidate block.',
    '',
    'If the verdict is GENUINE: write ONE fix candidate for it, in EXACTLY this format (must match this parser exactly or it cannot be consumed downstream):',
    '',
    '### AC-NNN · Title',
    'Strength: Strong',
    `Files: ${task.promptContext.file || '(the file from the finding above)'}`,
    '',
    'Problem:',
    'A paragraph describing the concrete observability gap, grounded in the snippet you were given.',
    '',
    'Solution:',
    'A paragraph describing the specific fix (e.g. what to log, what to rethrow, what health signal to add) -- scoped to exactly this finding, nothing broader.',
    '',
    'Benefits:',
    'A paragraph describing what improves once fixed.',
    '',
    '(Pick an AC-NNN number that looks reasonable; the harness re-derives the real one deterministically regardless of what you write here.)',
  ].join('\n');
}

// --- Prompts: fix stage (candidate already vetted -- implement the real diff) ----------
// Same shape arch_review's own fix-stage prompt uses (prompts.js's archReviewPlanPrompt/
// archReviewImplementPrompt, which stayed in core since arch_review isn't moving) --
// duplicated narrowly rather than reached for across the module boundary, same choice
// function-length-review.js already made for its own fix stage.

function observabilityFixPlanPrompt(task) {
  const ctx = task.promptContext;
  return [
    'You are drafting a plan for a narrow observability-hygiene fix to this project.',
    '',
    `CANDIDATE: ${ctx.candidateId} -- ${ctx.title}`,
    '',
    'Full candidate write-up (Problem / Solution / Benefits, already vetted -- do not second-guess ' +
      'whether this is worth doing, only how to do it safely):',
    ctx.body,
    '',
    `Files involved: ${ctx.files.join(', ') || '(not specified -- infer from the write-up)'}`,
    '',
    'Write a numbered PLAN (no code) for EXACTLY this fix and nothing broader -- do not expand ' +
      'scope to adjacent cleanup even if you notice something else that looks wrong nearby. State ' +
      'assumptions explicitly; say UNKNOWN rather than inventing facts not given above.',
  ].join('\n');
}

function observabilityFixImplementPrompt(task, planText) {
  const ctx = task.promptContext;
  const fetched = ctx.fetchedFiles || [];
  const namedButMissing = (ctx.files || []).filter((f) => !fetched.some((ff) => ff.path === f));
  const { formatFileContents, groupBJsonInstructions, candidateSplitInstructions } = require('../prompts.js');
  return [
    'Earlier you wrote this PLAN for a narrow observability-hygiene fix:',
    '',
    planText,
    '',
    `The corrected plan is for: ${ctx.candidateId} -- ${ctx.title}.`,
    '',
    fetched.length > 0
      ? `Real, current content of the file(s) this candidate named (this is the ONLY source of truth for what the file actually contains right now -- the plan/candidate write-up above may be stale or approximate; this is not):\n\n${formatFileContents(fetched)}`
      : '(none of the file(s) this candidate named could be read -- see the note below before assuming why.)',
    '',
    namedButMissing.length > 0
      ? `NOTE: ${namedButMissing.join(', ')} named by this candidate could not be read (does not exist at that path, or is outside the repo). If your plan calls for creating this file, use mode "create". If your plan assumed this file already exists and you cannot proceed without seeing its real content, output the empty string instead of guessing at content you were never shown.`
      : '',
    '',
    'Ground every "find" value in the real file content shown above, character for character -- never in your own memory of the plan or candidate write-up.',
    '',
    candidateSplitInstructions,
    '',
    groupBJsonInstructions,
  ].join('\n');
}

// --- Task source: observability_review (scans + judges + writes a candidate) -----------

function nextObservabilityReviewTask({ repoRoot, pipelineDir, defaultDomain, taskIdExistsInQueue, coveragePath }) {
  const projectTag = path.basename(repoRoot);

  let coverage;
  try { coverage = JSON.parse(readIfExists(coveragePath) || '{}'); } catch { coverage = {}; }

  const flagsPath = path.join(pipelineDir, 'queue', 'observability-flags.json');
  let flags;
  try { flags = JSON.parse(readIfExists(flagsPath) || '[]'); } catch { flags = []; }

  const now = Date.now();
  const lastScannedAt = coverage.lastScannedAt ? Date.parse(coverage.lastScannedAt) : NaN;
  const due = Number.isNaN(lastScannedAt) || (now - lastScannedAt) >= RESCAN_INTERVAL_MS;

  let flagsChanged = false;
  if (due && fs.existsSync(repoRoot)) {
    let freshFindings = [];
    try {
      freshFindings = scanProject(repoRoot, projectTag);
    } catch (e) {
      console.error(`observability_review: failed to scan "${projectTag}": ${e.message}`);
    }

    const beforePrune = flags.length;
    flags = flags.filter((f) => f.projectSlug === projectTag && (!f.file || fs.existsSync(path.join(repoRoot, f.file))));
    if (flags.length !== beforePrune) flagsChanged = true;

    const existingKeys = new Set(flags.map((f) => `${f.rule}::${f.file}::${f.line}`));
    for (const finding of freshFindings) {
      const key = `${finding.rule}::${finding.file}::${finding.line}`;
      if (existingKeys.has(key)) continue;
      flags.push(finding);
      existingKeys.add(key);
      flagsChanged = true;
    }

    coverage = { lastScannedAt: new Date(now).toISOString() };
    fs.mkdirSync(path.dirname(coveragePath), { recursive: true });
    fs.writeFileSync(coveragePath, JSON.stringify(coverage, null, 2));
  }
  if (flagsChanged) {
    fs.mkdirSync(path.dirname(flagsPath), { recursive: true });
    fs.writeFileSync(flagsPath, JSON.stringify(flags, null, 2));
  }

  const sorted = [...flags].sort((a, b) => new Date(a.scannedAt) - new Date(b.scannedAt));
  for (const finding of sorted) {
    const taskId = `observability-${slugifyForId(projectTag)}-${slugifyForId(finding.rule)}-${slugifyForId(finding.file || 'repo')}-${finding.line || 0}`;
    if (taskIdExistsInQueue(taskId)) continue;

    let snippet = null;
    if (finding.file) {
      const content = readIfExists(path.join(repoRoot, finding.file));
      if (content && isLikelyMinified(content)) continue;
      if (!content) continue;
      const lines = content.split('\n');
      const start = Math.max(0, (finding.line || 1) - 4);
      const end = Math.min(lines.length, (finding.line || 1) + 3);
      snippet = lines.slice(start, end).join('\n');
    }

    return {
      id: taskId,
      domain: defaultDomain,
      source: 'observability_review',
      title: `Observability triage: ${finding.rule} — ${projectTag}${finding.file ? ` (${finding.file}:${finding.line})` : ''}`,
      promptContext: {
        rule: finding.rule,
        detail: finding.detail,
        file: finding.file,
        line: finding.line,
        projectSlug: projectTag,
        snippet,
      },
    };
  }

  return null;
}

function register({ getConfig, nextCandidateFulfillmentTask, taskIdExistsInQueue, taskPriority }) {
  registerTaskSource('observability_review', {
    priority: taskPriority('observability_review', 80),
    next: () => {
      const { repoRoot, pipelineDir, defaultDomain, observabilityCoveragePath } = getConfig();
      return nextObservabilityReviewTask({ repoRoot, pipelineDir, defaultDomain, taskIdExistsInQueue, coveragePath: observabilityCoveragePath });
    },
    apply: ({ implementResponse, task }) => {
      const { observabilityFixCandidatesPath } = getConfig();
      // task.promptContext.snippet is the real, review-time-fresh code text this
      // finding is about (see nextObservabilityReviewTask below) -- passed through
      // deterministically so it survives into the candidate doc as data, not just
      // however faithfully the model's own prose happened to paraphrase it.
      return applyArchDiscoveryCandidates({
        implementResponse,
        candidatesPath: observabilityFixCandidatesPath,
        docTitle: '# Observability Fix Candidates',
        snippet: task && task.promptContext && task.promptContext.snippet,
      });
    },
    advisoryProse: true,
  });
  updateTaskSource('observability_review', { buildPlanPrompt: observabilityReviewPlanPrompt, buildImplementPrompt: observabilityReviewImplementPrompt });

  registerTaskSource('observability_fix', {
    priority: taskPriority('observability_fix', 72),
    next: () => {
      const { observabilityFixCandidatesPath } = getConfig();
      return nextCandidateFulfillmentTask(observabilityFixCandidatesPath, 'observability_fix');
    },
    emptyApproval: true, candidateFulfillment: true,
    candidatesPath: () => getConfig().observabilityFixCandidatesPath,
    candidateDocTitle: '# Observability Fix Candidates',
  });
  updateTaskSource('observability_fix', { buildPlanPrompt: observabilityFixPlanPrompt, buildImplementPrompt: observabilityFixImplementPrompt });
}

module.exports = {
  register,
  nextObservabilityReviewTask,
  observabilityReviewPlanPrompt,
  observabilityReviewImplementPrompt,
  observabilityFixPlanPrompt,
  observabilityFixImplementPrompt,
};
