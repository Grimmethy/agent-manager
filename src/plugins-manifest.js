'use strict';

// The plugin manifest: which AGENT_MANAGER_REGISTER_PATH plugins are installed and which
// are currently enabled. A plain JSON array beside agent-manager.env (the package root):
//
//   [
//     { "name": "agent-manager-hygiene",
//       "registerPath": "/abs/path/to/agent-manager-hygiene/register.js",
//       "enabled": true,
//       "description": "observability / performance / function-length / arch / unused-export" }
//   ]
//
// The dashboard's Plugins tab reads and writes this file directly (Python side); this
// module is the JS-side reader that config.js's ensureRegistered() consults. The file
// format is the contract between the two.
//
// Back-compat: if the manifest file does not exist, readPluginsManifest() returns null and
// ensureRegistered() falls back to splitting AGENT_MANAGER_REGISTER_PATH exactly as before.
// An existing-but-empty manifest ([]) means "no plugins" and is respected (no fallback).

const fs = require('fs');
const path = require('path');

const PLUGINS_MANIFEST_PATH = process.env.AGENT_MANAGER_PLUGINS_MANIFEST
  || path.join(__dirname, '..', 'plugins.json');

// Returns the parsed array, or null when there is no usable manifest (missing file,
// unreadable, or not a JSON array). null is the signal to fall back to the env var.
function readPluginsManifest() {
  let raw;
  try {
    raw = fs.readFileSync(PLUGINS_MANIFEST_PATH, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// The register.js paths that should actually be require()d, in manifest order. An entry is
// loaded unless it explicitly sets enabled:false; a blank/absent registerPath is skipped.
function enabledRegisterPaths(manifest) {
  if (!Array.isArray(manifest)) return [];
  return manifest
    .filter((p) => p && typeof p.registerPath === 'string' && p.registerPath.trim() && p.enabled !== false)
    .map((p) => p.registerPath.trim());
}

module.exports = { PLUGINS_MANIFEST_PATH, readPluginsManifest, enabledRegisterPaths };
