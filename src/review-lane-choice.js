'use strict';

// Which reviewer endpoint does a hand-run review use? (HUB0532 1/5)
// A review should not wait behind a Forge GPU lease on the default card when another reviewer lane is free.
// Pure: lanes and isLeased are injected by the caller. No file reads, no network, no model calls.

// explicitOllamaUrl: a URL the caller forced; returned unchanged and isLeased is never consulted.
// defaultEndpoint: the normal reviewer endpoint, used when it is not leased.
// lanes: getLanes() shape. isLeased(url): is that endpoint under a fresh Forge lease.
// -> { endpoint, model, laneName, reason } or null when every reviewer lane is leased.
function chooseReviewLane({ explicitOllamaUrl, defaultEndpoint, lanes, isLeased } = {}) {
  if (typeof isLeased !== 'function') throw new TypeError('chooseReviewLane: isLeased must be a function');
  if (explicitOllamaUrl) {
    return { endpoint: explicitOllamaUrl, model: null, laneName: null, reason: 'explicit' };
  }
  if (!isLeased(defaultEndpoint)) {
    return { endpoint: defaultEndpoint, model: null, laneName: 'default', reason: 'default-free' };
  }
  for (const lane of lanes || []) {
    if (!lane || lane.enabled === false || lane.cloud || !lane.reviewer) continue;
    const endpoint = (lane.env && lane.env.OLLAMA_URL) || '';
    if (!endpoint || isLeased(endpoint)) continue;
    return { endpoint, model: lane.model || null, laneName: lane.id || null, reason: 'fallback' };
  }
  return null;
}

module.exports = { chooseReviewLane };
