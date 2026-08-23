'use strict';

// function_length_review / function_length_fix -- first member of the "maintenance"
// task-source family (2026-08-23, Grimmethy: "Let's start with the modular approach with
// the intent to further separate it into a fully separate npm later"). Same two-stage
// shape observability_review/observability_fix already proved out: a deterministic
// scanner (function-length-scan.js) flags candidates, this review stage judges genuine
// vs. false positive and writes a vetted candidate, and a generic consumer
// (task-sources.js's own nextCandidateFulfillmentTask, reused as-is) turns a vetted
// candidate into a real decomposition diff.
//
// Kept self-contained on purpose, for the stated eventual extraction: everything specific
// to function-length maintenance lives in this one file plus function-length-scan.js.
// The only cross-package dependencies are the small set of already-PUBLIC extension
// points every task source uses (task-source-registry.js's registerTaskSource/
// updateTaskSource, task-sources.js's nextCandidateFulfillmentTask/taskIdExistsInQueue,
// apply-group-a.js's applyArchDiscoveryCandidates, prompts.js's groupBJsonInstructions/
// formatFileContents) -- never another module's private internals. slugifyForId/
// readIfExists are tiny (task-sources.js keeps them unexported too) and duplicated here
// rather than reached for, for the same reason.

const fs = require('fs');
const path = require('path');
const { scanProject } = require('./function-length-scan.js');
const { registerTaskSource, updateTaskSource } = require('../task-source-registry.js');
const { applyArchDiscoveryCandidates } = require('../apply-group-a.js');
const { groupBJsonInstructions, formatFileContents } = require('../prompts.js');

const RESCAN_INTERVAL_MS = 24 * 60 * 60 * 1000; // same cadence observability_review/performance_review settled on

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

function functionLengthReviewPlanPrompt(task) {
  const ctx = task.promptContext;
  const stable = [
    'This is a judgment call, NOT a code-change task (yet). A deterministic scanner flagged a function as long in a project this pipeline is reviewing (file/line/length given below). Determine whether decomposing it is a GENUINE improvement or a false positive.',
    'Write a numbered PLAN that is actually a REASONED VERDICT:',
    '- "genuine — here\'s why this length is a real maintainability problem (e.g. it mixes several unrelated responsibilities that could each be a named, independently-testable function) and a rough decomposition sketch"',
    '- "false positive — here\'s why the length itself is not a real problem (e.g. a long but linear, single-purpose sequence like a big switch/case, a config object literal, or a prompt-builder that is just long strings with no real branching complexity)"',
    '- "uncertain — here\'s what would need to be checked that isn\'t given here"',
    'A function being long is not automatically a problem -- the scanner only counts lines, it has no sense of whether the length reflects real complexity. Do not assume the scanner is right just because it flagged something.',
  ];
  const volatile = [
    `File: ${ctx.file}:${ctx.line}`,
    `Scanner detail: ${ctx.detail}`,
    '',
    'SURROUNDING SOURCE (if available):',
    ctx.snippet || '(no snippet available for this finding)',
  ];
  return assemblePrompt(stable, volatile);
}

function functionLengthReviewImplementPrompt(task, planText) {
  return [
    'Your plan above is the final REASONED VERDICT for this function-length finding in OUR OWN project.',
    '',
    planText,
    '',
    'If the verdict is FALSE POSITIVE or UNCERTAIN: write ONE short paragraph (2-4 sentences) recording why, for a human to read later. Plain prose only -- no JSON, no code fence, no "steps", no candidate block.',
    '',
    'If the verdict is GENUINE: write ONE decomposition candidate for it, in EXACTLY this format (must match this parser exactly or it cannot be consumed downstream):',
    '',
    '### AC-NNN · Title',
    'Strength: Strong',
    `Files: ${task.promptContext.file || '(the file from the finding above)'}`,
    '',
    'Problem:',
    'A paragraph describing why this function\'s length is a real maintainability problem, grounded in the snippet you were given.',
    '',
    'Solution:',
    'A paragraph sketching the decomposition -- what logical pieces to extract into their own, clearly-named functions -- scoped to exactly this function, nothing broader.',
    '',
    'Benefits:',
    'A paragraph describing what improves once decomposed (readability, testability, review-ability).',
    '',
    '(Pick an AC-NNN number that looks reasonable; the harness re-derives the real one deterministically regardless of what you write here.)',
  ].join('\n');
}

// --- Prompts: fix stage (candidate already vetted -- implement the real diff) ----------

function functionLengthFixPlanPrompt(task) {
  const ctx = task.promptContext;
  return [
    'You are drafting a plan for a narrow function-decomposition change to this project.',
    '',
    `CANDIDATE: ${ctx.candidateId} -- ${ctx.title}`,
    '',
    'Full candidate write-up (Problem / Solution / Benefits, already vetted -- do not second-guess ' +
      'whether this is worth doing, only how to do it safely):',
    ctx.body,
    '',
    `Files involved: ${ctx.files.join(', ') || '(not specified -- infer from the write-up)'}`,
    '',
    'Write a numbered PLAN (no code) for EXACTLY this decomposition and nothing broader -- do not expand ' +
      'scope to adjacent cleanup even if you notice something else that looks wrong nearby. Name the ' +
      'specific new function(s) you will extract and what each one will contain. State assumptions ' +
      'explicitly; say UNKNOWN rather than inventing facts not given above.',
  ].join('\n');
}

