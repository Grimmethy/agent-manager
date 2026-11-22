'use strict';

// Deterministic adhoc review pre-checks: a pure, model-call-free gate over one task's
// implement response plus the fact-checker's own flags (src/fact-checker.js's
// checkDraft result) and the deterministic forbidden-path self-referential-block
// classifier (src/lib/reject-retry-check.js's forbiddenPathBlockNamesOwnTarget).
//
// Design contract (sub-task 1 of the adhoc review gate decomposition; the review-task.js
// wiring is a separate task that depends on this file existing):
//   - NO model calls, no network, no subprocesses, no DB reads. computeMechanicalPreChecks
//     is a pure function of its two arguments: every read is of the task object itself
//     (implementResponse, title, blockedReason, priorRejectionFeedback, and any of the
//     task.modelCallStats / task.abCallId / task.history fields when present) or of the
//     factCheck flags array passed in by the caller. This makes it safe to run inline in
//     the review path and trivially unit-testable without fixtures of live state.
//   - Conservative in the "don't invent failures" direction: every check defaults to
//     PASS when it has no positive evidence of a problem (no flags, no ID citations, no
//     cost claims). The one deliberate exception is costMatches === 'unverified' below --
//     a cost claim that cannot be checked against any recorded stats is neither proven
//     true nor false, and a mechanical auto-pass gate must not treat "I can't check it"
//     as "it checks out", so that case is its own third value, not a silent true.
//
// factCheck parameter shape: checkDraft (src/fact-checker.js) returns
// { flags, fileChecks, ... } where `flags` is a flat array of { type, detail } objects.
// checkDraft has already applied the isCreateTarget carve-out itself (a create mode's own
// target not existing yet is suppressed from `flags`; see checkDraft's own comment for
// the live incident it fixes), so this module accepts EITHER the `flags` array directly
// OR the full checkDraft result object and reads the flags list off it -- and still
// honors an isCreateTarget stamp on an individual flag, in case a caller passes flags
// built without that suppression already applied.

const { forbiddenPathBlockNamesOwnTarget } = require('./lib/reject-retry-check.js');

// Flag types that mean "the draft cited a file/path that does not resolve to a real
// in-repo file". 'missing-file' is checkDraft's own type for !exists && !isCreateTarget;
// 'ungrounded-path' is named by this gate's contract as the sibling shape (a path cited
// that grounding could not establish) and is included so either flag wording trips the
// same check. 'imprecise-file-path' is deliberately NOT here -- checkDraft's own comment
// calls it informational, "NOT a reject driver".
const FILE_PROBLEM_FLAG_TYPES = new Set(['missing-file', 'ungrounded-path']);

function factCheckFlags(factCheck) {
  if (Array.isArray(factCheck)) return factCheck;
  if (factCheck && Array.isArray(factCheck.flags)) return factCheck.flags;
  return [];
}

// fileExists: no missing-file/ungrounded-path-type flags (after the isCreateTarget
// carve-out, which checkDraft already applies to `flags` but is re-honored here for
// flag arrays built without it).
function computeFileExists(factCheck) {
  return !factCheckFlags(factCheck).some(
    (f) => f && FILE_PROBLEM_FLAG_TYPES.has(f.type) && !f.isCreateTarget
  );
}

// idExists: every task-ID-like citation in the implement response must not appear
// anywhere in the flags list (i.e. the fact-checker did not flag it as ungrounded/
// fabricated). Conservative: zero ID citations => true (nothing to verify).
//
// The four citation shapes named by the gate contract: AC-\d+ (this pipeline's own
// acceptance-criterion/fix marker -- see fact-checker.js's AC_MARKER_RE), bd-\d+
// (brain-dump IDs, case-insensitive since real citations mix "bd-178" and "BD-178"),
// HUB\d+ (hub task IDs), and kebab-case slugs (the decompose/hyphenated task-ID shape,
// e.g. "function-length-fix-ac-34").
const ID_CITATION_PATTERNS = [
  /\bAC-\d+\b/g,
  /\bbd-\d+\b/gi,
  /\bHUB\d+\b/g,
  /\b[a-z0-9]+(?:-[a-z0-9]+)+\b/g,
];

function extractIdCitations(text) {
  const out = new Set();
  const source = String(text == null ? '' : text);
  for (const re of ID_CITATION_PATTERNS) {
    const local = new RegExp(re.source, re.flags); // fresh instance -- never share /g lastIndex
    for (const m of source.matchAll(local)) out.add(m[0]);
  }
  return out;
}

function computeIdExists(task, factCheck) {
  const text = String((task && task.implementResponse) || '');
  const ids = extractIdCitations(text);
  if (ids.size === 0) return true; // conservative: no IDs cited => nothing flagged
  const flagTexts = factCheckFlags(factCheck)
    .filter((f) => f && typeof f === 'object')
    .map((f) => [f.detail, f.id, f.claimedPath, f.type].filter((v) => typeof v === 'string').join('\n'));
  for (const id of ids) {
    if (flagTexts.some((t) => t.includes(id))) return false;
  }
  return true;
}

