'use strict';

// Grounding candidates for draft-time path suggestion. Given a task text and
// a repo root, list tracked files, rank them by how much their path and
// basename overlap with the text, and return the top-N. Also exports helpers
// for parsing citation strings (`Files:` line values) and stripping the
// common `./` / `:N` / `:N-M` citation noise.
//
// The file list is cached in-process keyed on (repoRoot, HEAD). Repeated
// drafts over the same repo don't respawn the git command. Non-git
// directories and repos without commits are never cached.
//
// No model calls, no git writes, no timers.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const NO_SUPPORTING_FILE = '__NO_SUPPORTING_FILE__';

const FILE_EXTENSIONS = [
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'md', 'json',
  'sh', 'ps1', 'html', 'css', 'yaml', 'yml', 'toml', 'txt',
  'rs', 'go', 'rb', 'java', 'c', 'cpp', 'h', 'hpp', 'swift',
  'kt', 'kts', 'scala', 'r', 'lua', 'sql', 'graphql', 'gql',
  'vue', 'svelte', 'astro', 'mdx',
];

// Tokens: lowercase word chars, split on non-word and path separators.
function tokenize(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// Token overlap score between two arrays, as a fraction of the query side.
function tokenOverlap(queryTokens, candidateTokens) {
  if (!queryTokens.length) return 0;
  const set = new Set(candidateTokens);
  let hits = 0;
  for (const t of queryTokens) {
    if (set.has(t)) hits += 1;
  }
  return hits / queryTokens.length;
}

// Cache: (repoRoot, HEAD) -> [file, ...]
const fileCache = new Map();

function getHead(repoRoot) {
  try {
    const out = execFileSync(
      'git',
      ['-C', repoRoot, 'rev-parse', '--short', 'HEAD'],
      { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 * 1024 }
    ).trim();
    if (!out) return null;
    return out;
  } catch {
    return null;
  }
}

function listTrackedFiles(repoRoot) {
  const head = getHead(repoRoot);
  const cacheKey = head ? `${repoRoot}\u0000${head}` : null;
  if (cacheKey && fileCache.has(cacheKey)) {
    return fileCache.get(cacheKey);
  }
  let tracked;
  try {
    const raw = execFileSync(
      'git',
      ['-C', repoRoot, 'ls-files', '-z'],
      { encoding: 'utf8', timeout: 15_000, maxBuffer: 256 * 1024 * 1024 }
    );
    tracked = raw.split('\0').filter(Boolean);
  } catch {
    // Fall back to a bounded readdirSync walk when git ls-files fails
    // (e.g. not a git repo, unreadable). Never cached.
    tracked = listDirSync(repoRoot);
  }
  if (cacheKey) fileCache.set(cacheKey, tracked);
  return tracked;
}

function listDirSync(root, depth = 0, base = root) {
  if (depth > 12) return [];
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isFile()) out.push(path.relative(base, full));
    else if (e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.')) {
      out.push(...listDirSync(full, depth + 1, base));
    }
  }
  return out;
}

// Rank a list of files by overlap with the task text and extra terms.
// Returns [{ path, score }] sorted descending.
function rankFiles(tracked, taskText, extraTerms) {
  const text = String(taskText || '');
  const textTokens = tokenize(text);
  const extraTokens = tokenize(extraTerms.join(' '));
  const allQuery = textTokens.length ? [...new Set([...textTokens, ...extraTokens])] : textTokens;

  const scored = tracked.map((file) => {
    const parts = file.split('/');
    const basename = parts[parts.length - 1];
    const baseTokens = tokenize(basename);
    const dirTokens = tokenize(parts.slice(0, -1).join('/'));
    const allFileTokens = [...dirTokens, ...baseTokens];

    const dirScore = tokenOverlap(allQuery, dirTokens);
    const baseScore = tokenOverlap(allQuery, baseTokens);
    // Basename matches weighted 3x; directory matches weighted 1x.
    const score = dirScore + baseScore * 3;
    return { path: file, score };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.path.localeCompare(b.path);
  });
  return scored;
}

// listGroundingCandidates(repoRoot, taskText, { max, extraTerms }) -> [{ path, score }]
function listGroundingCandidates(repoRoot, taskText, opts = {}) {
  const max = opts.max == null ? 40 : Math.max(0, opts.max | 0);
  const extraTerms = Array.isArray(opts.extraTerms) ? opts.extraTerms : [];
  const tracked = listTrackedFiles(repoRoot);
  const ranked = rankFiles(tracked, taskText, extraTerms);
  if (max === 0) return [];
  return ranked.slice(0, max);
}

// normaliseCitedPath(p) -> string
// Strips a leading ./ and a trailing :N or :N-M citation suffix.
function normaliseCitedPath(p) {
  if (typeof p !== 'string') return '';
  let s = p.trim();
  if (s.startsWith('./')) s = s.slice(2);
  // Strip :N or :N-M suffix (line or line range).
  s = s.replace(/:\d+(?:-\d+)?$/, '');
  return s;
}

// parseCitation(entry) -> { path?, type? }
// Parses one comma-separated entry of a "Files:" line value.
// Recognises:
//   - `create <path>` (optionally quoted/backticked)
//   - `NO_SUPPORTING_FILE` sentinel
//   - Bare path (treated as type: 'use')
function parseCitation(entry) {
  if (typeof entry !== 'string') return {};
  const s = entry.trim();
  if (!s) return {};

  // Sentinel.
  if (s === NO_SUPPORTING_FILE || s.toLowerCase() === 'no_supporting_file') {
    return { type: 'no_supporting_file' };
  }

  // `create <path>` with optional quotes/backticks.
  const createMatch = s.match(/^create\s+(?:"([^"]+)"|'([^']+)'|`([^`]+)`|(\S+))$/i);
  if (createMatch) {
    const raw = createMatch[1] ?? createMatch[2] ?? createMatch[3] ?? createMatch[4];
    if (raw) return { path: normaliseCitedPath(raw), type: 'create' };
  }

  // Bare path -- treat as 'use' (existing file being referenced).
  const stripped = normaliseCitedPath(s);
  if (stripped) return { path: stripped, type: 'use' };
  return {};
}

module.exports = {
  listGroundingCandidates,
  normaliseCitedPath,
  parseCitation,
  NO_SUPPORTING_FILE,
  _clearCache() { fileCache.clear(); },
  _stats() { return { cached: fileCache.size }; },
};
