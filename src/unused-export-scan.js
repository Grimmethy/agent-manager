'use strict';

// Unused-export scanner. A small, dependency-free, purpose-built scanner (no vulture/knip
// needed) that flags low-usage CommonJS exports for downstream Ornith triage. It attaches
// each candidate's REAL call sites (not just a bare "unused" claim), because that bare claim
// is exactly the false-positive trap documented in docs/ornith-delegation.md (barrel
// re-exports, factory patterns, etc. all look "unused" to naive grep but aren't) -- the
// triage task needs the actual call sites to judge; this script only gathers them.
//
// Generalized out of TaxHarvest: repoRoot and the scan/search dirs come from config.js
// (AGENT_MANAGER_REPO_ROOT, AGENT_MANAGER_UNUSED_SCAN_DIRS / _SEARCH_DIRS, both defaulting
// to AGENT_MANAGER_GREP_DIRS), not hardcoded. Output goes to the same file the built-in
// `unused_export` task source reads: <pipelineDir>/queue/dead-code-flags.json.
//
// Scope note: export DEFINITIONS are detected for CommonJS only (module.exports / exports.x),
// so .js/.jsx define candidates; call sites are searched across .js/.jsx/.ts/.tsx so a symbol
// referenced from TypeScript still counts. ESM/TS `export` *definitions* are not detected.

const fs = require('fs');
const path = require('path');
const { getConfig } = require('./config.js');

const DEFINE_EXTENSIONS = ['.js', '.jsx'];
const SEARCH_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'queue', 'instances', 'dist', 'build', 'coverage']);
const MAX_CALL_SITES = 20;
const LOW_USAGE_THRESHOLD = 2; // flag exports with this many or fewer external call sites

function listSourceFiles(dir, extensions) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const result = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        result.push(...listSourceFiles(path.join(dir, entry.name), extensions));
      } else if (entry.isFile() && extensions.some((e) => entry.name.endsWith(e))) {
        result.push(path.resolve(dir, entry.name));
      }
    }
    return result;
  } catch {
    return [];
  }
}

function extractExports(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const set = new Set();

  for (const m of text.matchAll(/module\.exports\s*=\s*\{([^}]*)\}/g)) {
    const inner = m[1];
    for (const part of inner.split(',')) {
      const trimmed = part.trim();
      if (!trimmed || trimmed.includes(':')) continue; // skip computed/renamed exports
      set.add(trimmed);
    }
  }

  for (const m of text.matchAll(/module\.exports\.(\w+)\s*=/g)) {
    const name = m[1];
    if (name.length > 0 && !set.has(name)) set.add(name);
  }

  for (const m of text.matchAll(/(?<!module\.)exports\.(\w+)\s*=/g)) {
    const name = m[1];
    if (name.length > 0 && !set.has(name)) set.add(name);
  }

  return Array.from(set).filter((n) => n.trim().length > 0);
}

function countCallSites(symbol, definingFile, searchRoots, repoRoot) {
  const escapedSymbol = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const wordBoundaryRe = new RegExp('\\b' + escapedSymbol + '\\b', 'm');
  const absDefiningFile = path.resolve(definingFile);
  const hits = [];

  function walk(dir) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (hits.length >= MAX_CALL_SITES) return;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          walk(fullPath);
        } else if (entry.isFile() && SEARCH_EXTENSIONS.some((e) => entry.name.endsWith(e))) {
          if (fullPath === absDefiningFile) continue; // never count the definition itself
          try {
            const text = fs.readFileSync(fullPath, 'utf8');
            let lineNum = 0;
            for (const line of text.split('\n')) {
              lineNum++;
              if (hits.length >= MAX_CALL_SITES) return;
              if (wordBoundaryRe.test(line)) {
                hits.push({ file: path.relative(repoRoot, fullPath).replace(/\\/g, '/'), line: lineNum });
              }
            }
          } catch {}
        }
      }
    } catch {}
  }

  for (const root of searchRoots) {
    if (hits.length >= MAX_CALL_SITES) break;
    walk(root);
  }
  return hits.slice(0, MAX_CALL_SITES);
}

function scan() {
  const { repoRoot, unusedScanDirs, unusedSearchDirs } = getConfig();
  const scanRoots = unusedScanDirs.map((d) => path.join(repoRoot, d));
  const searchRoots = unusedSearchDirs.map((d) => path.join(repoRoot, d));

  const candidates = [];
  const scannedAt = new Date().toISOString();
  for (const dir of scanRoots) {
    for (const file of listSourceFiles(dir, DEFINE_EXTENSIONS)) {
      for (const name of extractExports(file)) {
        const callSites = countCallSites(name, file, searchRoots, repoRoot);
        if (callSites.length <= LOW_USAGE_THRESHOLD) {
          candidates.push({
            symbol: name,
            definedIn: path.relative(repoRoot, file).replace(/\\/g, '/'),
            callSites,
            scannedAt,
          });
        }
      }
    }
  }
  return candidates;
}

function main() {
  const { pipelineDir } = getConfig();
  const resultsPath = path.join(pipelineDir, 'queue', 'dead-code-flags.json');
  const candidates = scan();
  fs.mkdirSync(path.dirname(resultsPath), { recursive: true });
  fs.writeFileSync(resultsPath, JSON.stringify(candidates, null, 2));
  console.log(`scanned, found ${candidates.length} low-usage export candidate(s), written to ${resultsPath}`);
}

if (require.main === module) { main(); }

module.exports = { scan, extractExports, countCallSites };
