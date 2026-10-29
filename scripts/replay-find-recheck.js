#!/usr/bin/env node
'use strict';

// Replays the find-string recheck (src/lib/find-recheck.js) over a pipeline's queue against the CURRENT tree.
// Usage: node scripts/replay-find-recheck.js <pipelineDir> <repoRoot>
//
// Only tasks that never merged are meaningful here: a merged task's `find` strings are gone from the tree by definition, so it would "fail" for the
// opposite reason. For the apply-failed ones with a "find string" reason the recheck MUST flag (a miss = a gap in the check); for everything else not yet
// merged it reports how many edit sets the recheck would have stopped before review. Exits 1 when a find-string apply failure is NOT flagged.

const fs = require('fs');
const path = require('path');
const { simulateEdits } = require('../src/lib/find-recheck.js');
const { parseJsonMaybeFenced } = require('../src/json-fence.js');

const [pipelineDir, repoRoot] = process.argv.slice(2);
if (!pipelineDir || !repoRoot) { console.error('usage: replay-find-recheck.js <pipelineDir> <repoRoot>'); process.exit(2); }

const STATES = ['blocked', 'needs-clarification', 'review', 'approved', 'rejected'];
const out = { scanned: 0, groupB: 0, flagged: 0, clean: 0, findFailures: 0, findFailuresFlagged: 0, missed: [] };
for (const state of STATES) {
  const dir = path.join(pipelineDir, 'queue', state);
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { continue; }
  for (const name of names) {
    let t;
    try { t = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { continue; }
    out.scanned += 1;
    let items = null;
    try { const v = parseJsonMaybeFenced(String(t.implementResponse || '')); items = v ? (Array.isArray(v) ? v : [v]) : null; } catch { items = null; }
    if (!items || !items.some((i) => i && i.mode)) continue;
    out.groupB += 1;
    const flags = simulateEdits(items, repoRoot);
    flags.length ? (out.flagged += 1) : (out.clean += 1);
    if (/find string (not found|matches)/i.test(String(t.blockedReason || ''))) {
      out.findFailures += 1;
      flags.length ? (out.findFailuresFlagged += 1) : out.missed.push(`${state}/${t.id}`);
    }
  }
}
console.log(JSON.stringify(out, null, 1));
process.exit(out.missed.length ? 1 : 0);
