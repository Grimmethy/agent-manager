'use strict';

// Content-overlap check for the review step (2026-10-24, discard analysis).
//
// Why: python/dashboard/branch_redundancy.py and branch_verdicts.py only notice a patch-id match with master or a rival that CONFLICTS. A branch that
// re-creates work already on another unmerged branch passes review and apply and is discarded by hand later (case: three modules copied byte-for-byte
// from a sibling hub stack: drive_log.py and turn_cancel.py identical, drive_links.py an older copy).
//
// What: for a unified diff, find (a) a NEW file whose full content equals a file with the same path or basename on another unmerged remote branch or on
// the base ('identical-file'), and (b) a file whose added lines are mostly (>= 80%) also added by another unmerged branch against the same base
// ('added-lines'). Test files, lockfiles and docs are ignored. Lines the same diff also REMOVES are not counted (a moved or reformatted block is not a
// duplicate). Read-only git only; never throws: any lookup failure means 'no overlap found'.

const path = require('path');
const { execFileSync } = require('child_process');
const { isTestPath } = require('./review-inert.js');

const MAX_REFS = 60;
const MIN_MEANINGFUL_LINES = 8;
const MIN_RATIO = 0.8;
const MAX_OVERLAPS = 12;
const IGNORED_RE = /(^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Pipfile\.lock|node_modules\/)|\.(?:lock|md|txt|rst)$|(^|\/)docs?\//i;

function isIgnoredPath(file) { return isTestPath(file) || IGNORED_RE.test(String(file || '')); }

