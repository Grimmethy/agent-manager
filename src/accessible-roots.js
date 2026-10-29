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
function isCoreRepo(root) {
  const r = realOrResolved(root);
  if (r === realOrResolved(PACKAGE_ROOT)) return true;
  const core = process.env.AGENT_MANAGER_CORE_REPO_ROOT;
  return !!core && r === realOrResolved(core);
}

function resolveAccessibleRoots({ repoRoot } = {}) {
  const root = repoRoot || require('./config.js').getConfig().repoRoot;
  const manifest = isCoreRepo(root) ? readPluginsManifest() : null;
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

module.exports = { resolveAccessibleRoots, resolveReadOnlySiblingRoots, isSecretLookingPath, isCoreRepo };
