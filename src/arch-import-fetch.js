'use strict';

// Harness-side search execution for the arch_import task source (see ADR-0020,
// docs/arch-import-pipeline.md). Mirrors project-search-fetch.js's role (Ornith proposes
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

const fs = require('fs');
const path = require('path');
const { getConfig } = require('./config.js');
const { grepCodebase } = require('./grep-codebase-tool.js');

const MAX_HITS_PER_QUERY = 8;
// Smaller than deep_dive's DEEP_DIVE_CONTEXT_BUDGET_CHARS (24000) -- this content shares
// the implement prompt's context budget with the original deep_dive item's own
// title/rationale AND the plan-pass text from the same task, unlike deep_dive's own
// prompt which is otherwise mostly just this content. Calibrated conservative from the
// start rather than needing a context-overflow incident to find the right number, the
// way deep_dive's budget did.
const MAX_CONTENT_CHARS = 12000;

function fetchForQueries(queries) {
  const { repoRoot, grepAllowedDirs } = getConfig();
  const hits = [];
  const matchedFiles = new Set();

  for (const query of queries) {
    for (const dir of grepAllowedDirs) {
      const results = grepCodebase({ query, dir }).slice(0, MAX_HITS_PER_QUERY);
      for (const r of results) {
        hits.push({ ...r, query });
        matchedFiles.add(r.file);
      }
    }
  }

  const files = [];
  let budgetUsed = 0;
  // Files most-matched-first isn't tracked separately from hit order above, but Set
  // insertion order already roughly reflects match density (files that matched more
  // queries/hits appear earlier via repeated hits) -- good enough for a budget cutoff,
  // no need for a second ranking pass.
  for (const relPath of matchedFiles) {
    if (budgetUsed >= MAX_CONTENT_CHARS) break;
    let content;
    try {
      content = fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
    } catch {
      continue;
    }
    if (budgetUsed + content.length > MAX_CONTENT_CHARS) continue;
    files.push({ path: relPath, content });
    budgetUsed += content.length;
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
  console.log(JSON.stringify(fetchForQueries(queries || [])));
}

module.exports = { fetchForQueries };
