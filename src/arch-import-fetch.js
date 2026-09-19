'use strict';

// Harness-side search execution for the arch_import task source (see ADR-0020,
// docs/arch-import-pipeline.md). Mirrors project-search-fetch.js's role (the local model proposes
// search terms in the plan pass, the harness runs them, the implement pass gets real
// results) but the search target here is agent-manager's OWN repo, not an external API --
// so this is synchronous local grep via grep-codebase-tool.js's grepCodebase(), not an
// HTTP call.
//
// CLI: node arch-import-fetch.js <queries.json>   where queries.json is {"queries": [...]}
// Writes a JSON object to stdout: { hits: [{file, line, text, query}], files: [{path, content}] }
// -- `hits` is every grep match (for the implement prompt to see WHERE a term appears);
// `files` is the deduped, FULL content of every distinct file that matched, capped by
// MAX_CONTENT_CHARS so a query that matches a huge file (or many files) can't blow the
// model's context window the same way deep_dive's uncapped community content once did
// (see task-sources.js's DEEP_DIVE_CONTEXT_BUDGET_CHARS fix, 2026-07-21) -- fixed from the
// start here instead of needing the same incident to happen twice.
//
// Multi-repo (2026-09-04): `fetchForQueries(queries, { roots })` optionally also searches
// each additional repo in `roots` (see accessible-roots.js) -- a loaded
// AGENT_MANAGER_REGISTER_PATH plugin's own repo, not just this one. Root-caused via a stuck
// adhoc task ("function_length_fix recursively splits") whose real fix site,
// function-length-review.js, lives entirely in agent-manager-hygiene: every caller of this
// function searched agent-manager's own repo only, so the model never saw the file it was
// told to edit and hallucinated a change to an unrelated one instead. `roots` omitted (every
// pre-existing caller) is byte-identical to the old single-repo behavior. A hit/file from a
// non-primary root carries `root` (the absolute repo path) so callers can label it -- see
// prompts.js's formatFileContents, which refuses to let a cross-repo file look locally
// editable.

const fs = require('fs');
const path = require('path');
const { getConfig } = require('./config.js');
const { grepCodebase } = require('./grep-codebase-tool.js');
const { windowedContent } = require('./task-anchor-files.js');

const MAX_HITS_PER_QUERY = 8;
// Smaller than deep_dive's DEEP_DIVE_CONTEXT_BUDGET_CHARS (24000) -- this content shares
// the implement prompt's context budget with the original deep_dive item's own
// title/rationale AND the plan-pass text from the same task, unlike deep_dive's own
// prompt which is otherwise mostly just this content. Calibrated conservative from the
// start rather than needing a context-overflow incident to find the right number, the
// way deep_dive's budget did.
const MAX_CONTENT_CHARS = 12000;

