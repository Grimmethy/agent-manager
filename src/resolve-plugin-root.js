'use strict';

// Resolve a NAMED, enabled AGENT_MANAGER_REGISTER_PATH plugin's root directory (S5a of the
// hub-tasks extraction, 2026-09-25). Used by scripts/queue-watcher.sh to find a plugin's
// src/ dir by NAME, regardless of position or how many other plugins are also loaded.
//
// Corrects a real gap found scoping S5: the ORIGINAL resolution this generalizes,
// `dirname("${AGENT_MANAGER_REGISTER_PATH%%,*}")` (still inline in queue-watcher.sh before
// this module existed), only ever worked because it assumed whichever plugin needed
// resolving was the FIRST (or only) comma-separated entry -- true for
// agent-manager-hygiene when that trick was built, false the moment a second plugin
// (agent-manager-hub-tasks) needed the same treatment.
//
// Reads plugins-manifest.js's own readPluginsManifest() first (the canonical manifest,
// keyed by name) so a plugin is found regardless of load order; falls back to a substring
// match against AGENT_MANAGER_REGISTER_PATH's comma-separated list only when no manifest
// file exists at all -- the same back-compat rule plugins-manifest.js's own
// enabledRegisterPaths() already follows.

const path = require('path');
const { readPluginsManifest } = require('./plugins-manifest.js');

function resolvePluginRoot(pluginName) {
  if (!pluginName) return null;
  const manifest = readPluginsManifest();
  if (Array.isArray(manifest)) {
    const entry = manifest.find((p) => p && p.name === pluginName && p.enabled !== false && typeof p.registerPath === 'string' && p.registerPath.trim());
    return entry ? path.dirname(entry.registerPath.trim()) : null;
  }
  const fallback = (process.env.AGENT_MANAGER_REGISTER_PATH || '').split(',').map((s) => s.trim()).filter(Boolean);
  const registerPath = fallback.find((p) => p.includes(pluginName));
  return registerPath ? path.dirname(registerPath) : null;
}

if (require.main === module) {
  const root = resolvePluginRoot(process.argv[2]);
  if (root) console.log(root);
}

module.exports = { resolvePluginRoot };
