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

function grepCodebase({ query, dir }) {
  const { repoRoot, grepAllowedDirs } = getConfig();
  if (!grepAllowedDirs.includes(dir) || !query) return [];

  const searchRoot = path.join(repoRoot, dir);
  const hits = [];

  function walk(current) {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (hits.length >= MAX_MATCHES) return;
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
          if (hits.length >= MAX_MATCHES) return;
          if (lineMatches(lines[i], query)) {
            hits.push({
              file: path.relative(repoRoot, fullPath).replace(/\\/g, '/'),
              line: i + 1,
              text: lines[i].trim(),
            });
          }
        }
      }
    }
  }

  walk(searchRoot);
  return hits;
}

module.exports = { grepCodebase };
