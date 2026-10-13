/**
 * brain-dump-sort-classifier.js
 *
 * Deterministic, synchronous, zero-dependency classifier for brain_dump_sort
 * task objects. Complements the lower-level helpers in
 * src/brain-dump-sort-classify.js (parseBrainDumpSortResult, validateSecondBrainPath,
 * isInvestigationFinding, etc.) by providing a single high-level verdict function.
 *
 * NOTE: the `confidence` field returned here is a NUMBER in [0, 1], which is
 * distinct from the string-valued `confidence` fields ('high'/'medium'/'none')
 * used elsewhere in this repo.
 *
 * This module has zero external dependencies, no network access, no child
 * processes, and no non-deterministic sources (no Math.random, no Date.now).
 */

'use strict';

// Frozen array of blocked-keyword regex patterns (order matters: first match wins for reason).
const BLOCKED_PATTERNS = Object.freeze([
  /rm\s+-rf/i,
  /\bDROP\s+TABLE\b/i,
  /\bDELETE\s+FROM\b/i,
  /--force\b/,
  /\bshred\b/i,
  /\bwipe\s+out\b/i,
]);

// Path-safety regexes.
const RE_PATH_TRAVERSAL = /(\.\.\/|\.\.\\|\/\.\.\/|\/\.\.$)/;
const RE_ABSOLUTE_PATH = /^\/|^\\|^[A-Za-z]:/;
const RE_NULL_BYTE = /\x00/;

/**
 * Classify a brain_dump_sort task JSON object.
 *
 * @param {object} taskJson – the brain_dump_sort task object. Expected to carry
 *   at least `secondBrainPath` (string) and optionally `belongsToProject`
 *   (string|null), `description`, `notes`, `title`, `isInvestigationFinding`.
 * @returns {{verdict: 'approved'|'blocked', blockedReason?: string, confidence: number}}
 *   - verdict is always 'approved' or 'blocked'.
 *   - blockedReason is present only when verdict === 'blocked'.
 *   - confidence is a number in [0, 1].
 */
function classifyBrainDump(taskJson) {
  // a. Structural guard
  if (
    taskJson === null ||
    taskJson === undefined ||
    typeof taskJson !== 'object' ||
    Array.isArray(taskJson)
  ) {
    return { verdict: 'blocked', blockedReason: 'taskJson must be a non-null object', confidence: 0.00 };
  }

  // b. Required-field presence
  const sp = taskJson.secondBrainPath;
  if (sp === undefined || sp === null || typeof sp !== 'string' || sp.length === 0) {
    return { verdict: 'blocked', blockedReason: 'missing required field: secondBrainPath', confidence: 0.10 };
  }

  const btp = taskJson.belongsToProject;
  if (btp !== null && btp !== undefined && typeof btp !== 'string') {
    return { verdict: 'blocked', blockedReason: 'belongsToProject must be a string or null', confidence: 0.10 };
  }

  // c. Path validation via regex
  if (RE_PATH_TRAVERSAL.test(sp)) {
    return { verdict: 'blocked', blockedReason: 'secondBrainPath failed safety check: path traversal (.. segments)', confidence: 0.20 };
  }
  if (RE_ABSOLUTE_PATH.test(sp)) {
    return { verdict: 'blocked', blockedReason: 'secondBrainPath failed safety check: absolute path', confidence: 0.20 };
  }
  if (RE_NULL_BYTE.test(sp)) {
    return { verdict: 'blocked', blockedReason: 'secondBrainPath failed safety check: null byte', confidence: 0.20 };
  }

  // d. Blocked-keyword scan
  const haystack = [
    typeof taskJson.description === 'string' ? taskJson.description : '',
    typeof taskJson.notes === 'string' ? taskJson.notes : '',
    typeof taskJson.title === 'string' ? taskJson.title : '',
  ].join('\n');

  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(haystack)) {
      return { verdict: 'blocked', blockedReason: 'blocked keyword detected in task text', confidence: 0.40 };
    }
  }

  // e. Investigation-finding heuristic
  if (taskJson.isInvestigationFinding === true && !taskJson.belongsToProject) {
    return { verdict: 'blocked', blockedReason: 'investigation finding without a project assignment', confidence: 0.50 };
  }

  // f. All checks pass → approved
  return { verdict: 'approved', confidence: 1.00 };
}

module.exports = { classifyBrainDump };
