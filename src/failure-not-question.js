'use strict';

// failure-not-question.js (HUB0917 · 2/5)
//
// Pure classifier for the seven "failure, not question" categories:
//   empty-draft, infra-error, refusal, zero-search-results, invented-path,
//   invented-claim, ambiguous
//
// isFailureNotQuestion(task) walks the rules in this exact order and returns
// the first matching category string, or null when the task carries a concrete
// design question that belongs in needs-clarification/.
//
// routeNeedsClarificationOrBlocked(task, ctx) uses that classification: when a
// failure category is returned, it stamps blockedCategory plus the
// re-admission bucket (derived from REASON_CATEGORIES / classifyBlockedTask's
// retryable flag) and writes the task to the blocked queue dir; otherwise it
// writes the task to needsClarificationDir unchanged.
//
// No timers. Pure predicates where possible; only routeNeedsClarificationOrBlocked
// touches the filesystem.

const path = require('path');
const fs = require('fs');
const { isInfraError, REASON_CATEGORIES, classifyBlockedTask } = require('./blocked-task-classifiers.js');

// The seven failure categories, in the order they are checked.
const FAILURE_CATEGORIES = [
  'empty-draft',
  'infra-error',
  'refusal',
  'zero-search-results',
  'invented-path',
  'invented-claim',
  'ambiguous',
];

// Regexes used by each rule, exported so tests and other modules can reference
// them without re-implementing the matching logic.
const EMPTY_DRAFT_RE = /empty draft|empty response|no content/i;
const REFUSAL_RE = /refusal|refused to|refused the/i;
const ZERO_SEARCH_RESULTS_RE = /zero search results|no search results|no results found/i;
const INVENTED_PATH_RE = /invented path|fabricated path|non-existent path/i;
const INVENTED_CLAIM_RE = /invented claim|fabricated claim|hallucinated/i;
const AMBIGUOUS_RE = /ambiguous|ambiguous request|unclear requirement/i;

// Pure predicate: returns one of the seven category strings, or null.
function isFailureNotQuestion(task) {
  if (!task || typeof task !== 'object') return null;

  const reason = String(task.blockedReason || '').trim();

  // 1. empty-draft
  if (EMPTY_DRAFT_RE.test(reason)) return 'empty-draft';

  // 2. infra-error (delegate to existing classifier)
  if (isInfraError(task)) return 'infra-error';

  // 3. refusal
  if (REFUSAL_RE.test(reason)) return 'refusal';

  // 4. zero-search-results
  if (ZERO_SEARCH_RESULTS_RE.test(reason)) return 'zero-search-results';

  // 5. invented-path
  if (INVENTED_PATH_RE.test(reason)) return 'invented-path';

  // 6. invented-claim
  if (INVENTED_CLAIM_RE.test(reason)) return 'invented-claim';

  // 7. ambiguous
  if (AMBIGUOUS_RE.test(reason)) return 'ambiguous';

  return null;
}

// Derive the re-admission bucket from REASON_CATEGORIES: 'retryable' if the
// category's retryable flag is true, otherwise 'non-retryable'.
function getReAdmissionBucket(category) {
  const entry = REASON_CATEGORIES.find((r) => r.key === category);
  if (!entry) return 'non-retryable';
  return entry.retryable ? 'retryable' : 'non-retryable';
}

// Route a task to either the blocked queue (if it's a failure) or
// needs-clarification (if it's a genuine question).
//
// ctx must include:
//   - queueRoot: the base queue directory (e.g. 'queue')
//   - blockedDir: path to the blocked queue subdirectory
//   - needsClarificationDir: path to the needs-clarification subdirectory
//
// Returns { moved: true, category, bucket, destPath } or
//          { moved: false, reason: 'not-a-failure', destPath }.
function routeNeedsClarificationOrBlocked(task, ctx) {
  const category = isFailureNotQuestion(task);

  if (!category) {
    // Not a failure -- write to needs-clarification unchanged.
    const destPath = path.join(ctx.needsClarificationDir, `${task.id || 'unknown'}.json`);
    fs.mkdirSync(ctx.needsClarificationDir, { recursive: true });
    fs.writeFileSync(destPath, JSON.stringify(task, null, 2), 'utf8');
    return { moved: false, reason: 'not-a-failure', destPath };
  }

  // Failure category -- stamp and write to blocked queue.
  const bucket = getReAdmissionBucket(category);
  task.blockedCategory = category;
  task.reAdmissionBucket = bucket;

  const destPath = path.join(ctx.blockedDir, `${task.id || 'unknown'}.json`);
  fs.mkdirSync(ctx.blockedDir, { recursive: true });
  fs.writeFileSync(destPath, JSON.stringify(task, null, 2), 'utf8');

  return { moved: true, category, bucket, destPath };
}

module.exports = {
  FAILURE_CATEGORIES,
  EMPTY_DRAFT_RE,
  REFUSAL_RE,
  ZERO_SEARCH_RESULTS_RE,
  INVENTED_PATH_RE,
  INVENTED_CLAIM_RE,
  AMBIGUOUS_RE,
  isFailureNotQuestion,
  getReAdmissionBucket,
  routeNeedsClarificationOrBlocked,
};
