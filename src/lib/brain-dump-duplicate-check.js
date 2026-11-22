'use strict';

// brain-dump-duplicate-check.js -- deterministic pre-queue duplicate check for brain-dump
// entries (2026-10-31, discard analysis: 13 brain-dump discards since 10-24 were 'superseded
// by the newer branch for the same entry', e.g. questforge DDL/store column mismatch filed
// twice producing two rival branches).
//
// Why (not just title dedupe): the classifier's possibleDuplicateOf field is a model call
// that misses real duplicates (root-caused 2026-09-16). A deterministic key on what the
// entry is ABOUT -- cited file paths + first identifier -- catches same-defect filings that
// the classifier didn't flag.
//
// Key = sorted normalized File:Identifier pairs. Same normalization as src/lib/candidate-dedupe.js:
//   - Files: strip backticks/quotes, strip relative ./, strip line-number suffixes, sort.
//   - Identifier: first backticked identifier in the entry text (or first candidate in
//     entry.rawText if no backticks), normalized (lowercase, strip parens).
// An entry with no cited paths and no identifier has no key and never matches (fail-open).
//
// Duplicate sources checked:
//   (a) An EARLIER or already-queued brain-dump entry in the same brain-dump.json with the same key (see checkBrainDumpEntries for the ordering rule).
//   (b) A pushed origin/agent/* branch in the target repo that changes a cited file AND the cited symbol (its diff against the default branch).
//
// Kill switch: AGENT_MANAGER_BRAIN_DUMP_DUPLICATE_CHECK=false (mirrors brain-dump-target-check).
// Escape hatch: entry.duplicateOverride === true (mirrors targetCheckOverride).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Backticked tokens that look like file paths in brain-dump text.
const PATH_RE = /`([A-Za-z0-9_][A-Za-z0-9_.\-/]*\.(?:js|mjs|cjs|ts|tsx|jsx|py|md|json|sh|ps1|html|css|ya?ml|toml|txt))(?::\d+(?:-\d+)?)?`/g;
// First backticked identifier in text (function/variable/class name).
const IDENT_RE = /`([A-Za-z_$][\w$]*)`/g;

function isEnabled(env = process.env) {
  return env.AGENT_MANAGER_BRAIN_DUMP_DUPLICATE_CHECK !== 'false';
}

