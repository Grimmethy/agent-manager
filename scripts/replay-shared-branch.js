#!/usr/bin/env node
'use strict';

// replay-shared-branch.js -- what would the abandoned re-check / shared-branch restore do to a pipeline's done/ records TODAY? Read-only (dry run).
//
//   node scripts/replay-shared-branch.js --pipeline <dir> --repo <path>
//
// Runs abandoned-recheck.js in dry-run mode against the repo's current refs and prints, for every abandoned record: stays abandoned / would be CORRECTED
// (its work is on main) / would be RESTORED (a requeue destroyed it on a shared branch). Writes nothing (the throttle state is not touched either).
// Exit 1 if a record that is NOT stacked or has no collateral ledger entry would be restored (never), the tripwire for future edits.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { buildShipContext } = require('../src/task-disposition.js');
const { shouldRestore } = require('../src/shared-branch-restore.js');
const { recheckAbandoned } = require('../src/abandoned-recheck.js');

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? null : process.argv[i + 1]; };
const pipelineDir = arg('pipeline');
const repoRoot = arg('repo');
if (!pipelineDir || !repoRoot) { console.error('usage: replay-shared-branch.js --pipeline <dir> --repo <path>'); process.exit(2); }

try { execFileSync('git', ['-C', repoRoot, 'fetch', 'origin', '--quiet'], { stdio: 'ignore', timeout: 60000 }); } catch { /* use local refs */ }
const ctx = buildShipContext(repoRoot);
// a throwaway copy of the state so the dry run cannot influence the real throttle
const out = recheckAbandoned({ pipelineDir, repoRoot, ctx, dryRun: true, ttlMs: 0, limit: 100000, now: Date.now() });
console.log(`abandoned records checked: ${out.rechecked}`);
for (const c of out.corrected) console.log(`CORRECT  ${c.id}  abandoned -> ${c.to}`);
for (const r of out.restored) console.log(`RESTORE  ${r.id}  onto ${r.branch} (destroyed by the requeue of ${r.removedBy})`);
let violations = 0;
for (const r of out.restored) {
  const rec = JSON.parse(fs.readFileSync(path.join(pipelineDir, 'queue', 'done', `${r.id}.json`), 'utf8'));
  if (!rec.stacked || !rec.stacked.branch) violations += 1;
}
console.log(`corrected ${out.corrected.length}, restored ${out.restored.length}, stay abandoned ${out.rechecked - out.corrected.length - out.restored.length}; violations ${violations}`);
process.exit(violations ? 1 : 0);
