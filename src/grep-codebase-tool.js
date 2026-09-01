'use strict';

// Read-only, dependency-free codebase search for a plan pass to call as a tool (see
// local-tool-client.js). Same style/pattern as a hand-rolled synchronous directory walk:
// no npm packages, hard match cap. repoRoot and the allowed search dirs come from
// config.js (AGENT_MANAGER_REPO_ROOT / AGENT_MANAGER_GREP_DIRS), not hardcoded.

const fs = require('fs');
const path = require('path');
const { getConfig } = require('./config.js');

// Was JS/TS-only, silently excluding every file in whichever of AGENT_MANAGER_GREP_DIRS
// happened to hold Python/shell/docs content -- for this project's own real config
// (AGENT_MANAGER_GREP_DIRS=src,python,scripts,docs), that meant python/ and scripts/ were
// entirely unsearchable and every query against them returned 0 hits no matter how good
// the query was. Confirmed live 2026-08-19: 25/27 blocked arch_import tasks had a
// 0-hits/0-files harness-search result. Extended to match this project's own real file
// types rather than assuming every consumer repo is JS/TS.
const MATCH_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.py', '.sh', '.ps1', '.md'];
const MAX_MATCHES = 20;
// With context lines each hit is several lines, so fewer of them before the payload gets
// unwieldy.
const MAX_MATCHES_WITH_CONTEXT = 12;
const MAX_CONTEXT_LINES = 5;

// A model-supplied `dir` for the PRIMARY repo used to require an exact string match against
// grepAllowedDirs (src, python, ...) -- anything else (`python/dashboard`, `.`, `src/`)
// silently returned [], indistinguishable from "no matches", and the prompt never listed
// the valid names. Resolve it leniently instead: exact dir, a subpath of an allowed dir, an
// allowed dir that is itself under the requested dir, or "."/"" meaning "all of them".
// Returns { roots: [absolute paths] } or { error }.
function resolvePrimaryDirs(repoRoot, allowedDirs, dir) {
  const norm = String(dir == null ? '' : dir).trim().replace(/^\.\//, '').replace(/\/+$/, '');
  if (norm === '' || norm === '.') {
    return { roots: allowedDirs.map((d) => path.join(repoRoot, d)) };
  }
  if (allowedDirs.includes(norm)) return { roots: [path.join(repoRoot, norm)] };
  // requested dir is inside an allowed dir, e.g. "python/dashboard" under "python"
  const underAllowed = allowedDirs.some((d) => norm === d || norm.startsWith(`${d}/`));
  if (underAllowed) return { roots: [path.join(repoRoot, norm)] };
  // an allowed dir is inside the requested dir, e.g. dir="." handled above, or a parent
  const containedAllowed = allowedDirs.filter((d) => d.startsWith(`${norm}/`));
  if (containedAllowed.length) return { roots: containedAllowed.map((d) => path.join(repoRoot, d)) };
  return { error: `unknown dir '${dir}'. Searchable dirs: ${allowedDirs.join(', ')}. Pass one of those, a subpath of one (e.g. "${allowedDirs[0]}/sub"), or "." for all of them.` };
}

// Both call sites' own plan prompts explicitly invite "a few-word phrase" as a valid
// query (see archImportPlanPrompt/projectSearchPlanPrompt in prompts.js), but a full
// English phrase like "draft create review gate" almost never appears as a literal
// substring in real code -- an exact-substring-only match was silently guaranteed to
// return 0 hits for exactly the query shape the prompt asks for (same 2026-08-19 finding
// as the extension gap above: this is why single-token queries worked but multi-word ones
// never did). Falls back to "every token appears somewhere in the line, any order,
// case-insensitive" only once the stricter exact match fails, so a literal single-token
// or exact-name query still gets the tightest possible match first.
function lineMatches(line, query) {
  if (line.includes(query)) return true;
  const lowerLine = line.toLowerCase();
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return false;
  return tokens.every((t) => lowerLine.includes(t));
}

// `root` (2026-08-31, system-wide Chat panel): an explicit absolute repo root to search
// instead of config.js's single repoRoot. When a caller passes it AND it isn't the
// configured repoRoot, the AGENT_MANAGER_GREP_DIRS allowlist is skipped -- that list is
// this project's own source layout and means nothing for a sibling plugin/project repo
// that has no per-repo grep-dirs config -- and an omitted / "." dir walks the whole root.
// Every existing caller (arch-import-fetch.js, the pipeline's read-only tool loop) passes
// no `root` and hits the unchanged path below.
function grepCodebase({ query, dir, root, contextLines }) {
  const { repoRoot, grepAllowedDirs } = getConfig();
  if (!query) return [];

  const altRoot = root && path.resolve(root) !== path.resolve(repoRoot) ? path.resolve(root) : null;
  const base = altRoot || repoRoot;

  let searchRoots;
  if (altRoot) {
    searchRoots = [!dir || dir === '.' ? altRoot : path.join(altRoot, dir)];
  } else {
    const resolved = resolvePrimaryDirs(repoRoot, grepAllowedDirs, dir);
    if (resolved.error) return { error: resolved.error };
    searchRoots = resolved.roots;
  }

  const ctx = Math.max(0, Math.min(MAX_CONTEXT_LINES, Number(contextLines) || 0));
  const maxMatches = ctx > 0 ? MAX_MATCHES_WITH_CONTEXT : MAX_MATCHES;
  const hits = [];

  function walk(current) {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (err) {
      console.warn(`grep-codebase: skipped ${current}: ${err.message}`);
      return;
    }
    for (const entry of entries) {
      if (hits.length >= maxMatches) return;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (['node_modules', '.git', 'queue'].includes(entry.name)) continue;
        walk(fullPath);
      } else if (entry.isFile() && MATCH_EXTENSIONS.includes(path.extname(entry.name))) {
        let text;
        try {
          text = fs.readFileSync(fullPath, 'utf8');
        } catch {
          continue;
        }
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (hits.length >= maxMatches) return;
          if (lineMatches(lines[i], query)) {
            const hit = {
              file: path.relative(base, fullPath).replace(/\\/g, '/'),
              line: i + 1,
              text: lines[i].trim(),
              // Which root `file` is relative to -- lets a multi-root caller round-trip
              // a hit into read_file with an absolute path. Only set for an alternate
              // root so existing single-root callers see a byte-identical shape.
              ...(altRoot ? { root: altRoot } : {}),
            };
            if (ctx > 0) {
              hit.before = lines.slice(Math.max(0, i - ctx), i);
              hit.after = lines.slice(i + 1, i + 1 + ctx);
            }
            hits.push(hit);
          }
        }
      }
    }
  }

  for (const sr of searchRoots) {
    if (hits.length >= maxMatches) break;
    walk(sr);
  }
  return hits;
}

module.exports = { grepCodebase };
