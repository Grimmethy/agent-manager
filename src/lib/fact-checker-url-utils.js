'use strict';

// fact-checker-url-utils.js -- extracted from src/fact-checker.js ([[hub-task-integration]] node-module decompose).

function extractDomainRoot(url) {
  let hostname;
  try {
    ({ hostname } = new URL(url));
  } catch (e) {
    return null;
  }
  const labels = hostname.split('.').filter(Boolean);
  if (labels.length < 2) return labels[0] || null;
  return labels[labels.length - 2];
}

module.exports = { extractDomainRoot };