// roots: optional string[] of additional repo roots to ALSO search (accessible-roots.js) --
// roots[0], if given, must be the primary repo (repoRoot); anything after it is an extra
// accessible repo (a loaded plugin, see AGENT_MANAGER_REGISTER_PATH). Omitted entirely,
// this is byte-identical to the pre-2026-09-04 single-repo behavior. The primary repo keeps
// its existing per-dir loop (AGENT_MANAGER_GREP_DIRS); an extra root gets ONE whole-repo
// grepCodebase call per query -- it has no per-repo dirs allowlist of its own (see
// grep-codebase-tool.js's own comment on an alternate root skipping AGENT_MANAGER_GREP_DIRS),
// so multiplying by a dirs list that doesn't apply there would be meaningless, not more
// thorough.
function fetchForQueries(queries, { roots } = {}) {
  const { repoRoot, grepAllowedDirs } = getConfig();
  const extraRoots = (Array.isArray(roots) ? roots : [repoRoot]).slice(1);
  const hits = [];
  // Keyed by `${root||''}::${file}` so two repos with the same relative path (e.g. both
  // happen to have a src/config.js) are never conflated into one fetched-content entry.
  const matchedFiles = new Map();

  for (const query of queries) {
    for (const dir of grepAllowedDirs) {
      const raw = grepCodebase({ query, dir });
      const results = (Array.isArray(raw) ? raw : []).slice(0, MAX_HITS_PER_QUERY);
      for (const r of results) {
        hits.push({ ...r, query });
        matchedFiles.set(`${r.root || ''}::${r.file}`, { file: r.file, root: r.root || null });
      }
    }
    for (const root of extraRoots) {
      const raw = grepCodebase({ query, root });
      const results = (Array.isArray(raw) ? raw : []).slice(0, MAX_HITS_PER_QUERY);
      for (const r of results) {
        hits.push({ ...r, query });
        matchedFiles.set(`${r.root || root}::${r.file}`, { file: r.file, root: r.root || root });
      }
    }
  }

  const files = [];
  let budgetUsed = 0;
  // Files most-matched-first isn't tracked separately from hit order above, but Map
  // insertion order already roughly reflects match density (files that matched more
  // queries/hits appear earlier via repeated hits) -- good enough for a budget cutoff,
  // no need for a second ranking pass.
  //
  // Line-anchored windowing (2026-09-19, ghost-in-the-machine retroactive audit of the
  // pipeline_debrief blocked/ bucket): this used to require a matched file's ENTIRE content
  // to fit the shared MAX_CONTENT_CHARS budget or be skipped outright -- fine for this
  // module's original small-utility-file callers, but structurally unable to ever include
  // agent-manager's own hot files (review-task.js 79KB, local-draft.js 106KB, task-
  // sources.js 187KB, prompts.js 110KB, app.py 214KB -- every one 7-18x the whole budget),
  // which is exactly what a determinism audit (pipeline_debrief/pipeline_forensics, the
  // other real callers via kind:'archImport') keeps needing to cite. Confirmed live: 15 of
  // 28 blocked pipeline_debrief tasks showed real grep hits (up to 40) but 0 files fetched --
  // AVAILABLE FILES came back empty every time a hit landed in one of these files, leaving
  // the model to either (correctly) say no file can be cited, or reach for a plausible-
  // sounding filename from the codebase's own naming conventions -- flagged, rightly, as
  // fabrication. Reusing task-anchor-files.js's own windowedContent() (built for the
  // identical "oversized file, real hit lines available" shape on the adhoc-drafting side)
  // windows each match to the lines actually hit instead of demanding the whole file.
  for (const { file: relPath, root } of matchedFiles.values()) {
    if (budgetUsed >= MAX_CONTENT_CHARS) break;
    let content;
    try {
      content = fs.readFileSync(path.join(root || repoRoot, relPath), 'utf8');
    } catch {
      continue;
    }
    const hitLines = hits
      .filter((h) => h.file === relPath && (h.root || null) === (root || null))
      .map((h) => h.line)
      .filter((n) => Number.isInteger(n));
    let windowed = hitLines.length ? windowedContent(content, MAX_CONTENT_CHARS, { hitLines }) : content;
    const remaining = MAX_CONTENT_CHARS - budgetUsed;
    if (windowed.length > remaining) {
      // windowedContent's own hit-line path has a larger internal cap than any single
      // caller's remaining shared budget might allow (by design -- it doesn't know about
      // this budget) -- a final defensive slice, not a silent full-file skip like before.
      windowed = `${windowed.slice(0, Math.max(0, remaining))}\n...[window truncated to fit the shared budget]`;
    }
    if (!windowed.trim()) continue;
    files.push(root ? { path: relPath, root, content: windowed } : { path: relPath, content: windowed });
    budgetUsed += windowed.length;
  }

  return { hits, files };
}

if (require.main === module) {
  const queriesPath = process.argv[2];
  if (!queriesPath) {
    console.error('usage: node arch-import-fetch.js <queries.json>');
    process.exit(1);
  }
  const { queries } = JSON.parse(fs.readFileSync(queriesPath, 'utf8'));
  // A caller that hands a bare string (e.g. a PowerShell pipeline that silently collapsed a
  // single-match array to a scalar before serializing) must never reach fetchForQueries's
  // `for (const query of queries)` as-is -- iterating a STRING iterates its CHARACTERS, each
  // treated as its own "query" (see local-worker.ps1's matching fix, 2026-07-21, for the
  // real incident this reproduces). Normalize defensively at this boundary instead of
  // trusting every future caller to get the array-wrapping right upstream.
  const normalizedQueries = Array.isArray(queries) ? queries : (queries ? [queries] : []);
  console.log(JSON.stringify(fetchForQueries(normalizedQueries)));
}

module.exports = { fetchForQueries, MAX_CONTENT_CHARS };
