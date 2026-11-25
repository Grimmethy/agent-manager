'use strict';

// Returns the last non-empty path segment, treating both '/' and '\' as separators.
// Trailing separators are ignored. If no segment remains (empty input or only
// separators), the original input is returned unchanged.
function agentSlug(p) {
  const input = String(p);
  const trimmed = input.replace(/[\\/]+$/, '');
  const segments = trimmed.split(/[\\/]/).filter(Boolean);
  return segments.length ? segments[segments.length - 1] : input;
}

module.exports = { agentSlug };
