'use strict';

const fs = require('fs');
const path = require('path');

// Pure cited-path grounding. No timers, no model calls: every function runs
// only when called and touches the filesystem through read-only APIs.

const CITE_RE = /^([A-Za-z0-9_./-]+\.(?:js|py|md|json))(?::[\d,\s-]+)?(?:#[A-Za-z_][\w$]*)?$/;

// A create target is a path the task says it will CREATE ("create `x.js`",
// "write the file `x.js`", "generate x.md"). Such paths are excluded from the
// existence check because they are not expected to exist yet.
const CREATE_RE = /\b(?:create|write|generate|author)\s+(?:the\s+|a\s+|an\s+|new\s+|file\s+|at\s+|named\s+)*`?([A-Za-z0-9_./-]+\.(?:js|py|md|json))`?/gi;

function taskText(task) {
  if (typeof task === 'string') return task;
  if (!task || typeof task !== 'object') return '';
  return [task.title, task.rawText, task.description, task.plan]
    .filter((s) => typeof s === 'string')
    .join('\n');
}

// Returns [{ path, create }] in first-seen order, without duplicates.
function extractCitedPaths(task) {
  const text = taskText(task);
  const createSet = new Set();
  for (const m of text.matchAll(CREATE_RE)) createSet.add(m[1]);

  const seen = new Map();
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const cite = CITE_RE.exec(m[1].trim());
    if (!cite) continue;
    const p = cite[1];
    if (!seen.has(p)) seen.set(p, { path: p, create: createSet.has(p) });
  }
  return [...seen.values()];
}

function normalizeEntry(entry) {
  if (typeof entry === 'string') return { path: entry, create: false };
  return { path: entry.path, create: entry.create === true };
}

// Returns the non-create paths that do not exist under repoRoot.
function verifyPaths(repoRoot, paths) {
  const missing = [];
  for (const raw of paths || []) {
    const { path: p, create } = normalizeEntry(raw);
    if (create) continue;
    const abs = path.resolve(repoRoot, p);
    if (!fs.existsSync(abs)) missing.push(p);
  }
  return missing;
}

function walkFiles(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      walkFiles(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

// Exact, case-sensitive basename match. Succeeds only for a unique match.
// Returns { ok: true, path } or { ok: false, reason, candidates }.
function regroundPath(repoRoot, missingPath) {
  const target = path.basename(missingPath);
  const matches = walkFiles(repoRoot, [])
    .filter((f) => path.basename(f) === target)
    .map((f) => path.relative(repoRoot, f).split(path.sep).join('/'))
    .sort();
  if (matches.length === 1) return { ok: true, path: matches[0] };
  return {
    ok: false,
    reason: matches.length === 0 ? 'no-match' : 'ambiguous',
    candidates: matches,
  };
}

// harnessHits (optional): object mapping a cited path to a repo-relative path
// the harness already resolved it to. Used only when that target exists.
function resolveGrounding(task, repoRoot, { harnessHits } = {}) {
  const cited = extractCitedPaths(task);
  const missing = verifyPaths(repoRoot, cited);
  const resolved = {};
  const unresolved = [];

  for (const p of missing) {
    const hint = harnessHits && typeof harnessHits === 'object' ? harnessHits[p] : undefined;
    if (typeof hint === 'string' && fs.existsSync(path.resolve(repoRoot, hint))) {
      resolved[p] = hint;
      continue;
    }
    const r = regroundPath(repoRoot, p);
    if (r.ok) resolved[p] = r.path;
    else unresolved.push({ path: p, reason: r.reason, candidates: r.candidates });
  }

  return { cited, missing, resolved, unresolved };
}

module.exports = { extractCitedPaths, verifyPaths, regroundPath, resolveGrounding };
