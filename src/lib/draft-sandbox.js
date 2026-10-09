'use strict';

// The draft sandbox's toolchain (2026-09-20, PF-Client-Portal HUB0005-01).
//
// An agentic draft runs in a fresh `git worktree add` of TRACKED files only, and node_modules is gitignored, so a JS/TS project's draft could
// never run `tsc`, `vite`, or any test. The model tried `npm install` instead: on 2026-09-19 that rewrote package-lock.json (now stripped by
// draft-side-effects.js), and on 2026-09-20 it failed outright. Plans kept stating "npx tsc --noEmit -> zero errors" as a criterion, the draft
// could not run it, and review rejected the unverified criterion (12 PF records mention this; 9 slipped through, 3 were rejected).
//
// Two halves, both here so the decision is made in one place:
//   1. copyNodeModules(): give the worktree a PRIVATE COPY of the repo's installed node_modules, when that is safe and cheap. A copy, never a
//      symlink: a stray `npm install` inside the sandbox must not write through into the shared checkout's real dependencies.
//   2. filterCriteriaForSandbox(): when the sandbox has no toolchain (no node_modules to copy, too large, switched off), drop the PLAN-DERIVED
//      criteria that require running it, deterministically -- the same way dropGitWriteCriteria / dropSingleFileScopeContradictions strip
//      criteria the sandbox cannot meet -- instead of hoping the model stops writing them. A criterion the task's author wrote is left alone.
//
// Env: AGENT_MANAGER_DRAFT_NODE_MODULES=false switches both halves off (no copy, no stripping). AGENT_MANAGER_DRAFT_NODE_MODULES_MAX_MB
// (default 800) is the largest node_modules that is copied.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_MAX_MB = 800;
const DU_TIMEOUT_MS = 30_000;
const COPY_TIMEOUT_MS = 180_000;

function switchedOff(env = process.env) {
  return String(env.AGENT_MANAGER_DRAFT_NODE_MODULES || '').trim().toLowerCase() === 'false';
}

function maxMb(env = process.env) {
  const n = Number(env.AGENT_MANAGER_DRAFT_NODE_MODULES_MAX_MB);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_MB;
}

function isNonEmptyDir(dir) {
  try { return fs.statSync(dir).isDirectory() && fs.readdirSync(dir).length > 0; } catch { return false; }
}

// Would a JS toolchain be expected here at all? (A Python-only repo has no package.json and nothing to strip or copy.)
function isJsProject(repoRoot) {
  try { return !!repoRoot && fs.statSync(path.join(repoRoot, 'package.json')).isFile(); } catch { return false; }
}

// repoRoot -> { mode, sizeMb?, reason? }. mode: 'copy' (a copy will be made) | 'no-project' (no package.json) | 'disabled' | 'absent'
// (no installed node_modules to copy) | 'too-large'. Cheap: one `du`. Never throws.
function planNodeModules(repoRoot, env = process.env) {
  if (!isJsProject(repoRoot)) return { mode: 'no-project', reason: 'no package.json' };
  if (switchedOff(env)) return { mode: 'disabled', reason: 'AGENT_MANAGER_DRAFT_NODE_MODULES=false' };
  const src = path.join(repoRoot, 'node_modules');
  if (!isNonEmptyDir(src)) return { mode: 'absent', reason: 'the repo has no installed node_modules' };
  let sizeMb = null;
  try {
    const kb = Number(String(execFileSync('du', ['-sk', fs.realpathSync(src)], { encoding: 'utf8', timeout: DU_TIMEOUT_MS })).split(/\s+/)[0]); // realpath: du of a symlink measures the link
    if (Number.isFinite(kb)) sizeMb = Math.round(kb / 1024);
  } catch { /* unknown size: fall through and copy under the copy timeout */ }
  if (sizeMb != null && sizeMb > maxMb(env)) return { mode: 'too-large', sizeMb, reason: `node_modules is ${sizeMb} MB (cap ${maxMb(env)} MB)` };
  return { mode: 'copy', sizeMb };
}

// True when a fresh draft worktree of this repo will have its dependencies. Same decision copyNodeModules acts on.
function sandboxHasToolchain(repoRoot, env = process.env) {
  return planNodeModules(repoRoot, env).mode === 'copy';
}

