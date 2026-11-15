'use strict';

// Pure helper: materialize a plan's declared create targets as empty files.
// Only creates missing files (flag 'wx'); an existing file is never truncated.
// Paths are resolved lexically and must stay inside root.

const fs = require('fs');
const path = require('path');

// (root, rel) -> absolute path inside root. Throws on absolute paths, empty input, or any escape from root.
function resolveInRepo(root, rel) {
  if (typeof rel !== 'string' || rel.length === 0) {
    throw new Error('resolveInRepo: path must be a non-empty string');
  }
  if (path.isAbsolute(rel)) {
    throw new Error('resolveInRepo: absolute path rejected: ' + rel);
  }
  const base = path.resolve(root);
  const abs = path.resolve(base, rel);
  const relToRoot = path.relative(base, abs);
  if (
    relToRoot === '' ||
    relToRoot === '..' ||
    relToRoot.startsWith('..' + path.sep) ||
    path.isAbsolute(relToRoot)
  ) {
    throw new Error('resolveInRepo: path escapes repo root: ' + rel);
  }
  return abs;
}

// plan -> array of relative paths declared as create targets.
// Accepts plan.targets entries of {type:'create', path} and plan.createTargets entries of string or {path}.
function collectCreateTargets(plan) {
  const out = [];
  if (!plan || typeof plan !== 'object') return out;
  if (Array.isArray(plan.targets)) {
    for (const entry of plan.targets) {
      if (entry && entry.type === 'create' && typeof entry.path === 'string') out.push(entry.path);
    }
  }
  if (Array.isArray(plan.createTargets)) {
    for (const entry of plan.createTargets) {
      if (typeof entry === 'string') out.push(entry);
      else if (entry && typeof entry.path === 'string') out.push(entry.path);
    }
  }
  return out;
}

// (root, plan) -> { created: [rel], existed: [rel] }
// Only EEXIST is swallowed; any other error (ENOTDIR, EACCES, EROFS, ...) propagates.
function materializeDeclaredCreateTargets(root, plan) {
  const created = [];
  const existed = [];
  for (const rel of collectCreateTargets(plan)) {
    const abs = resolveInRepo(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    try {
      fs.writeFileSync(abs, '', { flag: 'wx' });
      created.push(rel);
    } catch (err) {
      if (err && err.code === 'EEXIST') existed.push(rel);
      else throw err;
    }
  }
  return { created, existed };
}

module.exports = { materializeDeclaredCreateTargets, resolveInRepo };
