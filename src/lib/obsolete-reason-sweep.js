'use strict';

// obsolete-reason-sweep.js -- pure predicate that flags a task as obsolete
// when it was created before a registered reason was fixed.
//
// findObsoleteReason(task) -> the matching registry entry, or null.
// Pure: no I/O, no clock reads, no mutation of `task` or the registry.

const { OBSOLETE_REASON_REGISTRY } = require('./obsolete-reason-registry');

// A candidate field qualifies if it is a non-empty (non-blank) string.
function candidateStrings(task) {
  const fields = [task.priorRejectionFeedback, task.openQuestions];
  const out = [];
  for (const value of fields) {
    if (typeof value === 'string' && value.trim() !== '') {
      out.push(value);
    }
  }
  return out;
}

// Test a single reasonPattern (RegExp or string) against a candidate string.
function patternMatches(pattern, candidate) {
  if (pattern instanceof RegExp) {
    return pattern.test(candidate);
  }
  if (typeof pattern === 'string' && pattern.length > 0) {
    const needle = pattern.toLowerCase();
    const haystack = candidate.toLowerCase();
    return haystack.includes(needle);
  }
  return false;
}

// Strictly-before ISO string comparison gate.
function createdBeforeFixedAsOf(task, entry) {
  const createdAt = task && task.createdAt;
  const fixedAsOf = entry && entry.fixedAsOf;
  if (typeof createdAt !== 'string' || typeof fixedAsOf !== 'string') {
    return false;
  }
  if (createdAt.trim() === '' || fixedAsOf.trim() === '') {
    return false;
  }
  return createdAt < fixedAsOf;
}

/**
 * Return the first registry entry whose reasonPattern matches one of the
 * task's candidate strings (priorRejectionFeedback / openQuestions), provided
 * task.createdAt is strictly before the entry's fixedAsOf (ISO string compare).
 * Returns null when nothing matches or the date gate fails.
 */
function findObsoleteReason(task) {
  if (task == null || typeof task !== 'object') {
    return null;
  }

  const candidates = candidateStrings(task);
  if (candidates.length === 0) {
    return null;
  }

  for (const entry of OBSOLETE_REASON_REGISTRY) {
    if (entry == null || typeof entry !== 'object') {
      continue;
    }
    const matched = candidates.some((candidate) =>
      patternMatches(entry.reasonPattern, candidate)
    );
    if (!matched) {
      continue;
    }
    if (createdBeforeFixedAsOf(task, entry)) {
      return entry;
    }
  }

  return null;
}

module.exports = { findObsoleteReason };