// Copies <repoRoot>/node_modules into the worktree. Skipped unless the worktree's git ignores node_modules (a repo that tracks or forgets to
// ignore it would have a 30k-file `git add -A` on the draft's diff capture). `cp -a` keeps the .bin symlinks; --reflink=auto is a free
// clone on filesystems that support it. Never throws: { copied, ms?, sizeMb?, reason? }.
function copyNodeModules(repoRoot, worktreeDir, { run = execFileSync, env = process.env } = {}) {
  const plan = planNodeModules(repoRoot, env);
  if (plan.mode !== 'copy') return { copied: false, reason: plan.reason || plan.mode };
  const started = Date.now();
  try {
    // Probe a path INSIDE node_modules: a directory-only pattern (`node_modules/`, PF's own .gitignore) does not match the bare name while the
    // directory does not exist yet, which is exactly the state of a fresh worktree.
    try { run('git', ['check-ignore', '-q', 'node_modules/.bin'], { cwd: worktreeDir, stdio: 'ignore' }); }
    catch { return { copied: false, reason: 'node_modules is not gitignored in this repo' }; }
    // realpath: if the repo's node_modules is itself a symlink, `cp -a` would copy the LINK and the sandbox would share the real tree.
    run('cp', ['-a', '--reflink=auto', fs.realpathSync(path.join(repoRoot, 'node_modules')), path.join(worktreeDir, 'node_modules')], { timeout: COPY_TIMEOUT_MS, stdio: 'ignore' });
    return { copied: true, ms: Date.now() - started, sizeMb: plan.sizeMb };
  } catch (e) {
    // A partial copy is worse than none: the model would see a half-installed tree and blame its own change.
    try { fs.rmSync(path.join(worktreeDir, 'node_modules'), { recursive: true, force: true }); } catch { /* best-effort */ }
    return { copied: false, reason: `copy failed: ${String((e && e.message) || e).slice(0, 200)}` };
  }
}

// A NESTED package's node_modules (TaxHarvest/frontend/node_modules). copyNodeModules above only knows <repoRoot>/node_modules, so a monorepo's packages had no
// dependencies in the review sandbox and their tests could not run. Copied on demand (the review does it only for a package with covering tests to run): a
// per-draft copy of a 400 MB frontend tree would be paid by every task. Same safety rules as copyNodeModules: gitignored, under the size cap, private copy,
// never a partial one. Never throws: { copied, already?, ms?, sizeMb?, reason? }.
function copyPackageNodeModules(repoRoot, worktreeDir, pkgRel, { run = execFileSync, env = process.env } = {}) {
  if (!pkgRel) return copyNodeModules(repoRoot, worktreeDir, { run, env });
  if (switchedOff(env)) return { copied: false, reason: 'AGENT_MANAGER_DRAFT_NODE_MODULES=false' };
  const src = path.join(repoRoot, pkgRel, 'node_modules');
  const dest = path.join(worktreeDir, pkgRel, 'node_modules');
  if (isNonEmptyDir(dest)) return { copied: true, already: true };
  if (!isNonEmptyDir(src)) return { copied: false, reason: `${pkgRel}/node_modules is not installed in the repo (run npm ci in ${pkgRel})` };
  const started = Date.now();
  try {
    let sizeMb = null;
    try {
      const kb = Number(String(run('du', ['-sk', fs.realpathSync(src)], { encoding: 'utf8', timeout: DU_TIMEOUT_MS })).split(/\s+/)[0]);
      if (Number.isFinite(kb)) sizeMb = Math.round(kb / 1024);
    } catch { /* unknown size: copy under the copy timeout */ }
    if (sizeMb != null && sizeMb > maxMb(env)) return { copied: false, reason: `${pkgRel}/node_modules is ${sizeMb} MB (cap ${maxMb(env)} MB)`, sizeMb };
    try { run('git', ['check-ignore', '-q', `${pkgRel}/node_modules/.bin`], { cwd: worktreeDir, stdio: 'ignore' }); }
    catch { return { copied: false, reason: `${pkgRel}/node_modules is not gitignored in this repo` }; }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    run('cp', ['-a', '--reflink=auto', fs.realpathSync(src), dest], { timeout: COPY_TIMEOUT_MS, stdio: 'ignore' });
    return { copied: true, ms: Date.now() - started, sizeMb };
  } catch (e) {
    try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* best-effort */ }
    return { copied: false, reason: `copy failed: ${String((e && e.message) || e).slice(0, 200)}` };
  }
}

