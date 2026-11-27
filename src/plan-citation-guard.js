'use strict';
/**
 * plan-citation-guard.js: pure helpers that classify a plan's cited file paths
 * as existing or missing under a repo root.
 *
 * classifyCitations skips declared create targets before any filesystem check,
 * so a file the plan intends to create is never reported as missing.
 * toCreateEntries rewrites missing paths as explicit {type:'create', path}
 * declarations so the plan pass can declare new files.
 *
 * No state, no timers, no model calls.
 */

const fs = require('fs');
const path = require('path');

function normalizePath(p) {
  return String(p).replace(/^\.\//, '');
}

// createTargets may be plain path strings or {type:'create', path} declarations.
// Objects are mapped to their .path; anything else is ignored.
function createTargetSet(createTargets) {
  const set = new Set();
  for (const t of createTargets || []) {
    const p = typeof t === 'string' ? t : (t && t.path);
    if (typeof p === 'string') set.add(normalizePath(p));
  }
  return set;
}

/**
 * Returns { existing, missing }. Declared create targets are omitted from both
 * lists and are never passed to fs.existsSync.
 */
function classifyCitations(citedPaths, repoRoot, createTargets) {
  const creates = createTargetSet(createTargets);
  const existing = [];
  const missing = [];
  for (const raw of citedPaths || []) {
    const p = normalizePath(raw);
    if (creates.has(p)) continue;
    if (fs.existsSync(path.join(repoRoot, p))) existing.push(p);
    else missing.push(p);
  }
  return { existing, missing };
}

/** Maps each missing path to an explicit create-mode declaration. No filesystem access. */
function toCreateEntries(missing) {
  return (missing || []).map((p) => ({ type: 'create', path: p }));
}

module.exports = { classifyCitations, toCreateEntries };
