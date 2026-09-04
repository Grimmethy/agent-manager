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
function resolveAccessibleRoots({ repoRoot } = {}) {
  const root = repoRoot || require('./config.js').getConfig().repoRoot;
  const manifest = readPluginsManifest();
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

module.exports = { resolveAccessibleRoots };
