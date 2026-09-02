'use strict';

// Standing sweep that keeps every applied task's pipeline log CLOSED. `applied` used to be
// the last event in a done task's history, so an update audit could not tell, from the log
// alone, whether a task's code reached origin/<main>, is still on an unmerged agent/<id>
// branch, or was applied to a branch that has since vanished (lost work). This resolves the
// true state from git (task-disposition.js) and appends a terminal event -- self-healing,
// so the log never drifts again.
//
// Per-tick cost is bounded by a state file (<pipelineDir>/task-log-reconcile-state.json):
// once a record has a non-`pending-merge` terminal event its id is remembered and never
// re-read; each tick only reads records whose id is new, plus the small set previously
// left at `pending-merge` (re-checked in case the branch was merged since). One git
// harvest per run builds the whole "what shipped / what branches exist" picture
// (buildShipContext) so there are zero per-record git calls.
//
// Flags:
//   --report    print the pending-merge and abandoned lists to stderr (for a human audit)
//   --backfill  ignore the state file, walk every record including the dated
//               queue/done/_archived/<YYYY-MM>/ buckets, and `git fetch origin` first
//   --fetch     `git fetch origin` before resolving (default off -- trusts local refs)
//   --dry-run   resolve and report, write nothing (state file included)

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { getConfig } = require('./config.js');
const { appendHistoryEvent } = require('./task-history.js');
const { resolveDisposition, buildShipContext, TERMINAL_STAGES, lastAppliedEvent } = require('./task-disposition.js');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function statePath(pipelineDir) {
  // Under queue/ -- wholesale-gitignored pipeline state, like the rest of the queue dirs.
  return path.join(pipelineDir, 'queue', 'task-log-reconcile-state.json');
}

function loadState(pipelineDir) {
  const s = readJson(statePath(pipelineDir)) || {};
  return {
    resolvedIds: new Set(Array.isArray(s.resolvedIds) ? s.resolvedIds : []),
    pendingIds: new Set(Array.isArray(s.pendingIds) ? s.pendingIds : []),
  };
}

function saveState(pipelineDir, state) {
  const out = {
    updatedAt: new Date().toISOString(),
    resolvedIds: [...state.resolvedIds].sort(),
    pendingIds: [...state.pendingIds].sort(),
  };
  try { fs.writeFileSync(statePath(pipelineDir), JSON.stringify(out, null, 2)); } catch { /* best-effort */ }
}

// { id, file } for every done record the sweep should consider this run.
function candidateRecords(doneDir, { backfill, state }) {
  const out = [];
  const seen = new Set();
  const pushDir = (dir, terminalDir) => {
    let names;
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      const id = n.slice(0, -5);
      if (seen.has(id)) continue;
      // Incremental: skip a record already resolved to a stable terminal state -- unless a
      // full backfill was asked for. `_archived_no_action` is terminal by definition.
      if (!backfill && state.resolvedIds.has(id) && !state.pendingIds.has(id)) continue;
      if (!backfill && terminalDir && state.resolvedIds.has(id)) continue;
      seen.add(id);
      out.push({ id, file: path.join(dir, n) });
    }
  };
  pushDir(doneDir, false);
  pushDir(path.join(doneDir, '_archived_no_action'), true);
  if (backfill) {
    const archived = path.join(doneDir, '_archived');
    let months = [];
    try { months = fs.readdirSync(archived); } catch { /* none */ }
    for (const m of months) pushDir(path.join(archived, m), true);
  }
  return out;
}

