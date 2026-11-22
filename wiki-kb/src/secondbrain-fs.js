'use strict';

// Reads Second Brain markdown notes from a vault directory passed in by the caller.
// No config, no environment lookup, no caching, no watchers, no timers. Every call
// reads the disk fresh.

const fs = require('node:fs');
const path = require('node:path');

// Same exclusions as walk_note_files in python/build_note_graph.py.
const EXCLUDE_DIRS = new Set([
  '.git', '.obsidian', '.trash', 'node_modules', '__pycache__', '.cache',
]);

// Returns every .md note under `dir` as a forward-slash path relative to `dir`,
// e.g. "projects/Plan.md". Dot-directories and EXCLUDE_DIRS are skipped.
function listPages(dir) {
  const root = path.resolve(dir);
  const out = [];
  const walk = (abs) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (EXCLUDE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        walk(path.join(abs, entry.name));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        out.push(path.relative(root, path.join(abs, entry.name)).split(path.sep).join('/'));
      }
    }
  };
  walk(root);
  return out.sort();
}

// Reads one note by its relative path (as returned by listPages). Refuses any path
// that resolves outside `dir`.
function readPage(dir, relPath) {
  const root = path.resolve(dir);
  const abs = path.resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`page path escapes vault: ${relPath}`);
  }
  return fs.readFileSync(abs, 'utf8');
}

module.exports = { listPages, readPage };
