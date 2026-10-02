'use strict';

// HUB0129 1/2 -- deterministic adhoc review pre-checks.
//
// This module is a PURE, deterministic gate: it makes NO model calls, NO network
// requests, and touches NO filesystem. It takes a `task` object plus a pre-computed
// fact-checker result (the return shape of `checkDraft` from src/fact-checker.js)
// and reduces them to four boolean pre-checks plus their conjunction. The sibling
// piece (HUB0129 2/2) is the one that actually gates the adhoc review path on
// `mechanicalPass`; this piece only *computes* the verdict deterministically so
// that gate is reproducible and auditable.
//
// Why these four, and why "deterministic": each one is a pure function of (task,
// factCheck) bytes -- no stochastic model judgment, no live git, no I/O. That means
// the same inputs always yield the same `mechanicalPass`, which is exactly the
// property a mechanical pre-check needs (a human reviewer can re-run it by hand and
// get the identical answer). The stochastic, judgment-bearing work (the actual
// review verdict) stays in the model path this gate fronts.

const { forbiddenPathBlockNamesOwnTarget } = require('./lib/reject-retry-check.js');

// ---------------------------------------------------------------------------
// fileExists
// ---------------------------------------------------------------------------
//
// checkDraft (src/fact-checker.js) stamps a flat `flags` array; each entry carries a
// `type` string plus a `detail`. The `type` literals below are the ACTUAL ones the
// fact-checker emits for "a file/path the draft claims does not exist, or is not
// grounded in the source material it was given" -- confirmed by reading the real
// flag-producing lines in fact-checker.js (not guessed):
//
//   'missing-file'   -- a claimed file path does not exist in the repo. checkDraft
//                       itself already SUPPRESSES this flag for create-mode targets
//                       (a file the diff itself CREATES, see extractCreateModeTargets
//                       and the `!f.exists && !f.isCreateTarget` guard), and any
//                       surviving entry that IS a create target is additionally
//                       stamped `isCreateTarget: true`. So a legitimate new file never
//                       reaches us as a plain missing-file flag -- but we still honor
//                       the carve-out explicitly below (defense in depth, and so the
//                       predicate is correct even against a hand-built factCheck).
//   'ungrounded-url' -- a URL value in the draft that does not appear verbatim in the
//                       source material (fabricated-value failure).
//   'ungrounded-field'-- an ALLCAPS_UNDERSCORE token (GIS-column shape) that does not
//                        appear in the source material (fabricated-value failure).
//
// 'imprecise-file-path' is deliberately EXCLUDED: fact-checker.js marks it
// "informational only ... NOT a reject driver" (the file IS real, just cited with a
// missing/wrong directory prefix), so it must not drive fileExists false.
const FILE_EXISTENCE_FLAG_TYPES = new Set([
  'missing-file',
  'ungrounded-url',
  'ungrounded-field',
]);

// A flag "counts" against fileExists only if it is one of the failure types above AND
// is not an isCreateTarget carve-out (the create-mode exception). isCreateTarget is
// only ever stamped on file-derived entries, so checking it here is cheap and safe.
function flagViolatesFileExists(flag) {
  if (!flag || typeof flag !== 'object') return false;
  if (!FILE_EXISTENCE_FLAG_TYPES.has(flag.type)) return false;
  if (flag.isCreateTarget) return false; // the carve-out: the diff itself creates this file
  return true;
}

function computeFileExists(factCheck) {
  const flags = factCheck && Array.isArray(factCheck.flags) ? factCheck.flags : [];
  return !flags.some(flagViolatesFileExists);
}

// ---------------------------------------------------------------------------
// idExists
// ---------------------------------------------------------------------------
//
// Extract task-ID-like citations from the draft's implementResponse and check that
// NONE of them is flagged by the fact-checker (i.e. does not appear in any flag).
// Spec: "idExists = every task-ID-like citation ... is absent from that flags list
// (no IDs cited means true)."
//
// The ID shapes cited in the spec, mapped to real, high-precision patterns that match
// the actual task-id shapes in this repo (adhoc-implement-...-1790957548564,
// bd-1788769575997-orphaned-claim-recovery-cost-..., change-review-fix-ac-1, HUB0129):
//   AC-\d+     -- architectural-concern ids (AC-1, AC-164, ...)
//   bd-\d+     -- brain-dump ids (bd-1789456618325, ...)
//   HUB\d+     -- coordinator-hub ids (HUB0129, ...)
//   kebab slug -- a lowercase-dash token carrying a 6+-digit segment (the shape of
//                 nearly every pipeline task id), at least two dashes so we do not
//                 swallow ordinary two-word phrases. Being a SUPERSET is safe here:
//                 idExists only turns false if a matched id ALSO appears in a flag.
const ID_CITATION_PATTERNS = [
  /\bAC-\d+\b/g,
  /\bbd-\d+\b/g,
  /\bHUB\d+\b/g,
  /(?<![\w/`])([a-z0-9]+(?:-[a-z0-9]+){2,})(?![\w`])/g,
];

