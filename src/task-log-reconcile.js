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
//   --report     print the pending-merge and abandoned lists to stderr (for a human audit)
//   --backfill   ignore the state file, walk every record including the dated
//                queue/done/_archived/<YYYY-MM>/ buckets
//   --no-fetch   skip the `git fetch origin` before resolving (default: always fetch, see
//                2026-09-08 fix below -- this is the explicit opt-out for an intentionally
//                offline/sandboxed run, not the normal path)
//   --dry-run    resolve and report, write nothing (state file included)
//   --reclassify one-shot: re-resolve records ALREADY closed as `noop` or `abandoned` -- a
//                `noop` may have been a clean FALSE-POSITIVE review dismissal (recorded
//                before the `dismissed` stage existed), and an `abandoned` may have been a
//                false "branch gone" read from a stale local ref cache (2026-09-08 fix
//                below). Implies --backfill enumeration. Idempotent: a second run finds
//                nothing left to move.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { getConfig } = require('./config.js');
const { appendHistoryEvent } = require('./task-history.js');
const { resolveDisposition, buildShipContext, STABLE_TERMINAL_STAGES, lastAppliedEvent } = require('./task-disposition.js');
const { runAmplificationSweep } = require('./incident-amplification.js');

// Incident Amplification's automatic trigger (2026-09-08, Grimmethy: "this system should
// be aggressive... we lose a ton of machine time to these requeues. If we can reduce them
// before they even happen we gain a huge efficiency boost.") -- a pipeline_self_audit /
// pipeline_forensics_fix task landing as a real, confirmed code fix IS a confirmed
// systemic root cause BY CONSTRUCTION (that is the whole point of those two sources: a
// detector found a real cluster/pattern, forensics diagnosed it, this task fixed it) --
// no human/Chat conversation needs to notice it. This is the automatic candidate the
// concept's own "what done looks like" section named and the original implementation
// plan explicitly deferred (needed a way to derive a search pattern without a fresh model
// call, which risked GPU contention and was unproven).
//
// Deterministic derivation, no model call: both sources register no custom `apply()`
// (confirmed via task-sources.js), so their implementResponse is always Group B JSON --
// {file, mode: 'create'|'edit'|'delete', find, replace, content}[] (apply-group-b.js).
// For an 'edit' item, `replace` IS the literal code the fix introduced -- exactly the
// fix pattern a sibling site would also be missing. Picks the longest non-trivial line
// from the first edit/create item that has one; every touched file is excluded from the
// sweep's own results (they're already fixed, not a sibling).
const TRIVIAL_LINE_RE = /^[{}();,[\]]*$/;
function pickRepresentativeLine(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const candidates = lines.filter((l) => l.length >= 15 && !TRIVIAL_LINE_RE.test(l) && !l.startsWith('//') && !l.startsWith('#'));
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0].slice(0, 200);
}

function deriveAmplificationRequestFromFix(record) {
  let items;
  try {
    items = JSON.parse(record.implementResponse);
  } catch {
    return null; // not Group B JSON (or implementResponse was pruned) -- nothing to derive
  }
  if (!Array.isArray(items)) items = [items];

  const excludeFiles = [];
  let query = null;
  for (const item of items) {
    if (!item || !item.file) continue;
    excludeFiles.push(item.file);
    if (query) continue;
    const text = item.mode === 'edit' ? item.replace : item.mode === 'create' ? item.content : null;
    const line = pickRepresentativeLine(text);
    if (line) query = line;
  }
  if (!query) return null;

  return {
    query,
    excludeFiles,
    rootCauseSummary: record.title || (record.promptContext && record.promptContext.signature) || 'confirmed systemic fix',
  };
}

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