// ---- dependency links to a sibling checkout (brain-dump #1745) -------------------------------------------------------------
// agent-manager-hygiene's node_modules holds ONE relative symlink, `agent-manager -> ../../agent-manager` (package.json "file:../agent-manager").
// `cp -a` of that directory leaves the link dangling in a worktree, and the review sandbox (bwrap) binds only system paths, so a hygiene test that
// requires 'agent-manager/src/...' threw before running. These two helpers let review-verify.js relink the COPY and bind the target read-only.
//
// Only CODE of the target is ever exposed: the target is usually a live checkout whose root holds agent-manager.env (dashboard and internal
// tokens), the pipeline queue and brain-dump.json, none of which a test needs.
const CODE_ENTRIES = ['package.json', 'src', 'lib', 'dist', 'index.js', 'index.cjs', 'index.mjs', 'node_modules'];

// repoRoot -> [{ name, linkPath, target }]: the symlinks directly inside <repoRoot>/node_modules (and one level inside @scope dirs) whose real path is a
// directory OUTSIDE the real node_modules tree. A link into node_modules itself (.bin, workspace-style) and a dangling link are skipped. Never throws.
function externalDependencyLinks(repoRoot) {
  const out = [];
  try {
    const nm = path.join(repoRoot, 'node_modules');
    const realNm = fs.realpathSync(nm);
    const consider = (linkPath, name) => {
      try {
        if (!fs.lstatSync(linkPath).isSymbolicLink()) return;
        const target = fs.realpathSync(linkPath); // throws for a dangling link
        if (!fs.statSync(target).isDirectory()) return;
        if (target === realNm || target.startsWith(realNm + path.sep)) return;
        out.push({ name, linkPath, target });
      } catch { /* dangling or unreadable: skip */ }
    };
    for (const entry of fs.readdirSync(nm)) {
      if (entry.startsWith('.')) continue;
      const entryPath = path.join(nm, entry);
      if (entry.startsWith('@')) {
        try { for (const sub of fs.readdirSync(entryPath)) consider(path.join(entryPath, sub), `${entry}/${sub}`); } catch { /* not a dir */ }
        continue;
      }
      consider(entryPath, entry);
    }
  } catch { return []; }
  return out;
}

// targetDir -> the existing paths among an ALLOWLIST of code entries (CODE_ENTRIES), each required to really live inside the target (an entry that is
// a symlink out of it is dropped). Nothing else is ever returned, so an env file, queue data, brain-dump.json or .git of the target stay invisible.
function codeBindPaths(targetDir) {
  const out = [];
  let realTarget;
  try { realTarget = fs.realpathSync(targetDir); } catch { return out; }
  for (const entry of CODE_ENTRIES) {
    const p = path.join(realTarget, entry);
    try {
      const real = fs.realpathSync(p);
      if (real === realTarget || real.startsWith(realTarget + path.sep)) out.push(p);
    } catch { /* absent */ }
  }
  return out;
}

// A criterion that can only be met by RUNNING the project's JS toolchain: a typecheck, build, lint, test run, or an npx/npm/yarn/pnpm command.
const TOOLCHAIN_CRITERION_RE = /\b(?:npx|npm\s+(?:run|test|ci|install|i)\b|yarn\s+[\w-]+|pnpm\s+[\w-]+|tsc\b|vitest\b|vite\b|jest\b|eslint\b|mocha\b|playwright\b|cypress\b)|\btype[- ]?check|\bnpm\s+t\b/i;

function dropToolchainCriteria(criteria) {
  const kept = []; const dropped = [];
  for (const c of criteria || []) (TOOLCHAIN_CRITERION_RE.test(String(c)) ? dropped : kept).push(c);
  return { criteria: kept, dropped };
}

// { criteria, source, repoRoot } -> { criteria, dropped }. Only plan-derived criteria are filtered, and only for a JS project whose sandbox
// will have no toolchain; every other case returns the criteria untouched.
function filterCriteriaForSandbox({ criteria, source, repoRoot, env = process.env }) {
  const list = Array.isArray(criteria) ? criteria : [];
  if (source !== 'plan-derived' || list.length === 0 || switchedOff(env)) return { criteria: list, dropped: [] };
  const plan = planNodeModules(repoRoot, env);
  if (plan.mode === 'copy' || plan.mode === 'no-project') return { criteria: list, dropped: [] };
  return dropToolchainCriteria(list);
}

module.exports = { planNodeModules, sandboxHasToolchain, copyNodeModules, copyPackageNodeModules, dropToolchainCriteria, filterCriteriaForSandbox, isJsProject, externalDependencyLinks, codeBindPaths, CODE_ENTRIES, TOOLCHAIN_CRITERION_RE };
