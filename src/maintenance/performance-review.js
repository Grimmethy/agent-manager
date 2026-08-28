'use strict';

// performance_review / performance_fix -- moved into src/maintenance/ 2026-08-23
// (Grimmethy: "Move the observability/performance scanners into src/maintenance/ next"),
// exact structural mirror of observability-review.js's own move -- same lastScannedAt/
// rescan-interval/dedupe/prune shape, same reasoning throughout, swapped to
// performance-scan.js's scanner and its own coverage/flags files so the two sources
// never contend over the same state.
//
// Brain Dump #94 (2026-08-18): "our pretty little cpu is getting overloaded... we need to
// develop a performance review job for projects anyways". REDIRECTED 2026-08-20 (same
// treatment observability_review got): real numbers showed the identical pattern -- 355
// done tasks, 297 (84%) false positive, 56 (16%) genuine, scanning deep_dive's cloned
// EXTERNAL repos with no follow-up mechanism, zero fixes ever shipped.

const fs = require('fs');
const path = require('path');
const { scanProject } = require('./performance-scan.js');
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

function assemblePrompt(stableLines, volatileLines) {
  return [...stableLines, '', ...volatileLines].join('\n');
}

// --- Prompts: review stage (judge genuine vs. false positive, write a candidate) -------

function performanceReviewPlanPrompt(task) {
  const ctx = task.promptContext;
  const stable = [
    'This is a judgment call, NOT a code-change task (yet). A deterministic scanner flagged a possible performance issue in a project this pipeline is reviewing (rule/project/file/snippet given below). Determine whether it is a GENUINE issue or a false positive.',
    'Write a numbered PLAN that is actually a REASONED VERDICT:',
    '- "genuine issue — here\'s the concrete performance cost (e.g. blocking I/O per loop iteration, needless sequential network calls) and a proposed fix"',
    '- "false positive — here\'s why (e.g. the loop only ever runs a handful of times, the sequence is deliberately rate-limited/ordered, the sync call runs once at startup not in a hot path)"',
    '- "uncertain — here\'s what would need to be checked that isn\'t given here (e.g. real call frequency, profiling data)"',
    'Do not assume the scanner is right just because it flagged something -- it is a heuristic, not a profiler, and false positives are expected.',
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

function performanceReviewImplementPrompt(task, planText) {
  return [
    'Your plan above is the final REASONED VERDICT for this performance finding in OUR OWN project.',
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
    'A paragraph describing the concrete performance cost, grounded in the snippet you were given.',
    '',
    'Solution:',
    'A paragraph describing the specific fix (e.g. batch the I/O, parallelize, cache the result) -- scoped to exactly this finding, nothing broader.',
    '',
    'Benefits:',
    'A paragraph describing what improves once fixed.',
    '',
    '(Pick an AC-NNN number that looks reasonable; the harness re-derives the real one deterministically regardless of what you write here.)',
  ].join('\n');
}

// --- Prompts: fix stage (candidate already vetted -- implement the real diff) ----------

function performanceFixPlanPrompt(task) {
  const ctx = task.promptContext;
  return [
    'You are drafting a plan for a narrow performance fix to this project.',
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

function performanceFixImplementPrompt(task, planText) {
  const ctx = task.promptContext;
  const fetched = ctx.fetchedFiles || [];
  const namedButMissing = (ctx.files || []).filter((f) => !fetched.some((ff) => ff.path === f));
  const { formatFileContents, groupBJsonInstructions, candidateSplitInstructions } = require('../prompts.js');
  return [
    'Earlier you wrote this PLAN for a narrow performance fix:',
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

// --- Task source: performance_review (scans + judges + writes a candidate) -------------

function nextPerformanceReviewTask({ repoRoot, pipelineDir, defaultDomain, taskIdExistsInQueue, coveragePath }) {
  const projectTag = path.basename(repoRoot);

  let coverage;
  try { coverage = JSON.parse(readIfExists(coveragePath) || '{}'); } catch { coverage = {}; }

  const flagsPath = path.join(pipelineDir, 'queue', 'performance-flags.json');
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
      console.error(`performance_review: failed to scan "${projectTag}": ${e.message}`);
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
    const taskId = `performance-${slugifyForId(projectTag)}-${slugifyForId(finding.rule)}-${slugifyForId(finding.file || 'repo')}-${finding.line || 0}`;
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
      source: 'performance_review',
      title: `Performance triage: ${finding.rule} — ${projectTag}${finding.file ? ` (${finding.file}:${finding.line})` : ''}`,
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
  registerTaskSource('performance_review', {
    priority: taskPriority('performance_review', 80),
    next: () => {
      const { repoRoot, pipelineDir, defaultDomain, performanceCoveragePath } = getConfig();
      return nextPerformanceReviewTask({ repoRoot, pipelineDir, defaultDomain, taskIdExistsInQueue, coveragePath: performanceCoveragePath });
    },
    apply: ({ implementResponse, task }) => {
      const { performanceFixCandidatesPath } = getConfig();
      // See apply-group-a.js's applyArchDiscoveryCandidates for why this real,
      // review-time-fresh snippet is threaded through deterministically.
      return applyArchDiscoveryCandidates({
        implementResponse,
        candidatesPath: performanceFixCandidatesPath,
        docTitle: '# Performance Fix Candidates',
        snippet: task && task.promptContext && task.promptContext.snippet,
      });
    },
    advisoryProse: true,
  });
  updateTaskSource('performance_review', { buildPlanPrompt: performanceReviewPlanPrompt, buildImplementPrompt: performanceReviewImplementPrompt });

  registerTaskSource('performance_fix', {
    priority: taskPriority('performance_fix', 73),
    next: () => {
      const { performanceFixCandidatesPath } = getConfig();
      return nextCandidateFulfillmentTask(performanceFixCandidatesPath, 'performance_fix');
    },
    emptyApproval: true, candidateFulfillment: true,
    candidatesPath: () => getConfig().performanceFixCandidatesPath,
    candidateDocTitle: '# Performance Fix Candidates',
  });
  updateTaskSource('performance_fix', { buildPlanPrompt: performanceFixPlanPrompt, buildImplementPrompt: performanceFixImplementPrompt });
}

module.exports = {
  register,
  nextPerformanceReviewTask,
  performanceReviewPlanPrompt,
  performanceReviewImplementPrompt,
  performanceFixPlanPrompt,
  performanceFixImplementPrompt,
};
