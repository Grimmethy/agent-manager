'use strict';

// obsolete-reason-sweep.js -- pure predicate that flags a task as "obsolete".
//
// Depends on ./obsolete-reason-registry (sibling HUB0113 1/4), which exports an
// array of entries shaped like { reasonPattern, fixedAsOf }. This module exposes
// a single side-effect-free function: findObsoleteReason(task).
//
// A task is considered obsolete when EITHER of its `priorRejectionFeedback` or
// `openQuestions` (whichever is a non-empty string) matches a registry entry's
// reasonPattern, AND the task was created strictly before the entry's fixedAsOf
// date (ISO-8601 lexicographic compare). Otherwise it returns null.

const registryModule = require('./obsolete-reason-registry');

// The registry may export the array directly, or a named property
// (OBSOLETE_REASON_REGISTRY / entries). Resolve to an array defensively.
function resolveEntries() {
  if (Array.isArray(registryModule)) return registryModule;
  if (registryModule && Array.isArray(registryModule.OBSOLETE_REASON_REGISTRY)) {
    return registryModule.OBSOLETE_REASON_REGISTRY;
  }
  if (registryModule && Array.isArray(registryModule.entries)) {
    return registryModule.entries;
  }
  return [];
}

function isNonBlankString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function patternMatches(pattern, candidate) {
  if (pattern instanceof RegExp) {
    return pattern.test(candidate);
  }
  if (typeof pattern === 'string' && pattern.trim() !== '') {
    return candidate.toLowerCase().includes(pattern.toLowerCase());
  }
  return false;
}

function findObsoleteReason(task) {
  if (task === null || typeof task !== 'object') return null;

  const candidates = [];
  if (isNonBlankString(task.priorRejectionFeedback)) {
    candidates.push(task.priorRejectionFeedback);
  }
  if (isNonBlankString(task.openQuestions)) {
    candidates.push(task.openQuestions);
  }
  if (candidates.length === 0) return null;

  const entries = resolveEntries();
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry || typeof entry !== 'object') continue;

    // Date gate: task must have been created strictly before the fix.
    if (
      typeof task.createdAt !== 'string' ||
      typeof entry.fixedAsOf !== 'string' ||
      !(task.createdAt < entry.fixedAsOf)
    ) {
      continue;
    }

    // Pattern gate: any candidate matching the entry's pattern is a hit.
    const matched = candidates.some((c) => patternMatches(entry.reasonPattern, c));
    if (matched) return entry;
  }

  return null;
}

module.exports = { findObsoleteReason };
