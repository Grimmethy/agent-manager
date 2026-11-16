// Codebase-map matcher (HUB0528 · 1/3).
//
// Map row format, from docs/agents/codebase-map.md:
//   - Table rows: `| Label | cell | cell | ... |`. The label is the first cell with backticks
//     removed and any ` — description` tail cut. Cited paths are backticked tokens in any cell.
//   - Bullet rows: `- `path` — description`. The row text is the bullet with backticks removed.
//   - A citation may carry `:range`, `#symbol`, or `:range#symbol`. These suffixes are stripped.
//   - A bare filename resolves through resolveBareFilename in src/task-anchor-files.js.
//
// Pure and synchronous. Reads docs/agents/codebase-map.md under repoRoot and returns []
// when the file is missing or unreadable. The kill switch is owned by the caller.

const fs = require('fs');
const path = require('path');
const { resolveBareFilename } = require('./task-anchor-files.js');

const MAP_REL = 'docs/agents/codebase-map.md';
const MIN_TOKEN_LENGTH = 3;
const DEFAULT_MAX_FILES = 6;

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'when', 'what', 'where',
  'which', 'should', 'would', 'could', 'have', 'has', 'are', 'was', 'were', 'not', 'but',
  'its', 'also', 'make', 'add', 'file', 'files', 'code', 'task', 'change', 'update',
  'need', 'needs', 'use', 'using', 'read', 'all', 'any', 'each', 'just', 'than', 'then',
  'there', 'their', 'they', 'them', 'your', 'you', 'our', 'out', 'new', 'one', 'two',
]);

function tokenize(text) {
  const out = new Set();
  for (const word of String(text || '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (word.length < MIN_TOKEN_LENGTH || STOPWORDS.has(word)) continue;
    out.add(word);
  }
  return out;
}

function overlapCount(a, b) {
  let n = 0;
  for (const t of a) if (b.has(t)) n += 1;
  return n;
}

// Same containment rule as withinRoot() in src/task-anchor-files.js (not exported there).
function withinRoot(repoRoot, rel) {
  const root = path.resolve(repoRoot);
  const full = path.resolve(root, rel);
  return full.startsWith(root + path.sep) ? full : null;
}

// Turn one backticked citation into a validated repo-relative path, or null.
function citedPath(repoRoot, token) {
  let ref = String(token || '').trim().replace(/#.*$/, '').replace(/:\d+(?:-\d+)?$/, '');
  ref = ref.replace(/^\.\//, '');
  if (!ref || /\s/.test(ref) || !/\.[A-Za-z0-9]{1,5}$/.test(ref)) return null;
  let rel = ref;
  if (!ref.includes('/')) {
    try { rel = resolveBareFilename(repoRoot, ref); } catch { rel = null; }
    if (!rel) return null;
  }
  rel = String(rel).split(path.sep).join('/');
  if (!rel || rel.startsWith('/') || rel.split('/').includes('..')) return null;
  const full = withinRoot(repoRoot, rel);
  if (!full) return null;
  try { if (!fs.statSync(full).isFile()) return null; } catch { return null; }
  return rel;
}

// Parse the map into rows: { order, label, cited: [repo-relative paths] }.
function parseRows(repoRoot, md) {
  const rows = [];
  for (const line of md.split('\n')) {
    let label;
    if (/^\s*\|/.test(line)) {
      const cells = line.split('|').slice(1, -1).map((c) => c.trim());
      if (cells.length === 0 || /^:?-{2,}:?$/.test(cells[0])) continue; // separator row
      label = cells[0].replace(/`/g, '').split(' — ')[0];
    } else if (/^\s*[-*]\s+`/.test(line)) {
      label = line.replace(/^\s*[-*]\s+/, '').replace(/`/g, '');
    } else {
      continue;
    }
    const cited = [];
    for (const m of line.matchAll(/`([^`]+)`/g)) {
      const rel = citedPath(repoRoot, m[1]);
      if (rel && !cited.includes(rel)) cited.push(rel);
    }
    rows.push({ order: rows.length, label, cited });
  }
  return rows;
}

function basenameTokens(rel) {
  const base = String(rel).split('/').pop().replace(/\.[^.]+$/, '');
  return tokenize(base.replace(/[-_]/g, ' '));
}

// Pure: returns up to maxFiles repo-relative paths cited by the map rows that best
// overlap the task text. Returns [] when the map is missing or unreadable.
function matchCodebaseMap({ repoRoot, taskText, maxFiles } = {}) {
  if (!repoRoot) return [];
  const limit = Number.isInteger(maxFiles) && maxFiles > 0 ? maxFiles : DEFAULT_MAX_FILES;
  let md;
  try {
    md = fs.readFileSync(path.join(repoRoot, MAP_REL), 'utf8');
  } catch {
    return [];
  }
  const taskTokens = tokenize(taskText);
  if (taskTokens.size === 0) return [];

  const scored = [];
  for (const row of parseRows(repoRoot, md)) {
    if (row.cited.length === 0) continue;
    const labelHits = overlapCount(taskTokens, tokenize(row.label));
    let fileHits = 0;
    for (const rel of row.cited) fileHits += overlapCount(taskTokens, basenameTokens(rel));
    const score = labelHits + fileHits;
    if (score > 0) scored.push({ row, score });
  }
  scored.sort((a, b) => (b.score - a.score) || (a.row.order - b.row.order));

  const out = [];
  for (const { row } of scored) {
    for (const rel of row.cited) {
      if (out.length >= limit) return out;
      if (!out.includes(rel)) out.push(rel);
    }
  }
  return out;
}

module.exports = { matchCodebaseMap };