// costMatches: true when the draft makes no numeric cost/tally claims, or when every
// claimed number appears verbatim in the task's recorded model-call stats/history;
// false when a claimed number is absent from the record; the third value 'unverified'
// when cost claims ARE present but the task carries no record to check them against
// (see the module header for why that is not a silent true).
//
// The cost-claim shape is deliberately narrow -- a number within a short window of a
// cost/tally/call/turn/token word. Prose without that adjacency ("the fix touches 3
// lines") is not a cost claim and never fails this check.
// A cost/tally keyword anywhere; the claimed number can sit on EITHER side of it
// ("used 5 model calls" and "the cost is $0.06" both count), so the number is read from
// a small window around each keyword rather than by a single one-directional regex.
const COST_WORD_RE =
  /\b(?:costs?|costed?|costing?|tallies?|tallied?|tallying?|spends?|spent|spending?|model[\s-]?calls?|calls?|turns?|tokens?)\b/gi;
const COST_CLAIM_NUMBER_RE = /\$?(\d[\d,]*(?:\.\d+)?)/g;
const COST_CLAIM_WINDOW = 40; // chars of prose on each side of a keyword to scan for the number

function extractCostClaims(implementResponse) {
  const out = new Set();
  const source = String((implementResponse) == null ? '' : implementResponse);
  const wordLocal = new RegExp(COST_WORD_RE.source, COST_WORD_RE.flags);
  for (const m of source.matchAll(wordLocal)) {
    const start = Math.max(0, m.index - COST_CLAIM_WINDOW);
    const end = Math.min(source.length, m.index + m[0].length + COST_CLAIM_WINDOW);
    const window = source.slice(start, end);
    const numLocal = new RegExp(COST_CLAIM_NUMBER_RE.source, COST_CLAIM_NUMBER_RE.flags);
    for (const n of window.matchAll(numLocal)) out.add(n[1].replace(/,/g, ''));
  }
  return [...out];
}

// The "recorded model-call stats/history" this check validates claims against -- whatever
// of the task's own recorded stats fields the task actually carries. Kept as a plain
// stringify of those fields: "the numbers appear verbatim in the record" is then a literal
// substring test, exactly as conservative (and as easy to audit by hand) as the contract
// asks. No DB access -- a task that was never recorded has none of these fields.
function recordText(task) {
  if (!task) return null;
  const parts = [task.modelCallStats, task.modelStats, task.stats, task.abCallId, task.history];
  const present = parts.filter((p) => p !== undefined && p !== null);
  if (present.length === 0) return null;
  return JSON.stringify(present);
}

function computeCostMatches(task) {
  const claims = extractCostClaims(task && task.implementResponse);
  if (claims.length === 0) return true; // conservative: no cost claims => nothing to contradict
  const record = recordText(task);
  if (record === null) return 'unverified';
  return claims.every((n) => record.includes(n));
}

// forbiddenPathClear: the task is not sitting in the forbidden-path false-positive shape
// (its own declared edit target was the path the gate forbade) -- that shape can never
// clear on a blind retry, so a mechanical auto-pass must exclude it. Pure function of
// the task; see forbiddenPathBlockNamesOwnTarget's own header in
// src/lib/reject-retry-check.js for the root-caused incident.
function computeForbiddenPathClear(task) {
  return !forbiddenPathBlockNamesOwnTarget(task);
}

/**
 * Pure deterministic adhoc review pre-checks. No model calls, no I/O.
 *
 * @param {object} task - the task under review (reads implementResponse, title,
 *   blockedReason, priorRejectionFeedback, and recorded stats/history fields).
 * @param {Array|object} factCheck - the fact-checker result: either the `flags` array
 *   (array of { type, detail, ... }) or the full checkDraft() result object
 *   ({ flags, fileChecks, ... }).
 * @returns {{ fileExists: boolean, idExists: boolean,
 *             costMatches: (true|false|'unverified'),
 *             forbiddenPathClear: boolean, mechanicalPass: boolean }}
 *   mechanicalPass is the strict conjunction of all four: costMatches must be exactly
 *   `true` -- the 'unverified' third value does NOT count as passing a mechanical gate.
 */
function computeMechanicalPreChecks(task, factCheck) {
  const fileExists = computeFileExists(factCheck);
  const idExists = computeIdExists(task, factCheck);
  const costMatches = computeCostMatches(task);
  const forbiddenPathClear = computeForbiddenPathClear(task);
  return {
    fileExists,
    idExists,
    costMatches,
    forbiddenPathClear,
    mechanicalPass: Boolean(fileExists && idExists && costMatches === true && forbiddenPathClear),
  };
}

module.exports = { computeMechanicalPreChecks };
