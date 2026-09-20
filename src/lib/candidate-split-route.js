'use strict';

// Whether a candidate split that the doc-split path forbids (a Split-Depth >= 1 sub-candidate, or a `noCandidateSplit` source's
// candidate) is ROUTED TO THE COORDINATOR-HUB SYSTEM instead of blocking for a human -- see apply-adhoc-diff.js's
// applyCandidateSplitAsHub and local-draft.js's finalizeCandidateFulfillment. One switch, read by BOTH the draft (which routes) and
// the prompt (which must OFFER the split to a noCandidateSplit source, or the model never knows the option exists).
// Kill switch: AGENT_MANAGER_CANDIDATE_SPLIT_TO_HUB=false restores the old "blocked for a human to narrow the fix".
function candidateSplitToHubEnabled() {
  return process.env.AGENT_MANAGER_CANDIDATE_SPLIT_TO_HUB !== 'false';
}

module.exports = { candidateSplitToHubEnabled };
