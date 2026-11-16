'use strict';

// Pure task-repo root resolver (HUB0438 1/4). No I/O: string and path work only.
// Scans task text for absolute paths and returns those that exactly match a caller-supplied
// registry list. Unregistered paths are dropped silently. The result is read-only by contract:
// nothing here grants or implies write access, and the caller owns registry reading.

const path = require('path');

// A candidate starts at a '/' that is at start-of-string or follows whitespace, a quote,
// a backtick, or an opening bracket. It runs until whitespace or a closing delimiter.
const ABS_PATH_RE = /(^|[\s"'`(\[])(\/[^\s"'`)\]}<>,;]+)/g;

function stripTrailingPunct(s) {
  return s.replace(/[.:!?]+$/, '');
}

function taskReadOnlyRoots(taskText, registeredRepoPaths) {
  if (typeof taskText !== 'string' || !Array.isArray(registeredRepoPaths)) return [];

  const registered = new Set();
  for (const p of registeredRepoPaths) {
    if (typeof p === 'string' && p.trim() !== '' && path.isAbsolute(p)) {
      registered.add(path.resolve(p));
    }
  }
  if (registered.size === 0) return [];

  const out = [];
  const seen = new Set();
  const re = new RegExp(ABS_PATH_RE.source, 'g');
  let m;
  while ((m = re.exec(taskText)) !== null) {
    const candidate = stripTrailingPunct(m[2]);
    if (!path.isAbsolute(candidate)) continue;
    const resolved = path.resolve(candidate);
    if (registered.has(resolved) && !seen.has(resolved)) {
      seen.add(resolved);
      out.push(resolved);
    }
  }
  return out;
}

module.exports = { taskReadOnlyRoots };
