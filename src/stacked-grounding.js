'use strict';

// One shared answer to "which git ref actually represents this task's real world" --
// 2026-09-08, root-caused live: a stacked file-decompose wiring task's drafting worktree
// was built from origin/<mainBranch>, never task.stacked.branch, so it couldn't see a
// sibling's already-committed work still sitting only on the shared (not-yet-merged)
// stacked branch and wrongly reported a real file as "absent." Auditing turned up the same
// missing concept independently repeated at 5 call sites (agentic-draft-common.js,
// plan-grounding.js/task-anchor-files.js, fact-checker.js via review-task.js,
// context-trim-sweep.js, auto-confirm-review.js) -- every one of them resolves a single
// global repoRoot and never looks at task.stacked, because nothing centralized this
// decision. This module is that one place, so it only needs to be gotten right once.
//
// For a NON-stacked task (the overwhelming majority), resolveGroundingRef always returns
// null and every caller's existing behavior is completely unchanged.

const path = require('path');
const { execFileSync } = require('child_process');
const { createRealGitRunner } = require('./git-runner.js');

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
const GIT_TIMEOUT_MS = 60_000;

function runGit(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV, timeout: GIT_TIMEOUT_MS });
}

// Returns the stacked branch's plain name (e.g. "agent/decompose-autodecomp-...") if
// `task` is a stacked child AND that branch genuinely exists on origin right now, else
// null. Reuses git-runner.js's own real adapter (the same fetch + refs/remotes/origin/*
// existence check apply-task.js's prepareStackedBranch already depends on) rather than a
// second hand-rolled check -- fetchBranch() is a best-effort fetch (never throws), so a
// network hiccup just falls back to null (matches today's behavior) instead of failing
// whatever drafting/grounding pass is asking.
function resolveGroundingRef(task, repoRoot) {
  const branch = task && task.stacked && task.stacked.branch;
  if (!branch || !repoRoot) return null;
  const runner = createRealGitRunner(repoRoot);
  runner.fetchBranch(branch);
  return runner.remoteBranchExists(branch) ? branch : null;
}

// Reads one file's content AT a ref, straight from git's object database -- no working
// directory touched, so this never races apply-task.js concurrently mutating the shared
// repoRoot checkout for a different task, and needs no worktree lifecycle. Returns null on
// a path that doesn't exist at that ref (mirrors a plain fs.readFileSync ENOENT -> null
// convention each caller already has), never throws for that case.
function readFileAtRef(repoRoot, ref, filePath) {
  try {
    return runGit(['show', `origin/${ref}:${filePath}`], repoRoot);
  } catch {
    return null;
  }
}

// Greps a pattern against a ref's tree -- same object-database-only property as
// readFileAtRef. `paths`, if given, scopes the search (mirrors `git grep <pattern> <ref>
// -- <paths...>`). Returns the raw matching lines (possibly empty string for no matches),
// never throws for "no matches" (git grep's own no-match exit code), only for a real error
// (e.g. the ref genuinely doesn't exist -- callers should have already checked via
// resolveGroundingRef before calling this, so that's a real bug surfaced, not swallowed).
function grepAtRef(repoRoot, ref, pattern, paths) {
  const args = ['grep', '-I', '-F', '-e', pattern, `origin/${ref}`];
  if (paths && paths.length) args.push('--', ...paths);
  try {
    return runGit(args, repoRoot);
  } catch (e) {
    // git grep exits 1 (not an error) when the ref exists but nothing matched -- exit
    // codes >1 or a missing-ref message are real failures and must not be swallowed.
    if (e.status === 1) return '';
    throw e;
  }
}

// Does a CLAIMED path exist in a ref's tree? Mirrors fact-checker.js's resolveAgainstRepoDetailed tiers against git's object database instead of
// the working tree: exact path, then each configured code dir (extraRoots) prefixed, then a unique basename match (or a unique one under an
// extraRoot when the bare basename is ambiguous). Returns the resolved repo-relative path, or null. Never throws: an unreadable ref reads as
// "not found", which leaves the caller's own working-tree verdict in force.
// 2026-09-20, PF HUB0005-01: a stacked task that MODIFIES a file only its chain branch has (tileGrid.ts) was blocked 3x by the plan-target
// guard as a fabricated path, because that guard only looked at the shared checkout's working tree.
function resolveAtRef(repoRoot, ref, candidatePath, extraRoots = []) {
  let files;
  try {
    files = execFileSync('git', ['ls-tree', '-r', '--name-only', `origin/${ref}`], { cwd: repoRoot, encoding: 'utf8', env: GIT_ENV, timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 })
      .split('\n').filter(Boolean);
  } catch { return null; }
  const set = new Set(files);
  const normalized = String(candidatePath || '').replace(/\\/g, '/').replace(/^\.?\//, '');
  if (!normalized) return null;
  if (set.has(normalized)) return normalized;
  for (const r of extraRoots || []) {
    const full = path.posix.join(String(r).replace(/\\/g, '/'), normalized);
    if (set.has(full)) return full;
  }
  const base = path.posix.basename(normalized);
  const matches = files.filter((f) => path.posix.basename(f) === base);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1 && (extraRoots || []).length) {
    const roots = extraRoots.map((r) => String(r).replace(/\\/g, '/').replace(/\/$/, '') + '/');
    const preferred = matches.filter((m) => roots.some((r) => m.startsWith(r)));
    if (preferred.length === 1) return preferred[0];
  }
  return null;
}

