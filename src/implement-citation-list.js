'use strict';

// Pure functions: no filesystem or model access.

// Source of truth for the allowed extensions: PATH_EXT_RE in src/fact-checker.js (line 29).
// src/implement-citation-list.test.js has a drift guard that fails if the two diverge.
const ALLOWED_EXTS = ['js', 'jsx', 'ts', 'tsx', 'py', 'json', 'md', 'csv'];

// Returns the normalized repo-relative path, or null if the hit must be dropped.
function normalizeHit(hit) {
  if (typeof hit !== 'string') return null;
  let p = hit.trim().replace(/\\/g, '/');
  if (p.startsWith('./')) p = p.slice(2);
  if (!p) return null;
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return null;
  if (p.split('/').some((seg) => seg === '..')) return null;
  const dot = p.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = p.slice(dot + 1);
  if (!ALLOWED_EXTS.includes(ext)) return null;
  return p;
}

function buildClosedCitationList(hits, { max } = {}) {
  const set = new Set();
  for (const hit of Array.isArray(hits) ? hits : []) {
    const p = normalizeHit(hit);
    if (p) set.add(p);
  }
  const sorted = [...set].sort();
  return Number.isInteger(max) && max > 0 ? sorted.slice(0, max) : sorted;
}

function renderAllowedCitationsBlock(list) {
  if (!Array.isArray(list) || list.length === 0) {
    return 'No files are available for citation: no file path may be cited.';
  }
  return ['Allowed citations (cite only these paths):', ...list.map((p) => `- ${p}`)].join('\n');
}

module.exports = { buildClosedCitationList, renderAllowedCitationsBlock };
