'use strict';

// Concept status state machine (pure helpers, no I/O, no require of concepts.js).
// A concept parked (shelved) or finished (shipped) is a deliberate, terminal-for-now
// decision -- research and build-tally mutations must never silently reopen it.

const STABLE_CONCEPT_STATUSES = new Set(['shelved', 'shipped']);

function isStableStatus(concept) {
  return !!concept && STABLE_CONCEPT_STATUSES.has(concept.status);
}

// 'open' advances to 'researched'; every other status is unchanged.
function nextStatusAfterResearch(concept) {
  return concept.status === 'open' ? 'researched' : concept.status;
}

// 'open' / 'researched' advance to 'in-progress'; every other status is unchanged.
function nextStatusAfterBuildTally(concept) {
  return (concept.status === 'researched' || concept.status === 'open') ? 'in-progress' : concept.status;
}

module.exports = {
  STABLE_CONCEPT_STATUSES,
  isStableStatus,
  nextStatusAfterResearch,
  nextStatusAfterBuildTally,
};