function functionLengthFixImplementPrompt(task, planText) {
  const ctx = task.promptContext;
  const fetched = ctx.fetchedFiles || [];
  const namedButMissing = (ctx.files || []).filter((f) => !fetched.some((ff) => ff.path === f));
  return [
    'Earlier you wrote this PLAN for a narrow function-decomposition change:',
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
      ? `NOTE: ${namedButMissing.join(', ')} named by this candidate could not be read (does not exist at that path, or is outside the repo). If your plan assumed this file already exists and you cannot proceed without seeing its real content, output the empty string instead of guessing at content you were never shown.`
      : '',
    '',
    'Ground every "find" value in the real file content shown above, character for character -- never in your own memory of the plan or candidate write-up. Preserve behavior exactly: this is a pure decomposition (extract sub-functions, call them from the original site), not a rewrite -- do not change what the code does, only how it is organized.',
    '',
    groupBJsonInstructions,
  ].join('\n');
}

// --- Task source: function_length_review (scans + judges + writes a candidate) ---------

function nextFunctionLengthReviewTask({ repoRoot, pipelineDir, defaultDomain, taskIdExistsInQueue }) {
  const projectTag = path.basename(repoRoot);
  const coveragePath = process.env.AGENT_MANAGER_FUNCTION_LENGTH_COVERAGE_PATH
    || path.join(pipelineDir, 'function-length-coverage.json');
  const flagsPath = path.join(pipelineDir, 'queue', 'function-length-flags.json');

  let coverage;
  try { coverage = JSON.parse(readIfExists(coveragePath) || '{}'); } catch { coverage = {}; }
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
      console.error(`function_length_review: failed to scan "${projectTag}": ${e.message}`);
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
    const taskId = `function-length-${slugifyForId(projectTag)}-${slugifyForId(finding.file || 'repo')}-${finding.line || 0}`;
    if (taskIdExistsInQueue(taskId)) continue;

    let snippet = null;
    if (finding.file) {
      const content = readIfExists(path.join(repoRoot, finding.file));
      if (!content) continue;
      const lines = content.split('\n');
      const start = Math.max(0, (finding.line || 1) - 2);
      const end = Math.min(lines.length, (finding.line || 1) + 30); // a longer window than observability's -- the whole point here is judging the function's real shape, not just its start line
      snippet = lines.slice(start, end).join('\n');
    }

    return {
      id: taskId,
      domain: defaultDomain,
      source: 'function_length_review',
      title: `Function-length triage: ${finding.file}:${finding.line} — ${projectTag}`,
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

// Registers both task sources against the shared registry -- called once from wherever
// the consumer wires up its task sources (task-sources.js, a single line: see that
// file's own require of this module). getConfig/nextCandidateFulfillmentTask/
// taskIdExistsInQueue are passed in by the caller rather than required directly here, so
// this module never depends on task-sources.js itself -- only on the registry it's
// registering into, keeping the dependency direction one-way for a future extraction.
function register({ getConfig, nextCandidateFulfillmentTask, taskIdExistsInQueue, taskPriority }) {
  registerTaskSource('function_length_review', {
    priority: taskPriority('function_length_review', 80),
    next: () => {
      const { repoRoot, pipelineDir, defaultDomain } = getConfig();
      return nextFunctionLengthReviewTask({ repoRoot, pipelineDir, defaultDomain, taskIdExistsInQueue });
    },
    apply: ({ implementResponse }) => {
      const { repoRoot } = getConfig();
      const candidatesPath = process.env.AGENT_MANAGER_FUNCTION_LENGTH_CANDIDATES_PATH
        || path.join(repoRoot, 'Docs', 'FUNCTION_LENGTH_CANDIDATES.md');
      return applyArchDiscoveryCandidates({ implementResponse, candidatesPath, docTitle: '# Function Length Decomposition Candidates' });
    },
    // 2026-08-23: review-task.js/local-draft.js now read these two flags directly off
    // the registry entry instead of a hardcoded array a plugin author would otherwise
    // have to go edit inside those files -- the actual prerequisite this family's
    // extraction needed. advisoryProse: a short prose false-positive verdict is the
    // EXPECTED deliverable here, not a refusal. See review-task.js's own ADVISORY_PROSE_
    // SOURCES-turned-flag comment for the full history.
    advisoryProse: true,
  });
  updateTaskSource('function_length_review', { buildPlanPrompt: functionLengthReviewPlanPrompt, buildImplementPrompt: functionLengthReviewImplementPrompt });

  registerTaskSource('function_length_fix', {
    priority: taskPriority('function_length_fix', 72),
    next: () => {
      const { repoRoot } = getConfig();
      const candidatesPath = process.env.AGENT_MANAGER_FUNCTION_LENGTH_CANDIDATES_PATH
        || path.join(repoRoot, 'Docs', 'FUNCTION_LENGTH_CANDIDATES.md');
      return nextCandidateFulfillmentTask(candidatesPath, 'function_length_fix');
    },
    // emptyApproval: a false-positive-adjacent candidate can legitimately resolve to "no
    // real decomposition here after all" once the fix stage sees real file content.
    // candidateFulfillment: opts into local-draft.js's find-verification retry for free.
    emptyApproval: true, candidateFulfillment: true,
  });
  updateTaskSource('function_length_fix', { buildPlanPrompt: functionLengthFixPlanPrompt, buildImplementPrompt: functionLengthFixImplementPrompt });
}

module.exports = {
  register,
  nextFunctionLengthReviewTask,
  functionLengthReviewPlanPrompt,
  functionLengthReviewImplementPrompt,
  functionLengthFixPlanPrompt,
  functionLengthFixImplementPrompt,
};
