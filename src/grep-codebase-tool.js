'use strict';

// Read-only, dependency-free codebase search for a plan pass to call as a tool (see
// ornith-tool-client.js). Same style/pattern as a hand-rolled synchronous directory walk:
// no npm packages, hard match cap. repoRoot and the allowed search dirs come from
// config.js (AGENT_MANAGER_REPO_ROOT / AGENT_MANAGER_GREP_DIRS), not hardcoded.

const fs = require('fs');
const path = require('path');
const { getConfig } = require('./config.js');

const MATCH_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx'];
const MAX_MATCHES = 20;

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
          if (lines[i].includes(query)) {
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
