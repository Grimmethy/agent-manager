'use strict';

// 5-factor task-complexity heuristic (v1, 2026-09-17). Structural (not learned) scoring
// over an already-drafted task's own promptContext, per the published
// complexity-based routing pattern: task length, requirement count (distinct named
// symbols), domain breadth (distinct files touched), tool-orchestration needs (did a
// harness search have to run at all), and reasoning depth (sequential-dependency
// markers), combined into one 0..5 difficulty score.
//
// DELIBERATELY INERT (human design decision, 2026-09-17T22:37Z): this scores task
// INSTANCES, whereas src/task-sources.js assigns a STATIC reasoningTier per task
// SOURCE -- exactly the "model tier fixed by shape, not by size" gap. But wiring the
// score into providerFor()/reasoningTierFor()'s actual routing decision is a
// separate, separately-signed-off scope/product decision. This file therefore has NO
// call sites anywhere in the codebase: it is a pure, side-effect-free, sub-millisecond
// scoring function (string length + array length + one regex pass, reusing
// task-anchor-files.js's already-existing taskIdentifiers signal) that a future routing
// pass can consume once the maintainer approves dynamic per-task routing. A task
// scoring 0-1 is the natural candidate for a cheap-model re-route (Task Atomization).

const { taskIdentifiers } = require('./task-anchor-files.js');

// Per-factor cutoffs: a factor scores 1 when its raw signal is strictly ABOVE the
// threshold (toolNeeds: at/above, since a single harness search is already a
// tool-orchestration event). Frozen so callers cannot mutate the defaults; overrides
// are merged per-call.
const DEFAULT_THRESHOLDS = Object.freeze({
  length: 800,           // chars of rawText
  requirementCount: 4,   // distinct named symbols/files via taskIdentifiers
  domainBreadth: 2,      // distinct files touched (prefetchedPaths + anchor paths)
  toolNeeds: 1,          // harness-search results present (harnessHits/searchResults)
  reasoningDepth: 2,     // sequential-dependency markers matched in rawText
});

// Sequential / dependency markers indicating multi-step reasoning. Pure regex --
// no NLP, no model call.
const DEPTH_RE = /\b(?:then|after that|once (?:you|we|it)|depends on|depend on|prerequisite|before (?:we|you|it) can|subsequently|first,? (?:we|you|it) (?:must|should|need))\b/gi;

// A repo-relative-ish source path anywhere in the task text -- the "distinct files
// touched" signal beyond prefetchedPaths (task-anchor-files.js extracts the same
// shape for its own path discovery).
const PATH_RE = /\b(?:src|python|scripts|lib|test|tests|docs)(?:\/[\w.@-]+)+\.\w{1,5}\b/g;

/**
 * Score ONE task instance on 5 binary factors (each 0 or 1), summing to a 0..5
 * difficulty score with a suggested low/high tier. Pure: no I/O, no config read,
 * no mutation of `task`, never throws on missing/malformed fields (absent field ->
 * factor scores 0).
 *
 * @param {object} task - A task-shaped object. Read fields (all optional):
 *   task.rawText OR task.promptContext.rawText      (string)
 *   task.prefetchedPaths OR task.promptContext.prefetchedPaths (string[])
 *   task.promptContext.harnessHits / .searchResults (array) -- tool-orchestration evidence
 *   task.history (array) -- a stage:'harness-search' entry also counts as tool use
 * @param {object} [thresholds] - Optional overrides merged over DEFAULT_THRESHOLDS.
 * @returns {{score:number, factors:{length:number,requirementCount:number,domainBreadth:number,toolNeeds:number,reasoningDepth:number}, suggestedTier:'low'|'high'}}
 *   (frozen). suggestedTier is INFORMATIONAL only -- nothing in the repo routes on it.
 */
function scoreTaskComplexity(task, thresholds) {
  const t = Object.assign({}, DEFAULT_THRESHOLDS, thresholds || {});
  const ctx = (task && task.promptContext && typeof task.promptContext === 'object') ? task.promptContext : {};
  const rawText = String((task && (task.rawText || ctx.rawText)) || '');

  // Factor 1: length.
  const fLength = rawText.length > t.length ? 1 : 0;

  // Factor 2: requirement count (distinct named symbols/files the task itself names).
  let fReqCount = 0;
  try {
    const ids = taskIdentifiers(rawText);
    fReqCount = Array.isArray(ids) && ids.length > t.requirementCount ? 1 : 0;
  } catch (_) {
    fReqCount = 0; // degrade gracefully -- never let scoring throw
  }

  // Factor 3: domain breadth (distinct files touched: prefetched + paths named in text).
  const files = new Set();
  for (const p of (ctx.prefetchedPaths || (task && task.prefetchedPaths) || [])) {
    if (p) files.add(String(p).replace(/^\.\//, ''));
  }
  for (const m of rawText.match(PATH_RE) || []) files.add(m);
  const fDomain = files.size > t.domainBreadth ? 1 : 0;

  // Factor 4: tool needs (a harness search actually ran / produced results).
  const searchHits = ctx.harnessHits || (task && task.harnessSearch) || [];
  const searchResults = ctx.searchResults || [];
  const hadSearchStage = Array.isArray(task && task.history)
    && task.history.some((h) => h && h.stage === 'harness-search');
  const toolEvents = (Array.isArray(searchHits) ? searchHits.length : 0)
    + (Array.isArray(searchResults) ? searchResults.length : 0)
    + (hadSearchStage ? 1 : 0);
  const fTool = toolEvents >= t.toolNeeds ? 1 : 0;

  // Factor 5: reasoning depth (sequential-dependency markers).
  const depthMatches = rawText.match(DEPTH_RE) || [];
  const fDepth = depthMatches.length >= t.reasoningDepth ? 1 : 0;

  const factors = {
    length: fLength,
    requirementCount: fReqCount,
    domainBreadth: fDomain,
    toolNeeds: fTool,
    reasoningDepth: fDepth,
  };
  const score = fLength + fReqCount + fDomain + fTool + fDepth; // 0..5

  return Object.freeze({
    score,
    factors,
    suggestedTier: score <= 1 ? 'low' : 'high',
  });
}

module.exports = { scoreTaskComplexity, DEFAULT_THRESHOLDS };