function reconcile({ pipelineDir, repoRoot, argv = [], fetchFn } = {}) {
  const report = argv.includes('--report');
  const reclassify = argv.includes('--reclassify');
  const backfill = argv.includes('--backfill') || reclassify;
  const dryRun = argv.includes('--dry-run');
  // 2026-09-08, Grimmethy: root-caused live a false "abandoned -- branch gone, work
  // lost" verdict on TWO separate, genuinely still-open agent/<id> branches. Both were
  // real, reviewed, tested work -- confirmed alive on origin the whole time -- but this
  // routine tick had never fetched, so buildShipContext()'s git for-each-ref only ever
  // saw whatever refs/remotes/origin/agent/* happened to already be cached locally,
  // which one sibling apply's own git operations on this SAME shared repoRoot can
  // perturb between ticks (confirmed: one of the two read correctly as pending-merge on
  // one tick, then flipped to abandoned 17 minutes later with no merge in between).
  // `abandoned` is a STABLE_TERMINAL_STAGE -- once wrong, it never self-heals. Fetch is
  // now unconditional on every tick (still cheap/bounded/best-effort, same as before) so
  // the routine path is never working from a staler view of origin than a --backfill run
  // would have used. `--no-fetch` is the explicit opt-out for a sandboxed/offline run
  // that wants to trust local refs on purpose.
  const doFetch = !argv.includes('--no-fetch');
  const doneDir = path.join(pipelineDir, 'queue', 'done');
  // Under --reclassify, records already closed as `noop` are re-resolved (a FALSE-POSITIVE
  // dismissal recorded before the `dismissed` stage existed). `abandoned` reopens too, as
  // of the same 2026-09-08 fix above -- a wrong "work lost" verdict deserves the same
  // audit-triggered correction path noop already had; re-resolving it now runs against a
  // freshly-fetched ctx, so a genuinely still-open branch reclassifies correctly instead
  // of being re-confirmed as lost by the same stale-ref bug that produced it.
  const allowReopenFrom = reclassify ? new Set(['noop', 'abandoned']) : undefined;

  let fetchOk = true;
  if (doFetch && repoRoot) {
    const fetch = fetchFn || (() => execFileSync('git', ['-C', repoRoot, 'fetch', 'origin', '--quiet'], { stdio: 'ignore', timeout: 60000 }));
    try { fetch(); } catch { fetchOk = false; }
  }

  const state = loadState(pipelineDir);

  // A failed fetch means buildShipContext() would resolve dispositions from whatever stale
  // local refs happen to be cached -- exactly the condition that produced the false
  // "abandoned -- branch gone, work lost" verdicts on 2026-09-08. Rather than risk a whole
  // sweep of wrong terminal events, skip disposition updates for this cycle entirely
  // (state is still persisted, so the incremental bookkeeping is not lost) and retry next
  // tick when fetch can succeed. `--no-fetch` is the explicit, intentional opt-out that
  // still trusts local refs on purpose, so it is unaffected (fetchOk stays true).
  if (!fetchOk) {
    console.warn('reconcile: git fetch failed, skipping disposition updates this cycle');
    if (!dryRun) saveState(pipelineDir, state);
    return { scanned: 0, resolved: 0, merged: 0, 'applied-direct': 0, filed: 0, dismissed: 0, noop: 0, 'pending-merge': 0, abandoned: 0, errors: 0, fetchFailed: true };
  }

  const ctx = repoRoot ? buildShipContext(repoRoot, { fetchConfirmed: fetchOk }) : null;

  const summary = { scanned: 0, resolved: 0, merged: 0, 'applied-direct': 0, filed: 0, dismissed: 0, noop: 0, 'pending-merge': 0, abandoned: 0, errors: 0 };
  const pendingList = [];
  const abandonedList = [];

  for (const { id, file } of candidateRecords(doneDir, { backfill, state })) {
    const record = readJson(file);
    if (record === null) { summary.errors += 1; continue; }
    summary.scanned += 1;

    let outcome;
    try {
      outcome = resolveDisposition(record, { repoRoot, ctx, allowReopenFrom });
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
      const closed = tail && STABLE_TERMINAL_STAGES.has(tail.stage);
      if (closed || !lastAppliedEvent(record.history)) {
        state.resolvedIds.add(id); state.pendingIds.delete(id);
      }
      continue;
    }

    const tail = record.history[record.history.length - 1];
    // Nothing to append when the resolved stage already IS the tail: the pending-merge
    // re-check, and (under --reclassify) a noop record that stays noop because its verdict
    // was inconclusive, not a false positive.
    const tailUnchanged = tail && tail.stage === outcome.stage;
    if (!tailUnchanged && !dryRun) {
      appendHistoryEvent(record, outcome.stage, outcome.detail);
      record.terminalDisposition = outcome.stage;
      if (outcome.stage === 'merged' && !record.mergedAt) {
        record.mergedAt = new Date().toISOString();
        record.mergedAtSource = 'task-log-reconcile';
      }
      if ((outcome.stage === 'merged' || outcome.stage === 'applied-direct')
        && (record.source === 'pipeline_self_audit' || record.source === 'pipeline_forensics_fix')) {
        const req = deriveAmplificationRequestFromFix(record);
        if (req) {
          try {
            runAmplificationSweep({
              rootCauseSummary: req.rootCauseSummary, query: req.query, excludeFiles: req.excludeFiles,
              root: repoRoot, pipelineDir, source: record.source, taskId: record.id, stage: 'task-log-reconcile',
            });
          } catch (e) { /* best-effort -- never break reconcile over an amplification sweep */ }
        }
      }
      try {
        fs.writeFileSync(file, JSON.stringify(record, null, 2));
      } catch (err) {
        console.error(`task-log-reconcile: write failed for ${id}: ${err.message}`);
        summary.errors += 1;
        continue;
      }
    }

    if (!tailUnchanged) { summary.resolved += 1; summary[outcome.stage] = (summary[outcome.stage] || 0) + 1; }
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

module.exports = { reconcile, candidateRecords, loadState, deriveAmplificationRequestFromFix };

if (require.main === module) {
  let cfg;
  try { cfg = getConfig(); } catch (e) {
    process.stderr.write(`task-log-reconcile: ${e.message}\n`);
    process.exit(0);
  }
  const summary = reconcile({ pipelineDir: cfg.pipelineDir, repoRoot: cfg.repoRoot, argv: process.argv.slice(2) });
  process.stdout.write(JSON.stringify(summary));
}
