'use strict';

const fs = require('fs');

// Resolve a path to its canonical form and strip trailing separators
// (the bare root "/" is left intact). Returns null if the path cannot be
// resolved, so callers can fail closed instead of throwing.
function normalize(p) {
  if (typeof p !== 'string' || p.length === 0) return null;
  let real;
  try {
    real = fs.realpathSync(p);
  } catch (err) {
    return null;
  }
  let out = real;
  while (out.length > 1 && out.endsWith('/')) {
    out = out.slice(0, -1);
  }
  return out;
}

// Returns true when the running root is an allowed owner of a source.
// - No owner list declared (undefined, null, or empty): true, so unscoped
//   legacy sources keep today's behavior.
// - Otherwise: true only on exact equality between the normalized running
//   root and a normalized owner. An unresolvable running root or owner
//   never matches (fail closed).
function ownerAllows(runningRoot, owners) {
  if (owners === undefined || owners === null) return true;
  if (!Array.isArray(owners)) return false;
  if (owners.length === 0) return true;

  const root = normalize(runningRoot);
  if (root === null) return false;

  for (const owner of owners) {
    const norm = normalize(owner);
    if (norm !== null && norm === root) return true;
  }
  return false;
}

module.exports = { ownerAllows };
