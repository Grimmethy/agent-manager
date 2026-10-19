'use strict';

// Resolves WHERE a cross-repo adhoc diff should be applied: which ACCESSIBLE ROOT
// the touched files actually live in, so a diff that names files in a plugin repo
// (e.g. agent-manager-hygiene) can be routed to that repo's DEDICATED apply clone
// instead of being force-applied against the primary checkout -- where the same
// path either does not exist or, worse, exists as an unrelated file.
//
// Isolation model: it mirrors config.js's AGENT_MANAGER_APPLY_REPO_ROOT split
// (2026-09-07) -- the apply destination is a dedicated clone/worktree base, NEVER
// the live interactive checkout. Structurally: the returned string is built ONLY
// from the apply-clone base (process.env.AGENT_MANAGER_APPLY_REPO_ROOT) + the
// root's directory name; the root's live on-disk path is only ever used for the
// read-only "does this tree contain the touched files" check, never in the
// returned value. If no dedicated apply-clone base is configured, this resolver
// has no safe dedicated destination and falls through (null) rather than naming a
// path inside the live checkout.
//
// Deliberately self-contained (node:fs + node:path only): it must NOT import
// apply-task.js (the consumer; circular) nor accessible-roots.js (the roots are
// passed in -- the same string[] shape resolveAccessibleRoots() returns, where
// roots[0] is always the primary/default repo per that module's own contract).

const fs = require('fs');
const path = require('path');

// The diff --git a/... b/... header's b/-side (the post-change path) is the file
// as the diff wants it to exist on disk. A deleted file's b side is /dev/null --
// such a path can never "contain" a file, so it correctly makes containsAll
// false for every root (a pure-deletion cross-repo diff falls through; the
// caller's default apply path handles it).
const DIFF_HEADER_RE = /^diff --git a\/(\S+) b\/(\S+)/;

// { rawDiff: string? } -> string[] of touched repo-relative paths (may be empty).
function parseTouchedPaths(rawDiff) {
  const out = [];
  if (typeof rawDiff !== 'string') return out;
  for (const line of rawDiff.split('\n')) {
    const m = DIFF_HEADER_RE.exec(line);
    if (!m) continue;
    const p = m[2];
    if (!p || p === '/dev/null') continue;
    if (p.startsWith('/') || p.includes('..')) continue; // absolute / escaping -- untrusted, skip
    out.push(p);
  }
  return out;
}

// True iff every repo-relative path in `touched` exists on disk under `root`.
// Paths that would escape the root (absolute, ..) count as misses.
function rootContainsAll(root, touched) {
  if (!root || touched.length === 0) return false;
  for (const p of touched) {
    let full;
    try {
      full = path.resolve(root, p);
    } catch {
      return false;
    }
    if (full !== root && !full.startsWith(root + path.sep)) return false; // escaped -- miss
    try {
      if (!fs.existsSync(full)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

// resolveApplyTargetRoot(task, { accessibleRoots }) -> string | null
//
// accessibleRoots: string[] of absolute on-disk repo roots, roots[0] = the
// default/primary repo (resolveAccessibleRoots() shape).
//
// Decision table:
//   - rawDiff missing / no parseable diff --git headers        -> null (fall through)
//   - no dedicated apply-clone base (env unset)                -> null (nothing safe to route to)
//   - default root (roots[0]) contains all touched paths       -> null (primary apply path owns it)
//   - exactly ONE non-default root contains all touched paths  -> <applyCloneBase>/<root dir name>
//   - two or more non-default roots contain all (split/ambig.) -> null
//   - no root contains all                                     -> null
//
// The only non-null return is a path UNDER the dedicated apply-clone base
// (AGENT_MANAGER_APPLY_REPO_ROOT, same env var config.js's applyRepoRoot reads),
// built purely from that base + the matched root's directory name -- never from
// the root's live checkout path, never equal to or a prefix of it.
function resolveApplyTargetRoot(task, { accessibleRoots } = {}) {
  const touched = parseTouchedPaths(task && task.rawDiff);
  if (touched.length === 0) return null;

  const base = process.env.AGENT_MANAGER_APPLY_REPO_ROOT;
  if (!base) return null; // no dedicated clone configured -> no safe route; fall through

  if (!Array.isArray(accessibleRoots) || accessibleRoots.length === 0) return null;

  const [defaultRoot, ...nonDefault] = accessibleRoots;
  if (defaultRoot && rootContainsAll(defaultRoot, touched)) return null;

  const matches = nonDefault.filter((r) => rootContainsAll(r, touched));
  if (matches.length !== 1) return null;

  const clonePath = path.join(base, path.basename(matches[0]));
  // Structural safety: the result is built only from `base`, but refuse to route
  // if that would name the live checkout itself (a misconfigured base == root).
  const live = matches[0];
  if (clonePath === live || live.startsWith(clonePath + path.sep)) return null;
  return clonePath;
}

module.exports = { resolveApplyTargetRoot, parseTouchedPaths };