function citedPaths(text) {
  const out = [];
  const src = String(text == null ? '' : text);
  PATH_RE.lastIndex = 0;
  let m;
  while ((m = PATH_RE.exec(src))) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

function firstIdentifier(text) {
  const src = String(text == null ? '' : text);
  IDENT_RE.lastIndex = 0;
  const m = IDENT_RE.exec(src);
  if (!m) return '';
  return m[1].replace(/\(\)$/, '').trim().toLowerCase();
}

function normalizeFilePath(p) {
  return String(p || '')
    .replace(/[`'"]/g, '')
    .replace(/^\.\//, '')
    .replace(/:\d+(?:-\d+)?$/, '')
    .trim()
    .toLowerCase();
}

// { citedPaths: string[], firstIdentifier: string } -> a stable string key, or null when
// the entry cannot be identified (no files or no identifier).
function normalizeBrainDumpKey(entry) {
  if (!entry) return null;
  const text = entry.rawText || entry.text || '';
  const cited = citedPaths(text);
  const ident = firstIdentifier(text);
  if (cited.length === 0 || !ident) return null;
  const normalized = cited.map(normalizeFilePath).filter(Boolean);
  if (normalized.length === 0) return null;
  // Sort paths for stability; pair each with the identifier.
  normalized.sort();
  return normalized.map((p) => `${p}:${ident}`).join('|');
}

const git = (repoRoot, args, timeout = 15_000) => execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });

// The default branch the unmerged branches are measured against: origin/main, else origin/master. null when neither exists.
function baseRef(repoRoot) {
  for (const ref of ['origin/main', 'origin/master']) {
    try { git(repoRoot, ['rev-parse', '--verify', '-q', ref]); return ref; } catch { /* try the next */ }
  }
  return null;
}

// -> string[] | null : the PUSHED agent/* branches (origin/agent/*, the ones the pipeline pushes and Unmerged Branches lists), or null on failure.
// Local refs/heads/agent/ is not enough: the apply clone pushes and deletes its local branch.
function unmergedAgentBranches(repoRoot) {
  try {
    return git(repoRoot, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin/agent/']).trim().split('\n').filter(Boolean).slice(0, 300);
  } catch {
    return null;
  }
}

// -> [{ file, touchesSymbol }] for every cited file the branch changes against `base`. touchesSymbol: the identifier appears in that file's diff
// (added or removed lines), i.e. the branch really changes this symbol, not merely the file. Fails open ([]) on any git error.
function branchTouchingFiles(repoRoot, branchRef, files, ident, base) {
  const fileSet = new Set(files.map(normalizeFilePath));
  if (fileSet.size === 0 || !base) return [];
  try {
    const changed = git(repoRoot, ['diff', '--name-only', `${base}...${branchRef}`]).trim().split('\n').filter(Boolean);
    const touched = changed.filter((f) => fileSet.has(normalizeFilePath(f)));
    const word = ident ? new RegExp(`(^|[^\\w$])${ident.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w$])`, 'i') : null;
    return touched.map((f) => {
      let touchesSymbol = false;
      try {
        const diff = git(repoRoot, ['diff', '-U0', `${base}...${branchRef}`, '--', f], 20_000);
        touchesSymbol = !!word && word.test(diff.split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l)).join('\n'));
      } catch { /* best-effort: file touched, symbol unknown */ }
      return { file: f, touchesSymbol };
    });
  } catch {
    return [];
  }
}

// An entry that is already queued (it has a task) or finished counts as the earlier work regardless of where it sits in the file.
function isQueuedWork(e) {
  return !!(e && (e.queuedTaskId || e.status === 'actioned'));
}

// Check brain-dump.json entries for a duplicate key.
// -> { isDuplicate: true, duplicateOf: string, source: 'brain-dump' } | null
//
// Which OTHER entries count as the original (2026-10-31 review fix: with "any other entry" two filings of one defect each reported the other
// as the duplicate and BOTH were parked, so neither was queued):
//   - an entry that is itself parked (duplicateOf set) never counts: it is not work in flight;
//   - an entry that is already queued/actioned always counts;
//   - otherwise only an entry that sits EARLIER in the file than this one counts (an entry not in the file yet counts everything else as earlier).
// So of two unqueued filings the first is queued and the second is parked behind it.
function checkBrainDumpEntries(entry, brainDumpPath) {
  if (!brainDumpPath) return null;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(brainDumpPath, 'utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(data.entries)) return null;
  const key = normalizeBrainDumpKey(entry);
  if (!key) return null;
  const myIdx = data.entries.findIndex((e) => e && e.id === entry.id);
  for (let i = 0; i < data.entries.length; i++) {
    const other = data.entries[i];
    if (!other || !other.id || other.id === entry.id) continue;
    if (other.duplicateOf) continue;
    if (!isQueuedWork(other) && !(myIdx === -1 || i < myIdx)) continue;
    if (normalizeBrainDumpKey(other) === key) return { isDuplicate: true, duplicateOf: other.id, source: 'brain-dump' };
  }
  return null;
}

// Check pushed agent/* branches in the repo for a duplicate: a branch that changes one of the cited files AND the cited symbol.
// -> { isDuplicate: true, duplicateOf: string, source: 'branch' } | null
function checkUnmergedBranches(entry, repoRoot) {
  if (!repoRoot) return null;
  const text = entry.rawText || entry.text || '';
  const cited = citedPaths(text);
  const ident = firstIdentifier(text);
  if (cited.length === 0 || !ident) return null;
  const base = baseRef(repoRoot);
  const branches = unmergedAgentBranches(repoRoot);
  if (!base || !branches) return null;
  for (const branch of branches) {
    if (branchTouchingFiles(repoRoot, branch, cited, ident, base).some((t) => t.touchesSymbol)) {
      return { isDuplicate: true, duplicateOf: branch.replace(/^origin\//, ''), source: 'branch' };
    }
  }
  return null;
}

// Main entry point. Returns null if no duplicate, or { isDuplicate: true, duplicateOf: string, source: 'brain-dump'|'branch', key: string }.
// Mutates entry.duplicateOf when a duplicate is found.
function checkBrainDumpDuplicate(entry, opts = {}) {
  const { brainDumpPath, repoRoot } = opts;
  if (!isEnabled()) return null;
  if (entry.duplicateOverride === true) return null;
  const key = normalizeBrainDumpKey(entry);
  if (!key) return null;
  const bdDup = checkBrainDumpEntries(entry, brainDumpPath);
  if (bdDup) {
    entry.duplicateOf = bdDup.duplicateOf;
    return { ...bdDup, key };
  }
  const branchDup = checkUnmergedBranches(entry, repoRoot);
  if (branchDup) {
    entry.duplicateOf = branchDup.duplicateOf;
    return { ...branchDup, key };
  }
  return null;
}

module.exports = {
  isEnabled,
  citedPaths,
  firstIdentifier,
  normalizeFilePath,
  normalizeBrainDumpKey,
  checkBrainDumpDuplicate,
  checkBrainDumpEntries,
  checkUnmergedBranches,
  unmergedAgentBranches,
  branchTouchingFiles,
};
