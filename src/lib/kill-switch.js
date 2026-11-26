'use strict';

// kill-switch.js -- small utility to gate the re-orient feature behind an env var.
//
// Convention: setting AGENT_MANAGER_REORIENT=false disables the re-orient feature
// (kill switch is off). Any other value, or the variable being absent, leaves the
// feature enabled. This mirrors the pattern used by other feature modules
// (e.g. src/brain-dump-target-check.js) so operators get a uniform way to toggle
// experimental features without code changes.

// Check whether the re-orient feature is disabled by the kill switch.
// Returns true when env.AGENT_MANAGER_REORIENT === 'false' (feature disabled).
// Returns false when the variable is absent or set to any other value (feature enabled).
//
// @param {object} [env=process.env] -- environment object to inspect; defaults to
//   process.env. Passed through for testability.
// @returns {boolean} true if the feature is disabled (kill switch off), false if enabled.
function isKillSwitchOff(env = process.env) {
  return env.AGENT_MANAGER_REORIENT === 'false';
}

module.exports = { isKillSwitchOff };