// Extract every ID-like citation from the draft text, dedup'd, as a Set of strings.
function extractCitedIds(text) {
  const ids = new Set();
  const src = typeof text === 'string' ? text : '';
  if (!src) return ids;
  for (const re of ID_CITATION_PATTERNS) {
    re.lastIndex = 0;
    for (const m of src.matchAll(re)) {
      const raw = m[0];
      // For the generic kebab-slug pattern, keep only tokens that carry a 6+-digit
      // segment -- that is what makes them task-id-shaped rather than prose.
      if (re.source.includes('a-z0-9]+(?:-[a-z0-9]+){2,}') && !/\d{6,}/.test(raw)) continue;
      ids.add(raw);
    }
  }
  return ids;
}

// A flag "references" a cited id if the id string appears anywhere in the flag's
// serialized form (type, detail, or any other field the fact-checker attached).
function flagReferencesAnyId(flag, ids) {
  if (!flag || typeof flag !== 'object') return false;
  const text = JSON.stringify(flag);
  for (const id of ids) if (text.includes(id)) return true;
  return false;
}

function computeIdExists(task, factCheck) {
  const ids = extractCitedIds(task && task.implementResponse);
  if (ids.size === 0) return true; // no IDs cited at all -> trivially present/absent-ok
  const flags = factCheck && Array.isArray(factCheck.flags) ? factCheck.flags : [];
  return !flags.some((flag) => flagReferencesAnyId(flag, ids));
}

// ---------------------------------------------------------------------------
// costMatches
// ---------------------------------------------------------------------------
//
// Spec: "costMatches = the draft makes no numeric cost/tally claims contradicting the
// task's recorded model-call stats/history (pass when no cost claims present or numbers
// appear verbatim in the record; mark unverified if no record exists)."
//
// This is a third-state check, not a plain boolean, because "no record exists" is a
// genuinely distinct outcome from "the numbers contradict the record":
//   true   -- no cost/tally claims, OR every claimed number appears verbatim in the record
//   false  -- a claimed number does NOT appear in the record (a contradiction)
//   null   -- UNVERIFIED: the draft makes cost/tally claims but the task carries no
//             recorded model-call stats/history to check against. This is a distinct,
//             documented state (NOT a silent pass) so the sibling gate can treat
//             "unverified" differently from "verified-false" (e.g. surface it to a human
//             rather than auto-rejecting). `mechanicalPass` below requires costMatches
//             to be STRICTLY true, so an unverified cost claim does NOT ride through the
//             mechanical fast path -- the safe default.
//
// "The record" is the task's own recorded model-call stats/history, read purely from
// the task object (no I/O). We serialize the fields a pipeline task actually carries
// for this (history plus any explicit stats/cost fields) into one string and test for
// verbatim presence of each claimed number in it.
const COST_CLAIM_PATTERNS = [
  // dollar amounts: "$12", "$1,234", "$12.50"
  /\$([0-9][0-9,]*(?:\.[0-9]+)?)/g,
  // explicit call tallies: "3 model calls", "12 API calls", "7 LLM calls"
  /\b([0-9][0-9,]*)\s+(?:model|api|llm)\s+calls?\b/gi,
  // token tallies: "1,500,000 tokens"
  /\b([0-9][0-9,]*)\s+tokens?\b/gi,
];

// Extract the numeric value of every cost/tally claim in the draft text. Returns an
// array of the raw number strings exactly as they appeared (commas/decimal preserved).
function extractCostClaimNumbers(text) {
  const nums = [];
  const src = typeof text === 'string' ? text : '';
  if (!src) return nums;
  for (const re of COST_CLAIM_PATTERNS) {
    re.lastIndex = 0;
    for (const m of src.matchAll(re)) {
      const raw = (m[1] || '').replace(/[,\s]/g, '');
      if (raw) nums.push(raw);
    }
  }
  // de-dupe
  return [...new Set(nums)];
}