function reconcile({ pipelineDir, repoRoot, argv = [] }) {
  const report = argv.includes('--report');
  const backfill = argv.includes('--backfill');
  const dryRun = argv.includes('--dry-run');
  const doFetch = backfill || argv.includes('--fetch');
  const doneDir = path.join(pipelineDir, 'queue', 'done');

  if (doFetch && repoRoot) {
    try { execFileSync('git', ['-C', repoRoot, 'fetch', 'origin', '--quiet'], { stdio: 'ignore', timeout: 60000 }); } catch { /* offline -- use local refs */ }
  }

  const state = loadState(pipelineDir);
  const ctx = repoRoot ? buildShipContext(repoRoot) : null;

  const summary = { scanned: 0, resolved: 0, merged: 0, 'applied-direct': 0, filed: 0, noop: 0, 'pending-merge': 0, abandoned: 0, errors: 0 };
  const pendingList = [];
  const abandonedList = [];

  for (const { id, file } of candidateRecords(doneDir, { backfill, state })) {
    const record = readJson(file);
    if (record === null) { summary.errors += 1; continue; }
    summary.scanned += 1;

    let outcome;
    try {
      outcome = resolveDisposition(record, { repoRoot, ctx });
    } catch (err) {
      console.error(`task-log-reconcile: resolve failed for ${id}: ${err.message}`);
      summary.errors += 1;
      continue;
    }
    if (!outcome) {
      // Stable states that need no further work: already carries a non-pending terminal
      // event, OR the record was never applied at all (a blocked / needs-clarification task
      // that reached done/). Remember either so it is not re-read every tick -- without this
      // the ~2000 never-applied done records get a full readdir+parse pass forever.
      const tail = Array.isArray(record.history) && record.history[record.history.length - 1];
      const closed = tail && TERMINAL_STAGES.has(tail.stage) && tail.stage !== 'pending-merge';
      if (closed || !lastAppliedEvent(record.history)) {
        state.resolvedIds.add(id); state.pendingIds.delete(id);
      }
      continue;
    }

    const tail = record.history[record.history.length - 1];
    const alreadyPending = tail && tail.stage === 'pending-merge' && outcome.stage === 'pending-merge';
    if (!alreadyPending && !dryRun) {
      appendHistoryEvent(record, outcome.stage, outcome.detail);
      record.terminalDisposition = outcome.stage;
      if (outcome.stage === 'merged' && !record.mergedAt) {
        record.mergedAt = new Date().toISOString();
        record.mergedAtSource = 'task-log-reconcile';
      }
      try {
        fs.writeFileSync(file, JSON.stringify(record, null, 2));
      } catch (err) {
        console.error(`task-log-reconcile: write failed for ${id}: ${err.message}`);
        summary.errors += 1;
        continue;
      }
    }

    if (!alreadyPending) { summary.resolved += 1; summary[outcome.stage] = (summary[outcome.stage] || 0) + 1; }
    if (outcome.stage === 'pending-merge') {
      state.pendingIds.add(id); state.resolvedIds.delete(id);
      pendingList.push(`${record.id} -- ${outcome.detail}`);
    } else {
      state.resolvedIds.add(id); state.pendingIds.delete(id);
      if (outcome.stage === 'abandoned') abandonedList.push(`${record.id} -- ${outcome.detail}`);
    }
  }

  if (!dryRun) saveState(pipelineDir, state);

  if (report) {
    if (pendingList.length) {
      console.error(`\n[task-log-reconcile] ${pendingList.length} task(s) PENDING MERGE (agent/<id> branch ahead of main):`);
      for (const l of pendingList) console.error(`  ${l}`);
    }
    if (abandonedList.length) {
      console.error(`\n[task-log-reconcile] ${abandonedList.length} task(s) ABANDONED (applied, branch gone, not on main -- work lost):`);
      for (const l of abandonedList) console.error(`  ${l}`);
    }
    if (!pendingList.length && !abandonedList.length) console.error('[task-log-reconcile] no pending-merge or abandoned tasks this pass.');
  }

  return summary;
}

module.exports = { reconcile, candidateRecords, loadState };

if (require.main === module) {
  let cfg;
  try { cfg = getConfig(); } catch (e) {
    process.stderr.write(`task-log-reconcile: ${e.message}\n`);
    process.exit(0);
  }
  const summary = reconcile({ pipelineDir: cfg.pipelineDir, repoRoot: cfg.repoRoot, argv: process.argv.slice(2) });
  process.stdout.write(JSON.stringify(summary));
}