// A line that carries content: long enough, not only punctuation/braces, not a comment line.
function meaningful(line) {
  const t = String(line == null ? '' : line).trim();
  if (t.length < 8) return null;
  if (/^(?:\/\/|#|\*|\/\*|<!--)/.test(t)) return null;
  if (!/[A-Za-z0-9]/.test(t)) return null;
  return t.replace(/\s+/g, ' ');
}

// Per file: { file, isNew, isDeleted, added: [text], removed: [text] } from a unified diff (works for --unified=0 too).
function parseAddedRemoved(diff) {
  const files = [];
  for (const chunk of String(diff || '').split(/^(?=diff --git )/m)) {
    const head = chunk.match(/^diff --git a\/(\S+) b\/(\S+)/);
    if (!head || /^(?:Binary files|GIT binary patch)/m.test(chunk)) continue;
    const first = chunk.search(/^@@ /m);
    const header = first < 0 ? chunk : chunk.slice(0, first);
    const e = { file: head[2], isNew: /^new file mode/m.test(header), isDeleted: /^deleted file mode/m.test(header), added: [], removed: [] };
    if (first >= 0) {
      for (const hunk of chunk.slice(first).split(/^(?=@@ )/m)) {
        for (const line of hunk.split('\n').slice(1)) {
          if (line.startsWith('\\')) continue;
          if (line.startsWith('+')) e.added.push(line.slice(1));
          else if (line.startsWith('-')) e.removed.push(line.slice(1));
        }
      }
    }
    files.push(e);
  }
  return files;
}

function defaultGit(repoRoot) {
  return (args) => execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', timeout: 20_000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
}

function normFile(text) { return String(text).replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n+$/, ''); }

// Remote branches NOT merged into baseRef, newest first (one git call), minus HEAD, the base itself and `ownRefs`.
function candidateRefs(git, baseRef, ownRefs, maxRefs) {
  let out = '';
  try { out = git(['for-each-ref', `--no-merged=${baseRef}`, '--sort=-committerdate', '--format=%(refname:short)', 'refs/remotes/origin']); } catch { return []; }
  const skip = new Set([baseRef, ...ownRefs]);
  return out.split('\n').map((s) => s.trim()).filter((r) => r && !r.endsWith('/HEAD') && !skip.has(r)).slice(0, maxRefs);
}

// { overlaps: [{ file, ref, how: 'identical-file' | 'added-lines', ratio, otherFile? }], checkedRefs }
function findContentOverlap({ rawDiff, repoRoot, baseRef, ownRefs = [], git = null, maxRefs = MAX_REFS } = {}) {
  const empty = { overlaps: [], checkedRefs: 0 };
  try {
    const run = git || defaultGit(repoRoot);
    if (!baseRef) return empty;
    const all = parseAddedRemoved(rawDiff);
    const removedLines = new Set(all.flatMap((f) => f.removed.map(meaningful).filter(Boolean)));
    const files = all.filter((f) => !f.isDeleted && !isIgnoredPath(f.file)).map((f) => ({
      ...f,
      text: normFile(f.added.join('\n')),
      lines: [...new Set(f.added.map(meaningful).filter(Boolean))].filter((l) => !removedLines.has(l)),
    })).filter((f) => f.lines.length >= MIN_MEANINGFUL_LINES);
    if (!files.length) return empty;

    const overlaps = [];
    const seen = new Set();
    const push = (o) => { const k = `${o.file}|${o.ref}`; if (!seen.has(k) && overlaps.length < MAX_OVERLAPS) { seen.add(k); overlaps.push(o); } };
    const treeCache = new Map();
    const tree = (ref) => { if (!treeCache.has(ref)) { try { treeCache.set(ref, run(['ls-tree', '-r', '--name-only', ref]).split('\n').filter(Boolean)); } catch { treeCache.set(ref, []); } } return treeCache.get(ref); };
    const identicalOn = (f, ref) => {
      const base = path.basename(f.file);
      const names = tree(ref).filter((p) => p === f.file || path.basename(p) === base).slice(0, 8);
      for (const p of names) {
        let content; try { content = run(['show', `${ref}:${p}`]); } catch { continue; }
        if (normFile(content) === f.text) return p;
      }
      return null;
    };

    // New files identical to a file already on the base (any path with the same basename).
    for (const f of files) {
      if (!f.isNew) continue;
      const hit = identicalOn(f, baseRef);
      if (hit) push({ file: f.file, ref: baseRef, how: 'identical-file', ratio: 1, otherFile: hit });
    }

    const refs = candidateRefs(run, baseRef, ownRefs, maxRefs);
    for (const ref of refs) {
      for (const f of files) {
        if (f.isNew) {
          const hit = identicalOn(f, ref);
          if (hit) { push({ file: f.file, ref, how: 'identical-file', ratio: 1, otherFile: hit }); continue; }
        }
      }
      let theirs;
      try { theirs = parseAddedRemoved(run(['diff', '--unified=0', `${baseRef}...${ref}`, '--', ...files.map((f) => f.file)])); } catch { continue; }
      for (const f of files) {
        if (seen.has(`${f.file}|${ref}`)) continue;
        const other = theirs.find((t) => t.file === f.file);
        if (!other) continue;
        const otherSet = new Set(other.added.map(meaningful).filter(Boolean));
        const shared = f.lines.filter((l) => otherSet.has(l)).length;
        const ratio = shared / f.lines.length;
        if (ratio >= MIN_RATIO) push({ file: f.file, ref, how: 'added-lines', ratio: Math.round(ratio * 100) / 100 });
      }
    }
    return { overlaps, checkedRefs: refs.length };
  } catch {
    return empty;
  }
}

// --- as the voters and the history see it (used by review-task.js) ---------------------------------------------------------------------------------
// findContentOverlap (above) finds new files identical to a file on another unmerged branch or on the base, and files whose added lines are mostly also added by another
// unmerged branch. A branch that re-creates work already sitting elsewhere was approved and discarded by hand later.
// AGENT_MANAGER_REVIEW_OVERLAP_CHECK: 'false' = off, 'block' = a deterministic block, anything else (default) = evidence for the voters only.
const OVERLAP_MAX_ITEMS = 6;

function summariseContentOverlap(r) {
  const n = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  const list = Array.isArray(r && r.overlaps) ? r.overlaps : [];
  return {
    at: new Date().toISOString(), checkedRefs: n(r && r.checkedRefs), total: list.length,
    overlaps: list.slice(0, OVERLAP_MAX_ITEMS).map((o) => ({
      file: String((o && o.file) || '').slice(0, 160), ref: String((o && o.ref) || '').slice(0, 200),
      how: o && o.how === 'identical-file' ? 'identical-file' : 'added-lines',
      ratio: Number.isFinite(o && o.ratio) ? Math.min(1, Math.max(0, Math.round(o.ratio * 100) / 100)) : 0,
      otherFile: String((o && o.otherFile) || '').slice(0, 160),
    })),
  };
}

function overlapWhere(o) {
  return o.how === 'identical-file'
    ? `${o.file} is identical to ${o.otherFile || 'a file'} on ${o.ref}`
    : `${Math.round(o.ratio * 100)}% of the lines added to ${o.file} are also added on ${o.ref}`;
}

function contentOverlapBlockReason(summary) {
  const items = (summary && summary.overlaps) || [];
  return `Deterministic gate: content overlap -- this draft re-creates work that already exists elsewhere: ${items.map(overlapWhere).join('; ')}. Do not add a second copy: build on or wait for that branch, or explain in the task why a separate copy is needed.`;
}

function formatContentOverlapSection(co) {
  if (!co || typeof co !== 'object' || !Array.isArray(co.overlaps) || !co.overlaps.length) return '';
  const more = co.total > co.overlaps.length ? ` (+${co.total - co.overlaps.length} more)` : '';
  return [
    '--- Content already on another branch or on the base (deterministic check; advisory) ---',
    `The harness compared the diff with ${co.checkedRefs} other unmerged remote branch(es) and with the base. ${co.overlaps.map(overlapWhere).join('; ')}${more}.`,
    'Unless the task text says this copy is intended (for example a deliberate move of a hub slice), ask whether this draft duplicates work that is already waiting to merge: it would conflict with, or be discarded in favour of, that branch. This is evidence to weigh, not a verdict.',
  ].join('\n');
}

module.exports = { summariseContentOverlap, formatContentOverlapSection, contentOverlapBlockReason, findContentOverlap, parseAddedRemoved, meaningful, isIgnoredPath, candidateRefs, MAX_REFS, MIN_MEANINGFUL_LINES, MIN_RATIO };
