'use strict';

// Resolves "every repo this pipeline's OWN grounding can search" -- agent-manager plus
// its enabled AGENT_MANAGER_REGISTER_PATH plugin repos. Root-caused 2026-09-04 via a stuck
// adhoc task: `function_length_fix (candidateFulfillment split mode) recursively splits`
// named `function-length-review.js` as the fix site, but that file lives in
// agent-manager-hygiene, a separate repo -- every grounding mechanism this pipeline has
// (adhoc-harness-draft.js's tier-1 harness search, plan-grounding.js's plan-time grep, the
// 9 registered harnessSearch:'archImport' sources' shared runHarnessSearch path) searched
// config.js's single repoRoot only, so the model never saw the real file and hallucinated
// an edit to an unrelated one instead (three rejected attempts, escalated to a human).
//
// python/dashboard/app.py's _chat_roots() already solves this exact problem for the
// system-wide Chat panel -- [agent-manager] + dirname(registerPath) per enabled
// plugins.json entry + each projects.json repoRoot, realpath-deduped. This is the JS-side
// equivalent for the pipeline's own draft code, scoped to the PLUGIN half only: plugins
// are "one logical system split into repos for packaging," always relevant to a task about
// this pipeline's own code, unlike projects.json's unrelated Second-Brain-tracked side
// projects (Screaming Goat, ComfyUI, ...), which would dilute grounding and multiply grep
// cost for no benefit to a self-referential pipeline bug report. Extending to the full
// project registry, if it turns out to matter, is a one-line follow-up (add a
// readProjectRegistry() pass here the same shape as the plugin pass below).

const fs = require('fs');
const path = require('path');
const { readPluginsManifest, enabledRegisterPaths } = require('./plugins-manifest.js');

// { repoRoot }? -> string[] of absolute, realpath-deduped, existing-on-disk repo roots.
// roots[0] is always the primary repo. Never throws -- a missing manifest, a plugin dir
// that no longer exists on disk, or an unreadable path is silently skipped, same
// fail-open discipline readPluginsManifest() itself already uses. Falls back to
// [repoRoot] alone when nothing else resolves (a fresh clone with no plugins.json, or one
// where every entry is disabled/missing) -- byte-identical to every pre-existing
// single-root caller.
// The plugin repos are "one logical system split into repos for packaging" with agent-manager
// itself -- relevant only when the pipeline is working ON agent-manager. When it's pointed at
// another project (PF-Client-Portal, 2026-09-19) they are unrelated code: a plan's "grep hits"
// came back from agent-manager-hygiene, promptforge and a .venv, and the model reasoned from
// them. Core = the checkout this package runs from, or AGENT_MANAGER_CORE_REPO_ROOT.
const PACKAGE_ROOT = path.join(__dirname, '..');
function realOrResolved(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}
// Linked git worktree of the core repo. Cloud lanes run each task in a per-task `git worktree`
// whose `.git` is a FILE ("gitdir: <core>/.git/worktrees/<name>"). Kept separate from isCoreRepo so
// isCoreRepo's branches stay untouched. Never throws; any failure reads as "not a core worktree".
function coreGitDir() {
  try {
    const core = process.env.AGENT_MANAGER_CORE_REPO_ROOT || PACKAGE_ROOT;
    const gitDir = path.join(core, '.git');
    if (!fs.statSync(gitDir).isDirectory()) return null;
    return realOrResolved(gitDir);
  } catch { return null; }
}
function linkedWorktreeGitDir(root) {
  try {
    const dotGit = path.join(root, '.git');
    if (!fs.lstatSync(dotGit).isFile()) return null;
    const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
    if (!m) return null;
    const wt = path.resolve(root, m[1].trim());
    if (path.basename(path.dirname(wt)) !== 'worktrees') return null;
    return realOrResolved(path.dirname(path.dirname(wt)));
  } catch { return null; }
}
function isCoreWorktree(root) {
  const core = coreGitDir();
  return !!core && linkedWorktreeGitDir(root) === core;
}

function isCoreRepo(root) {
  const r = realOrResolved(root);
  if (r === realOrResolved(PACKAGE_ROOT)) return true;
  const core = process.env.AGENT_MANAGER_CORE_REPO_ROOT;
  return !!core && r === realOrResolved(core);
}