// ---- Stacked-tree existence helpers: does a file/symbol exist in the world a stacked piece builds on (hub tip + applied lower-seq siblings)?

const fs = require('fs');

// Status constant: "waiting for stacked sibling to land"
const WAITING = 'waiting';

// The hub branch name for a stacked task, or null (non-stacked, or the branch doesn't resolve).
function resolveStackedBase(task, repoRoot) {
  if (!task || !task.stacked) return null;
  return resolveGroundingRef(task, repoRoot) || null;
}

let stackedRefResolver = resolveStackedBase;

// Test seam: overrides resolveStackedBase for the helpers below. A non-function argument restores the real one.
function setStackedRefResolverForTest(fn) {
  stackedRefResolver = typeof fn === 'function' ? fn : resolveStackedBase;
}

// A live hub: a stacked piece with seq > 1 whose hub branch ref resolves.
function isLiveHub(task, repoRoot) {
  const seq = Number(task && task.stacked && task.stacked.seq);
  if (!(seq > 1)) return false;
  return !!stackedRefResolver(task, repoRoot || process.cwd());
}

function normPath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\.?\//, '');
}

// Paths on the Files lines of applied siblings with a lower seq on the same hub branch.
function appliedSiblingFiles(task, repoRoot) {
  const out = new Set();
  try {
    const seq = Number(task && task.stacked && task.stacked.seq);
    const branch = task && task.stacked && task.stacked.branch;
    if (!(seq > 1) || !branch) return out;
    const { liveSiblingsOnBranch } = require('./lib/shared-branch.js');
    const { extractDeclaredFiles } = require('./adhoc-diff-sanity.js');
    if (typeof extractDeclaredFiles !== 'function') return out;
    const pipelineDir = process.env.AGENT_MANAGER_PIPELINE_DIR || repoRoot;
    const { siblings } = liveSiblingsOnBranch({ pipelineDir, branch, selfId: task.id });
    for (const s of siblings || []) {
      let rec;
      try { rec = JSON.parse(fs.readFileSync(path.join(pipelineDir, 'queue', s.state, `${s.id}.json`), 'utf8')); } catch { continue; }
      const sseq = Number(rec && rec.stacked && rec.stacked.seq);
      if (!(sseq < seq)) continue;
      const text = [rec.rawText, rec.description, rec.text, rec.title].filter((x) => typeof x === 'string').join('\n');
      for (const f of extractDeclaredFiles(text) || []) out.add(normPath(f));
    }
  } catch { /* best effort: no sibling evidence */ }
  return out;
}

// Does a FILE exist in the world a stacked piece builds on?
// Checks hub tip (groundingRef) first, then each sibling ref in order.
// `repoRoot` and `groundingRef` are required; missing either returns false.
// `siblingRefs` defaults to [] (tip-only behavior).
// Treats a missing or unreadable ref as 'not found there', never an exception.
function fileExistsForTask(path, { groundingRef, siblingRefs = [], repoRoot }) {
  const p = normPath(path);
  if (!p) return false;
  if (!repoRoot || !groundingRef) return false;
  
  // Check hub tip first
  try {
    if (resolveAtRef(repoRoot, groundingRef, p)) return true;
  } catch { /* fall through: unreadable ref = not found */ }
  
  // Then each sibling ref in order, return on first hit
  for (const ref of siblingRefs || []) {
    try {
      if (resolveAtRef(repoRoot, ref, p)) return true;
    } catch { /* fall through: unreadable ref = not found */ }
  }
  
  return false;
}

// Does a SYMBOL exist in the world a stacked piece builds on?
// Checks hub tip (groundingRef) first, then each sibling ref in order.
// `repoRoot` and `groundingRef` are required; missing either returns false.
// `siblingRefs` defaults to [] (tip-only behavior).
// Treats a missing or unreadable ref as 'not found there', never an exception.
function symbolExistsForTask(symbol, { groundingRef, siblingRefs = [], repoRoot }) {
  const sym = String(symbol || '');
  if (!sym) return false;
  if (!repoRoot || !groundingRef) return false;
  
  // Check hub tip first
  try {
    if (String(grepAtRef(repoRoot, groundingRef, sym)).trim()) return true;
  } catch { /* fall through: unreadable ref = not found */ }
  
  // Then each sibling ref in order, return on first hit
  for (const ref of siblingRefs || []) {
    try {
      if (String(grepAtRef(repoRoot, ref, sym)).trim()) return true;
    } catch { /* fall through: unreadable ref = not found */ }
  }
  
  return false;
}

// Pure function: decides how to route a stacked premise that may be stale.
// - found on tip OR on an applied sibling → 'requeue-tip'
//   (treat found-on-applied-sibling like found-on-tip: the premise is grounded)
// - not found but unapplied siblings remain → 'waiting'
// - missing everywhere with no unapplied sibling → 'escalate'
function decideStackedPremiseRoute({ foundOnTip, foundOnAppliedSibling, unappliedSiblingCount }) {
  if (foundOnTip || foundOnAppliedSibling) {
    // Found on an applied sibling is treated like found on tip: the premise is
    // grounded in the shared branch and the work can proceed.
    return 'requeue-tip';
  }
  if (unappliedSiblingCount > 0) {
    return 'waiting';
  }
  return 'escalate';
}

module.exports = {
  WAITING,
  resolveGroundingRef, readFileAtRef, grepAtRef, resolveAtRef,
  resolveStackedBase, isLiveHub, fileExistsForTask, symbolExistsForTask, setStackedRefResolverForTest,
  decideStackedPremiseRoute,
};
