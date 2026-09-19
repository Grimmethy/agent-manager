'use strict';

// candidate-doc-refs.js -- git-aware views of a Docs/*_CANDIDATES.md file.
//
// Why (2026-09-19, PropertyForager): since candidate-doc writes stopped going straight to main
// (lib/main-push-policy.js) they live on branches until a human merges them, and the working tree
// of the apply repo can be on ANY of those branches. Two things broke:
//
//  1. ID allocation looked only at the working-tree copy of the doc. An arch_review split ran while
//     the checkout lacked the unmerged agent/triage-queue candidates, reused AC-2/AC-3 (which main
//     already had, with different content), and the branch conflicted with main and would have
//     shadowed the real AC-2's arch-review-ac-2 task id.
//  2. Task generation read the doc from whatever branch happened to be checked out, so a candidate
//     sitting on an UNMERGED branch was turned into a task (arch-review-ac-2 was drafting content
//     that only existed on agent/arch-review-ac-1).
//
// highestIdAcrossRefs -> allocation must skip every id already used on the default branch OR any
//                        unmerged agent/* branch.
// readCandidatesText  -> generation reads the doc as it is on the DEFAULT BRANCH (origin/<main>): only
//                        candidates a human has merged become tasks. Falls back to the working-tree
//                        file whenever git can't answer (not a repo, no origin, no default-branch ref),
//                        so tests and non-git setups behave exactly as before.
//
// Everything is best-effort and fail-open: a git problem never blocks a draft or an apply.
// Kill switch for the read side: AGENT_MANAGER_CANDIDATES_FROM_WORKING_TREE=true.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const FETCH_MIN_INTERVAL_MS = 60 * 1000;
const GIT_TIMEOUT_MS = 20 * 1000;

function git(dir, args, timeout = GIT_TIMEOUT_MS) {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout, maxBuffer: 64 * 1024 * 1024,
  });
}

// { dir, top, rel } for a doc path inside a git work tree, or null.
function locate(candidatesPath) {
  try {
    const dir = path.dirname(path.resolve(candidatesPath));
    const top = git(dir, ['rev-parse', '--show-toplevel']).trim();
    if (!top) return null;
    const rel = path.relative(fs.realpathSync(top), path.join(fs.realpathSync(dir), path.basename(candidatesPath))).split(path.sep).join('/');
    return { dir, top, rel };
  } catch {
    return null;
  }
}

// 'origin/main' | 'origin/master' | null. The remote-tracking ref of the repo's default branch.
function defaultBranchRef(dir) {
  try {
    const head = git(dir, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']).trim();
    if (head) return head.replace(/^refs\/remotes\//, '');
  } catch { /* origin/HEAD not set -- probe the usual names */ }
  for (const name of ['origin/main', 'origin/master']) {
    try { git(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/${name}`]); return name; } catch { /* next */ }
  }
  return null;
}

// Refresh the remote-tracking refs, at most once a minute per repo (stamped in the git dir BEFORE the
// fetch, so a hung/failing fetch is not retried on every tick). Best-effort.
function fetchThrottled(dir) {
  try {
    const gitDir = path.resolve(dir, git(dir, ['rev-parse', '--git-dir']).trim());
    const stamp = path.join(gitDir, 'agent-manager-candidates-fetch');
    let last = 0;
    try { last = fs.statSync(stamp).mtimeMs; } catch { /* never fetched */ }
    if (Date.now() - last < FETCH_MIN_INTERVAL_MS) return;
    fs.writeFileSync(stamp, new Date().toISOString());
    git(dir, ['fetch', '-q', 'origin'], GIT_TIMEOUT_MS);
  } catch { /* offline / no origin: work with the refs we have */ }
}

function idsIn(text) {
  return [...String(text || '').matchAll(/^###\s*AC-(\d+)/gm)].map((m) => parseInt(m[1], 10));
}

// Highest AC-NNN used by the doc on the default branch or on ANY unmerged agent/* branch (remote-tracking
// or local). 0 when git can't answer. The caller takes max(this, its own working-tree max) + 1.
function highestIdAcrossRefs(candidatesPath) {
  const loc = locate(candidatesPath);
  if (!loc) return 0;
  try {
    fetchThrottled(loc.dir);
    const refs = new Set();
    const main = defaultBranchRef(loc.dir);
    if (main) refs.add(`refs/remotes/${main}`);
    for (const prefix of ['refs/remotes/origin/agent/', 'refs/heads/agent/']) {
      for (const r of git(loc.dir, ['for-each-ref', '--format=%(refname)', prefix]).split('\n')) if (r.trim()) refs.add(r.trim());
    }
    let max = 0;
    for (const ref of refs) {
      let text = '';
      try { text = git(loc.dir, ['show', `${ref}:${loc.rel}`]); } catch { continue; } // doc absent on that ref
      for (const n of idsIn(text)) if (n > max) max = n;
    }
    return max;
  } catch {
    return 0;
  }
}

function readIfExists(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

// The doc as it is on the default branch (what a human has merged). Working-tree fallback when git can't
// answer. '' when the default branch exists but has no such doc yet (nothing merged -> no candidates), even
// if the working tree of an unmerged branch has one.
function readCandidatesText(candidatesPath) {
  if (process.env.AGENT_MANAGER_CANDIDATES_FROM_WORKING_TREE === 'true') return readIfExists(candidatesPath);
  const loc = locate(candidatesPath);
  if (!loc) return readIfExists(candidatesPath);
  const main = defaultBranchRef(loc.dir);
  if (!main) return readIfExists(candidatesPath);
  fetchThrottled(loc.dir);
  try {
    return git(loc.dir, ['show', `${main}:${loc.rel}`]);
  } catch {
    return '';
  }
}

module.exports = { highestIdAcrossRefs, readCandidatesText, defaultBranchRef, locate };
