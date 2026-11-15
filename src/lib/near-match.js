'use strict';

const fs = require('fs');
const path = require('path');

// Directories never descended into. Exact name match at any depth.
const SKIP_DIRS = new Set(['node_modules', '.git']);

// findNearMatches: given a missing repo-relative path and the repo root,
// returns the repo-relative paths (forward slashes, sorted) of every regular
// file whose basename equals the missing path's basename.
//
// Synchronous and one-shot: walks the tree once per call, starts no
// processes, uses no timers. Symbolic links are not followed (dirent.isFile()
// and dirent.isDirectory() are tested directly), so link cycles cannot loop.
// Returns [] when nothing matches or the input is unusable.
function findNearMatches(missingPath, repoRoot) {
  if (typeof missingPath !== 'string' || typeof repoRoot !== 'string' || !repoRoot) {
    return [];
  }
  // A trailing slash names a directory, not a file; path.basename would
  // silently strip it, so reject it explicitly.
  if (missingPath === '' || /[\\/]$/.test(missingPath)) {
    return [];
  }
  const base = path.basename(missingPath);
  if (!base) {
    return [];
  }

  const matches = [];
  walk(repoRoot, repoRoot, base, matches);
  return matches.sort();
}

function walk(root, dir, base, matches) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    // Unreadable subdirectory: skip it. Unreadable root: surface the error.
    if (dir === root) {
      throw err;
    }
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }
      walk(root, fullPath, base, matches);
    } else if (entry.isFile() && entry.name === base) {
      matches.push(path.relative(root, fullPath).split(path.sep).join('/'));
    }
  }
}

module.exports = { findNearMatches };