function resolveAccessibleRoots({ repoRoot } = {}) {
  const root = repoRoot || require('./config.js').getConfig().repoRoot;
  const manifest = (isCoreRepo(root) || isCoreWorktree(root)) ? readPluginsManifest() : null;
  const raw = [root, ...enabledRegisterPaths(manifest).map((rp) => path.dirname(rp))];

  const seen = new Set();
  const out = [];
  for (const p of raw) {
    let real;
    try {
      real = fs.realpathSync(p);
    } catch {
      continue; // gone from disk / unreadable -- skip, don't throw
    }
    if (seen.has(real)) continue;
    let isDir = false;
    try { isDir = fs.statSync(real).isDirectory(); } catch { /* not a dir -- isDir stays false */ }
    if (!isDir) continue;
    seen.add(real);
    out.push(real);
  }
  return out.length ? out : [path.resolve(root)];
}

// Returns the single plugin root (the original entry from pluginRoots) that contains EVERY cited path, or null when any path
// matches no root, the paths span more than one root, or the inputs are empty/invalid (fail closed). Pure: the caller passes the
// roots (e.g. resolveAccessibleRoots()). Relative cited paths are interpreted against the process cwd via path.resolve.
// Nested roots: the longest (most specific) matching root wins for each path.
function findPluginRootForPaths(citedPaths, pluginRoots) {
  if (!Array.isArray(citedPaths) || !Array.isArray(pluginRoots)) return null;
  if (!citedPaths.length || !pluginRoots.length) return null;
  const roots = pluginRoots
    .filter((r) => typeof r === 'string' && r)
    .map((r) => ({ orig: r, norm: realOrResolved(r) }));
  if (!roots.length) return null;
  const contains = (root, p) => {
    if (p === root) return true;
    const prefix = root.endsWith(path.sep) ? root : root + path.sep;
    return p.startsWith(prefix);
  };
  let found = null;
  for (const cited of citedPaths) {
    if (typeof cited !== 'string' || !cited) return null;
    const p = realOrResolved(cited);
    let best = null;
    for (const r of roots) {
      if (contains(r.norm, p) && (!best || r.norm.length > best.norm.length)) best = r;
    }
    if (!best) return null;
    if (found === null) found = best;
    else if (found.norm !== best.norm) return null;
  }
  return found ? found.orig : null;
}

// Sibling repos the implement pass may READ but never write (2026-10-16: the GPU broker verification tasks could not see /media/model-cache/github/videoforge
// or promptforge-manual -- their worktree was the only root -- and concluded the repos were not on this machine). Same plugin set as resolveAccessibleRoots,
// minus every root the pass must not touch or read: its own worktree, the live checkout, the core package root and the apply clone. A non-core active project
// yields [] (resolveAccessibleRoots only adds plugins for the core repo). Never throws.
function resolveReadOnlySiblingRoots({ repoRoot, worktreeDir, applyRepoRoot } = {}) {
  let candidates;
  try { candidates = resolveAccessibleRoots({ repoRoot }).slice(1); } catch { return []; }
  const apply = applyRepoRoot || process.env.AGENT_MANAGER_APPLY_REPO_ROOT;
  const forbidden = [worktreeDir, repoRoot, PACKAGE_ROOT, process.env.AGENT_MANAGER_CORE_REPO_ROOT, apply].filter(Boolean).map(realOrResolved);
  const overlaps = (a, b) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
  return candidates.filter((c) => !forbidden.some((f) => overlaps(realOrResolved(c), f)));
}

// A path that looks like a credential, so the read tools refuse it inside a read-only sibling repo (the pass's output is committed and pushed and nothing scans
// diffs for secrets). run_bash cannot be filtered per file; the implement prompt tells the model not to cat these.
const SECRET_BASENAME_RE = /^(?:\.env(?:\..*)?|.*\.(?:pem|key|pfx|p12)|id_(?:rsa|dsa|ecdsa|ed25519).*|pf-db\.env|.*(?:credential|secret|token).*)$/i;
function isSecretLookingPath(p) {
  const norm = String(p || '').replace(/\\/g, '/');
  if (/(?:^|\/)\.(?:ssh|gnupg)(?:\/|$)/.test(norm)) return true;
  return SECRET_BASENAME_RE.test(path.basename(norm));
}

module.exports = { findPluginRootForPaths, resolveAccessibleRoots, resolveReadOnlySiblingRoots, isSecretLookingPath, isCoreRepo };
