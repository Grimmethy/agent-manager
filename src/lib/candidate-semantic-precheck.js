'use strict';

// candidate-semantic-precheck.js -- pure pre-check: which new ### AC-N candidates look like entries that
// already exist. A candidate is flagged only when it shares at least one normalized Files: path with an
// existing entry AND the token Jaccard of title+body reaches the threshold. Shared files are a hard gate:
// similar wording over disjoint files is never flagged.
//
// Pure module: text in, data out. No file reads or writes, no timers, no process or network access.

const { normalizeFiles } = require('./candidate-dedupe');
const { STOPWORDS } = require('../text-similarity');

const DEFAULT_THRESHOLD = 0.5;
const MIN_TOKEN_LENGTH = 3;

// Same split as the dedupe module's entriesIn: each chunk starts at a "### AC-N" heading line.
function splitAcBlocks(text) {
  return String(text || '').split(/(?=^###\s*AC-\d+)/m).filter((b) => /^###\s*AC-\d+/.test(b));
}

// Same heading regex as entriesIn. Returns { id, title, files, body } or null when there is no heading.
// files is the raw Files: value (pass it through normalizeFiles before comparing).
function parseAcBlock(block) {
  const text = String(block || '');
  const head = text.match(/^###\s*(AC-\d+)\s*(?:[·:—-]\s*)?(.+)$/m);
  if (!head) return null;
  const filesMatch = text.match(/^Files:\s*(.+)$/m);
  const rest = text.slice(head.index + head[0].length);
  const body = rest
    .split(/\r?\n/)
    .filter((line) => !/^(Files|Symbol):/.test(line.trim()))
    .join('\n')
    .trim();
  return { id: head[1], title: head[2].trim(), files: filesMatch ? filesMatch[1].trim() : '', body };
}

// Lowercase, split on non-word characters, drop short tokens and stopwords. Returns a Set.
function tokenize(...parts) {
  const out = new Set();
  for (const part of parts) {
    for (const tok of String(part || '').toLowerCase().split(/\W+/)) {
      if (tok.length >= MIN_TOKEN_LENGTH && !STOPWORDS.has(tok)) out.add(tok);
    }
  }
  return out;
}

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

// Accepts raw doc/block strings or already-parsed { id, title, files, body } objects.
function toEntries(items) {
  const out = [];
  for (const item of items || []) {
    if (typeof item === 'string') {
      for (const block of splitAcBlocks(item)) {
        const parsed = parseAcBlock(block);
        if (parsed) out.push(parsed);
      }
    } else if (item && typeof item === 'object') {
      out.push(item);
    }
  }
  return out;
}

// newCandidates + existingEntries -> [{ candidate: { id }, matches: [{ existing: { id }, sharedFiles, jaccard }] }]
// Only candidates with at least one match are returned.
function precheckCandidates(newCandidates, existingEntries, { threshold = DEFAULT_THRESHOLD } = {}) {
  const candidates = toEntries(newCandidates);
  const existing = toEntries(existingEntries).map((e) => ({
    entry: e,
    files: new Set(normalizeFiles(e.files)),
    tokens: tokenize(e.title, e.body),
  }));
  const results = [];
  for (const c of candidates) {
    const cFiles = normalizeFiles(c.files);
    const cTokens = tokenize(c.title, c.body);
    const matches = [];
    for (const ex of existing) {
      const sharedFiles = cFiles.filter((f) => ex.files.has(f));
      if (sharedFiles.length === 0) continue;
      const score = jaccard(cTokens, ex.tokens);
      if (score >= threshold) matches.push({ existing: { id: ex.entry.id }, sharedFiles, jaccard: score });
    }
    if (matches.length > 0) results.push({ candidate: { id: c.id }, matches });
  }
  return results;
}

module.exports = { DEFAULT_THRESHOLD, precheckCandidates, parseAcBlock, splitAcBlocks, tokenize };
