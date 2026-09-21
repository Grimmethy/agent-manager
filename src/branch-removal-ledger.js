'use strict';

// branch-removal-ledger.js -- an append-only record of WHY an agent/* branch stopped existing on origin.
//
// Why (2026-09-21, throughput analysis of unmerged/denied branches): 20 of the 65 branch-producing tasks that never reached master were closed by
// task-log-reconcile as "abandoned: branch gone, work lost" with no reason, because the only evidence left was the branch's absence. Every in-app
// path that deletes a branch (merge, Discard, requeue, hub retire, decompose auto-merge) knew why at the moment it did so and threw it away. Checking
// five of the twenty by content, three had their whole diff on master already -- the "lost" label was wrong -- and the rest could not be told apart
// from a deliberate cleanup. This ledger keeps the reason; task-disposition.js reads it when it finds a branch gone.
//
// Format: one JSON object per line in <pipelineDir>/queue/branch-removals.jsonl -- { branch, taskId?, cause, detail?, actor, at }. The Python dashboard
// writes the same shape (python/dashboard/branch_removals.py). Best-effort by design: a failed write must never fail the merge/discard/requeue that
// is the real work, so record() swallows errors and reports them as `false`.

const fs = require('fs');
const path = require('path');

// cause: merged | discarded | superseded-by-requeue | hub-retired | housekeeping
const CAUSES = new Set(['merged', 'discarded', 'superseded-by-requeue', 'hub-retired', 'housekeeping']);
const FILE = 'branch-removals.jsonl';

const ledgerPath = (pipelineDir) => path.join(pipelineDir, 'queue', FILE);
const bare = (branch) => String(branch || '').replace(/^(?:refs\/)?(?:remotes\/)?(?:origin\/)?/, '');

// Returns true when the line was written.
function recordBranchRemoval(pipelineDir, { branch, taskId = null, cause, detail = '', actor = 'pipeline', now = new Date() } = {}) {
  if (!pipelineDir || !branch || !CAUSES.has(cause)) return false;
  try {
    const entry = { branch: bare(branch), taskId, cause, detail: String(detail).slice(0, 300), actor, at: now.toISOString() };
    fs.mkdirSync(path.dirname(ledgerPath(pipelineDir)), { recursive: true });
    fs.appendFileSync(ledgerPath(pipelineDir), `${JSON.stringify(entry)}\n`);
    return true;
  } catch (err) {
    console.warn(`[branch-removal-ledger] could not record removal of ${branch}: ${err.message}`);
    return false;
  }
}

// Every entry, oldest first. A missing file is an empty ledger; a corrupt line is skipped, not fatal.
function readLedger(pipelineDir) {
  let text;
  try { text = fs.readFileSync(ledgerPath(pipelineDir), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); if (e && typeof e.branch === 'string') out.push(e); } catch { /* skip a torn line */ }
  }
  return out;
}

// The most recent removal of `branch` (any spelling: agent/x, origin/agent/x), or null.
function lastRemoval(pipelineDir, branch) {
  if (!pipelineDir || !branch) return null;
  const want = bare(branch);
  const all = readLedger(pipelineDir);
  for (let i = all.length - 1; i >= 0; i--) if (all[i].branch === want) return all[i];
  return null;
}

module.exports = { recordBranchRemoval, readLedger, lastRemoval, CAUSES, FILE, ledgerPath };
