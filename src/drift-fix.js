'use strict';

// Turns drift-scan.js's flagged output (queue/drift-flags.json) into real, grounded fix
// material for the doc_drift_fix task source (2026-09-06, "Project Documentation"
// concept). drift-scan.js already correctly detects a static doc list drifting from a
// live registry, every watchdog tick -- confirmed live: README.md's task-source table
// was silently missing 6 real registered sources despite claiming to list "every
// registered source". Nothing ever turned that detection into a fix; a human had to
// notice queue/drift-flags.json or the watchdog log line themselves. This module is the
// pure, deterministic half (mirrors forensic-bundle.js/debrief-bundle.js's own split):
// it re-locates the exact real insertion anchor and any stale row's exact text, so the
// implement pass never has to search for or reconstruct an exact "find" string itself
// (see prompts.js's groupBJsonInstructions -- "find" must be copied character-for-
// character from real content it's shown, or the edit silently fails to apply).

const fs = require('fs');
const path = require('path');
const { PAIRS } = require('./drift-scan.js');

function readFlags(pipelineDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(pipelineDir, 'queue', 'drift-flags.json'), 'utf8'));
  } catch {
    return [];
  }
}

// A flagged pair's real fixable state -- excludes a bare `error` entry (drift-scan.js
// itself couldn't run the check at all, e.g. a marker went stale; that needs a human to
// look at drift-scan.js's own PAIRS definition, not a doc edit) and excludes a pair with
// neither missing nor stale names (should not occur -- scan.js only flags a pair with a
// real diff -- but never trust that blindly here).
function fixableFlags(flags) {
  return (flags || []).filter((f) => f && !f.error
    && ((Array.isArray(f.missingFromStatic) && f.missingFromStatic.length)
      || (Array.isArray(f.staleInStatic) && f.staleInStatic.length)));
}

// Unique to a real gap-state -- once actually fixed, the next scan reports a different
// (smaller, or empty) missing/stale set, so this signature can never recur. Safe to
// cover "once, forever", same discipline as pipeline_self_audit's own signature coverage.
function signatureFor(flag) {
  const missing = [...(flag.missingFromStatic || [])].sort().join(',');
  const stale = [...(flag.staleInStatic || [])].sort().join(',');
  return `${flag.label}::missing=${missing}::stale=${stale}`;
}

// Re-locates the exact static block using the SAME markers drift-scan.js's own PAIRS
// entry used to find it in the first place -- never hand-duplicated, so this can never
// drift from that file's own definition. Returns null (skip, don't guess) if the pair
// definition or the file itself has moved on since the flag was written.
function buildFixEvidence(repoRoot, flag) {
  const pair = PAIRS.find((p) => p.label === flag.label);
  if (!pair) return null;
  const staticPath = path.join(repoRoot, pair.staticFile);
  let text;
  try { text = fs.readFileSync(staticPath, 'utf8'); } catch { return null; }

  const startIdx = text.indexOf(pair.staticStartMarker);
  const endIdx = startIdx === -1 ? -1 : text.indexOf(pair.staticEndMarker, startIdx);
  if (startIdx === -1 || endIdx === -1) return null;

  const block = text.slice(startIdx, endIdx);
  const rows = block.split('\n').filter((l) => l.trim().startsWith('|'));
  if (!rows.length) return null;

  // The real last few rows, verbatim -- a short, safe insertion anchor. Deliberately NOT
  // staticEndMarker itself (the heading text): asking the model to "find" a bare heading
  // risks matching the wrong occurrence if that text recurs elsewhere in the file, where
  // the last real table row is guaranteed unique to this exact table.
  const insertAfter = rows.slice(-3).join('\n');

  // Stale rows' exact text, pre-located -- the implement pass is simply told to delete
  // these verbatim lines, never asked to find them itself.
  const staleRows = (flag.staleInStatic || [])
    .map((name) => rows.find((r) => r.includes(`\`${name}\``)))
    .filter(Boolean);

  return { staticFile: pair.staticFile, insertAfter, staleRows };
}

module.exports = { readFlags, fixableFlags, signatureFor, buildFixEvidence };
