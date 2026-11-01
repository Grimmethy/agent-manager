'use strict';

// Named model-profile registry (2026-08-24, Grimmethy: "let's scope this refactor" --
// see the plan discussion this session for the full incident: switching `reviewer` to
// qwen2.5:3b for speed required threading a per-instance dashboard override through
// dashboard-settings.json -> refresh_active_model() (a shell function) -> LOCAL_MODEL env
// var -> local-client.js's module-load-time const, only taking effect on the daemon's
// NEXT outer tick -- not a per-task-source choice, and no clean way to say "this task
// source should use model X" at all). Mirrors task-source-registry.js's own
// register/get/clear shape on purpose -- that is this codebase's established convention
// for "named things with declared properties," not a new pattern.
//
// A profile is a named bundle of overrides handed to local-client.js's/claude-client.js's
// existing call()/majorityVote() functions -- `backend` picks which client module actually
// runs the call ('local' or 'claude'), everything else is passed straight through as an
// explicit override of that call's own existing optional params. Registering a profile
// has ZERO effect on its own -- see model-provider.js's resolveModelProfile() for how a
// task source opts in via its own registerTaskSource({modelProfile: 'name'}) flag, same
// convention emptyApproval/advisoryProse/candidateFulfillment already use.

const registry = {};
const fs = require('fs');
const path = require('path');

// Reads dashboard-settings.json from the package root (or AGENT_MANAGER_SETTINGS_PATH env var).
// `cachedDashboardSettings` is an optional pre-loaded value (object or JSON string). When provided,
// it is used instead of reading from disk. Any read or parse problem returns an empty object.
function readDashboardSettings(settingsPath, cachedDashboardSettings) {
  let parsed;
  if (cachedDashboardSettings !== undefined && cachedDashboardSettings !== null) {
    try {
      parsed = typeof cachedDashboardSettings === 'string' ? JSON.parse(cachedDashboardSettings) : cachedDashboardSettings;
    } catch (_) {
      return {};
    }
  } else {
    const settingsPathValue = settingsPath || process.env.AGENT_MANAGER_SETTINGS_PATH || path.join(__dirname, '..', 'dashboard-settings.json');
    try {
      parsed = JSON.parse(fs.readFileSync(settingsPathValue, 'utf8'));
    } catch (_) {
      return {};
    }
  }
  return (parsed && typeof parsed === 'object') ? parsed : {};
}

function registerModelProfile(name, config) {
  if (registry[name] !== undefined) {
    throw new Error(`Model profile "${name}" is already registered`);
  }
  registry[name] = { name, ...config };
}

function getModelProfile(name) {
  return registry[name] ?? undefined;
}

function clearModelProfileRegistry() {
  Object.keys(registry).forEach((key) => delete registry[key]);
}

module.exports = { registerModelProfile, getModelProfile, clearModelProfileRegistry, readDashboardSettings };
