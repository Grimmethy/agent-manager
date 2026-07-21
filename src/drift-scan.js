'use strict';

// Deterministic cross-file consistency scanner. Catches "a static list mirrors a live
// registry" bugs -- e.g. the dashboard's Job List tab (a hand-maintained JOB_TYPES array
// in index.html, commented as mirroring src/task-sources.js's registerTaskSource calls)
// silently missing two sources that got registered later (found live 2026-07-20/21).
// This is a pure set-difference check, not a judgment call, so it's a plain script --
// no LLM involved, same reasoning as unused-export-scan.js's own non-LLM-scan-then-flag
// split. Extend PAIRS below when a new "mirrors X" static list is introduced elsewhere.
//
// Deliberately NOT a general "find any comment saying mirrors" auto-discovery mechanism:
// that adds real parsing risk (false matches, ambiguous scope) for marginal convenience.
// Each pair names its own two regex extractors explicitly, so the failure mode of a bad
// pattern is "this one check silently finds nothing," not "the scanner crashes or lies."

const fs = require('fs');
const path = require('path');
const { getConfig } = require('./config.js');

function extractAll(text, regex) {
  const out = new Set();
  for (const m of text.matchAll(regex)) out.add(m[1]);
  return out;
}

// String markers, not regexes, for locating the static block -- this only ever needs to
// find ONE array literal's boundaries in a known file, and indexOf can't misbehave the
// way a stateful regex.lastIndex slice easily can.
function sliceBetween(text, startMarker, endMarker) {
  const startIdx = text.indexOf(startMarker);
  if (startIdx === -1) return null;
  const endIdx = text.indexOf(endMarker, startIdx + startMarker.length);
  if (endIdx === -1) return null;
  return text.slice(startIdx, endIdx + endMarker.length);
}

// Matched by PRIORITY NUMBER, not by source-name string. The registry key passed to
// registerTaskSource() and the human-facing `source:` label a next*Task() actually
// stamps on its tasks are deliberately NOT always the same string (secondbrain's key is
// 'secondbrain' but its label is 'inbox'; unused_export's key is 'unused_export' but its
// label is 'deadcode_triage'; adhoc's key is 'adhoc' but its label is 'manual') -- these
// are real, intentional aliases, confirmed by reading every next*Task() function, not a
// second bug. Priority is the one value guaranteed to be assigned exactly once and never
// aliased, so it's the only safe join key between the two files.
const PAIRS = [
  {
    label: 'Dashboard Job List tab vs task-sources.js registry',
    staticFile: 'python/dashboard/templates/index.html',
    staticStartMarker: 'const JOB_TYPES = [',
    staticEndMarker: '];',
    staticValueRegex: /priority:\s*(\d+)/g,
    sourceFile: 'src/task-sources.js',
    sourceValueRegex: /registerTaskSource\('[^']+',\s*\{\s*priority:\s*(\d+)/g,
  },
];

function checkPair(repoRoot, pair) {
  const staticPath = path.join(repoRoot, pair.staticFile);
  const sourcePath = path.join(repoRoot, pair.sourceFile);
  const base = { label: pair.label, staticFile: pair.staticFile, sourceFile: pair.sourceFile };

  let staticText, sourceText;
  try {
    staticText = fs.readFileSync(staticPath, 'utf8');
  } catch (e) {
    return { ...base, error: `could not read ${pair.staticFile}: ${e.message}` };
  }
  try {
    sourceText = fs.readFileSync(sourcePath, 'utf8');
  } catch (e) {
    return { ...base, error: `could not read ${pair.sourceFile}: ${e.message}` };
  }

  const staticBlock = sliceBetween(staticText, pair.staticStartMarker, pair.staticEndMarker);
  if (staticBlock === null) {
    return { ...base, error: `could not locate '${pair.staticStartMarker}' ... '${pair.staticEndMarker}' block in ${pair.staticFile} -- marker text may have changed` };
  }

  const staticValues = extractAll(staticBlock, pair.staticValueRegex);
  const sourceValues = extractAll(sourceText, pair.sourceValueRegex);

  if (staticValues.size === 0) {
    return { ...base, error: `matched the static block in ${pair.staticFile} but extracted zero values -- staticValueRegex may be stale` };
  }
  if (sourceValues.size === 0) {
    return { ...base, error: `extracted zero values from ${pair.sourceFile} -- sourceValueRegex may be stale` };
  }

  const missingFromStatic = [...sourceValues].filter((v) => !staticValues.has(v)).sort();
  const staleInStatic = [...staticValues].filter((v) => !sourceValues.has(v)).sort();

  return { ...base, missingFromStatic, staleInStatic };
}

function scan(repoRoot) {
  return PAIRS.map((pair) => checkPair(repoRoot, pair));
}

function main() {
  const { repoRoot, pipelineDir } = getConfig();
  const results = scan(repoRoot);
  const flagged = results.filter((r) => r.error || r.missingFromStatic.length || r.staleInStatic.length);

  const outPath = path.join(pipelineDir, 'queue', 'drift-flags.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(flagged, null, 2));

  if (flagged.length === 0) {
    console.log(`drift-scan: clean, ${results.length} pair(s) checked, 0 flagged.`);
    process.exit(0);
  }

  console.log(`drift-scan: ${flagged.length}/${results.length} pair(s) flagged, written to ${outPath}`);
  for (const r of flagged) {
    console.log(`\n${r.label}`);
    if (r.error) {
      console.log(`  ERROR: ${r.error}`);
      continue;
    }
    if (r.missingFromStatic.length) console.log(`  missing from ${r.staticFile}: ${r.missingFromStatic.join(', ')}`);
    if (r.staleInStatic.length) console.log(`  stale in ${r.staticFile} (no longer registered): ${r.staleInStatic.join(', ')}`);
  }
  process.exit(1);
}

if (require.main === module) { main(); }

module.exports = { scan, checkPair, extractAll, sliceBetween };
