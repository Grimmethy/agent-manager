'use strict';

// Absolute agent-manager symlink helper (HUB0438 3/4). Creates nodeModulesDir/agent-manager
// as a symlink whose target is the absolute core checkout path, or creates nothing.
// Never creates a dangling link: the target must be an existing directory before symlinkSync runs.
// Existing entries at the link path are never overwritten.

const fs = require('fs');
const path = require('path');

function skipped(message) {
  return { status: 'skipped', message };
}

function linkAgentManager(nodeModulesDir, coreCheckoutAbs) {
  if (typeof coreCheckoutAbs !== 'string' || !path.isAbsolute(coreCheckoutAbs)) {
    return skipped(`core checkout is not an absolute path: ${String(coreCheckoutAbs)}`);
  }
  if (!fs.existsSync(coreCheckoutAbs)) {
    return skipped(`core checkout does not exist: ${coreCheckoutAbs}`);
  }
  // Must be a directory, not a regular file: the spec asks for an existing absolute directory.
  if (!fs.statSync(coreCheckoutAbs).isDirectory()) {
    return skipped(`core checkout is not a directory: ${coreCheckoutAbs}`);
  }
  if (typeof nodeModulesDir !== 'string' || !fs.existsSync(nodeModulesDir) || !fs.statSync(nodeModulesDir).isDirectory()) {
    return skipped(`node_modules directory does not exist: ${String(nodeModulesDir)}`);
  }

  const linkPath = path.join(nodeModulesDir, 'agent-manager');
  try {
    fs.lstatSync(linkPath);
    // Something already exists at the link path; do not overwrite it.
    return skipped(`${linkPath} already exists; not overwritten`);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      return skipped(`could not inspect ${linkPath}: ${err.message}`);
    }
  }

  try {
    fs.symlinkSync(coreCheckoutAbs, linkPath, 'dir');
  } catch (err) {
    return skipped(`could not create symlink ${linkPath}: ${err.message}`);
  }
  return { status: 'created', message: `${linkPath} -> ${coreCheckoutAbs}` };
}

module.exports = { linkAgentManager };