// Gather the task's recorded model-call stats/history into one comparable string, or
// null if the task carries no such record at all (-> costMatches "unverified").
function buildCostRecord(task) {
  if (!task || typeof task !== 'object') return null;
  const candidates = [
    task.history,
    task.modelStats,
    task.modelCallStats,
    task.modelCalls,
    task.stats,
    task.usage,
    task.costUsd,
    task.totalCostUsd,
  ].filter((v) => v !== undefined && v !== null);
  if (candidates.length === 0) return null;
  // A present-but-empty history array is still "a record" (just nothing logged), so we
  // serialize it rather than treat it as absent; callers get the verified true/false path.
  try {
    return JSON.stringify(candidates);
  } catch {
    return null;
  }
}

// A claimed number "appears verbatim in the record" if either the number as written or
// its digits-only form is a substring of the record string. (The record is JSON, so a
// count of 1234 stored as a number serializes to "1234" -- matching the digits-only
// form is what makes the check robust to formatting differences like "1,234".)
function numberAppearsInRecord(numberStr, record) {
  const digitsOnly = numberStr.replace(/[^0-9]/g, '');
  if (record.includes(numberStr)) return true;
  if (digitsOnly && record.includes(digitsOnly)) return true;
  return false;
}

function computeCostMatches(task) {
  const draft = task && typeof task.implementResponse === 'string' ? task.implementResponse : '';
  const claimed = extractCostClaimNumbers(draft);
  if (claimed.length === 0) return true; // no cost/tally claims -> nothing to contradict
  const record = buildCostRecord(task);
  if (record === null) return null; // claims present but NO record -> UNVERIFIED
  return claimed.every((n) => numberAppearsInRecord(n, record));
}

// ---------------------------------------------------------------------------
// forbiddenPathClear
// ---------------------------------------------------------------------------
//
// Spec: "forbiddenPathClear = !forbiddenPathBlockNamesOwnTarget(task) from
// src/lib/reject-retry-check.js." That helper is a boolean: true when a prior
// forbidden-path block names one of the task's OWN declared edit targets (a false
// positive that a blind retry can never clear), false otherwise. We invert it. It
// already fail-opens to false on any internal error, so calling it directly is safe.
function computeForbiddenPathClear(task) {
  return !forbiddenPathBlockNamesOwnTarget(task);
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/**
 * Compute the four deterministic adhoc review pre-checks for a task, given a
 * pre-computed fact-checker result (the return value of `checkDraft` from
 * src/fact-checker.js, or a compatible `{ flags: [...] }` shape).
 *
 * @param {object} task        The task object (reads `task.implementResponse`,
 *                             `task.history`, and any recorded stats/cost fields).
 * @param {object} factCheck   The fact-checker result; must expose `flags` (an array
 *                             of `{ type, detail, ... }` entries). May be null/undefined.
 * @returns {{ fileExists: boolean, idExists: boolean, costMatches: (boolean|null),
 *             forbiddenPathClear: boolean, mechanicalPass: boolean }}
 *   `costMatches` is `true`/`false`/`null` where `null` means UNVERIFIED (claims
 *   present but no recorded stats/history to check against). `mechanicalPass` is the
 *   strict conjunction: true only when all four are strictly `true` (an unverified
 *   costMatches does NOT pass the mechanical fast path).
 */
function computeMechanicalPreChecks(task, factCheck) {
  const fileExists = computeFileExists(factCheck);
  const idExists = computeIdExists(task, factCheck);
  const costMatches = computeCostMatches(task);
  const forbiddenPathClear = computeForbiddenPathClear(task);
  const mechanicalPass =
    fileExists === true &&
    idExists === true &&
    costMatches === true &&
    forbiddenPathClear === true;
  return { fileExists, idExists, costMatches, forbiddenPathClear, mechanicalPass };
}

module.exports = {
  computeMechanicalPreChecks,
  // exported for direct unit-testing of the individual predicates
  _internals: {
    computeFileExists,
    computeIdExists,
    computeCostMatches,
    computeForbiddenPathClear,
    extractCitedIds,
    extractCostClaimNumbers,
    buildCostRecord,
    flagViolatesFileExists,
    FILE_EXISTENCE_FLAG_TYPES,
  },
};
