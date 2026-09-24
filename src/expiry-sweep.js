'use strict';

// expiry-sweep.js -- retire QUEUED tasks whose subject has aged out, for any source that declares how.
//
// Why (2026-09-24, change_review flood): a task waits in queue/pending/ for as long as the workers take to reach it, and for some sources the
// thing it is about goes stale WHILE it waits. change_review reviews one commit; a week later that review is stale work crowding out
// the changes that matter (346 of 522 pending tasks were over a week old; only 25 were from the last two days). Stopping new generation
// (the source's own recency window) does not touch what is already queued, and a one-off archive is a bandaid: another batch ages out every day.
//
// Core names no plugin source (ADR-0022, src/no-plugin-source-names.test.js), so this is source-agnostic. A source opts in with an `expiry`
// field on its registration:
//   expiry: {
//     idPrefixes: ['change-review-'],                 // task-id filename prefixes -- only files that can belong to the source are READ
//     findExpired({ tasks, now }) -> [{ id, action, reason }]   // tasks: [{ id, task }]; pure -- no writes. Batch, so the source can
//                                                              // resolve what it needs (e.g. commit dates) in one call, not one per task.
//     record?({ results, now })                        // optional, after the moves: results = [{ id, action, reason, task }]. Owns the
//                                                     // source's own bookkeeping (change_review's aged-out ledger the Hygiene tab counts).
//   }
//   action 'archive' -- nothing worth keeping: stamp terminalDisposition 'aged-out' and move to done/_archived_no_action/ (reversible; the id stays
//                       reserved because taskIdExistsInQueue() checks that folder, so the generator cannot recreate it).
//   action 'apply'   -- it already holds an approved result: send it to approved/ so apply closes it (a real finding is still worth filing;
//                       no model call is spent).
// Only queue/pending/ is scanned: a task a worker has claimed (drafting/), or that is in review/approved/, is in flight and is never touched.
//
// Throttled (default once per 30 min -- AGENT_MANAGER_EXPIRY_SWEEP_MINUTES; state in queue/expiry-sweep-state.json) because every source's files
// are read. Kill switch AGENT_MANAGER_EXPIRY_SWEEP=false. CLI: node expiry-sweep.js [--dry-run] [--force]

const fs = require('fs');
const path = require('path');
const { appendHistoryEvent } = require('./task-history.js');
const { writeJsonAtomicSync } = require('./atomic-write.js');

const DEFAULT_INTERVAL_MINUTES = 30;
const STATE_FILE = 'expiry-sweep-state.json';
const STAGING_DIR = '.expiry-staging';

const enabled = () => process.env.AGENT_MANAGER_EXPIRY_SWEEP !== 'false';

function intervalMs() {
  const n = Number(process.env.AGENT_MANAGER_EXPIRY_SWEEP_MINUTES);
  return (Number.isFinite(n) && n >= 0 ? n : DEFAULT_INTERVAL_MINUTES) * 60 * 1000;
}

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

function sweepExpiry({ pipelineDir, sources, now = new Date(), dryRun = false, force = false } = {}) {
  const summary = { sources: 0, checked: 0, archived: 0, released: 0, skipped: 0, errors: 0, throttled: false };
  if (!enabled() || !pipelineDir) return summary;
  const queueDir = path.join(pipelineDir, 'queue');
  const statePath = path.join(queueDir, STATE_FILE);

  if (!force && !dryRun) {
    const st = readJson(statePath);
    if (st && st.lastRunAt && now.getTime() - Date.parse(st.lastRunAt) < intervalMs()) { summary.throttled = true; return summary; }
  }

  const pendingDir = path.join(queueDir, 'pending');
  const archiveDir = path.join(queueDir, 'done', '_archived_no_action');
  const approvedDir = path.join(queueDir, 'approved');
  const stagingDir = path.join(queueDir, STAGING_DIR);
  let pendingNames;
  try { pendingNames = fs.readdirSync(pendingDir).filter((f) => f.endsWith('.json')); } catch { pendingNames = []; }
  const nowIso = now.toISOString();

  for (const source of sources || []) {
    const ex = source && source.expiry;
    if (!ex || typeof ex.findExpired !== 'function') continue;
    summary.sources += 1;
    const prefixes = Array.isArray(ex.idPrefixes) ? ex.idPrefixes : [];
    const tasks = [];
    for (const name of pendingNames) {
      if (prefixes.length && !prefixes.some((p) => name.startsWith(p))) continue;
      const task = readJson(path.join(pendingDir, name));
      if (!task || typeof task !== 'object') continue;
      // Only THIS source's own tasks (a shared id prefix, e.g. a sibling *_fix source, must not be offered to its hook).
      if (task.source !== source.name) continue;
      tasks.push({ id: name.replace(/\.json$/, ''), task });
    }
    summary.checked += tasks.length;
    if (!tasks.length) continue;

    let expired;
    try { expired = ex.findExpired({ tasks, now }) || []; } catch (e) { summary.errors += 1; console.error(`[expiry-sweep] ${source.name}.findExpired failed: ${e.message}`); continue; }

    const done = [];
    for (const item of expired) {
      if (!item || !item.id || (item.action !== 'archive' && item.action !== 'apply')) continue;
      const name = `${item.id}.json`;
      const src = path.join(pendingDir, name);
      if (dryRun) { if (item.action === 'archive') summary.archived += 1; else summary.released += 1; done.push({ ...item, task: null }); continue; }
      try {
        fs.mkdirSync(stagingDir, { recursive: true });
        const staged = path.join(stagingDir, name);
        try { fs.renameSync(src, staged); } catch (e) { if (e.code === 'ENOENT') { summary.skipped += 1; continue; } throw e; }   // a worker claimed it meanwhile
        try {
          const task = readJson(staged);
          if (!task) { fs.renameSync(staged, src); summary.skipped += 1; continue; }
          if (item.action === 'archive') {
            const dest = path.join(archiveDir, name);
            if (fs.existsSync(dest)) { fs.renameSync(staged, src); summary.skipped += 1; continue; }
            const why = String(item.reason || 'aged out while queued').slice(0, 400);
            appendHistoryEvent(task, 'aged-out', why);
            task.terminalDisposition = 'aged-out';
            task.manualArchive = { at: nowIso, from: 'pending', reason: why };
            writeJsonAtomicSync(staged, task);
            fs.mkdirSync(archiveDir, { recursive: true });
            fs.renameSync(staged, dest);
            summary.archived += 1;
            done.push({ ...item, task });
          } else {
            delete task.blockedReason; delete task.blockedStage;
            task.status = 'approved';
            appendHistoryEvent(task, 'approved', `expiry-sweep: ${item.reason || 'subject aged out, but this task already holds an approved result'} -- applying it, no redraft`);
            writeJsonAtomicSync(staged, task);
            fs.mkdirSync(approvedDir, { recursive: true });
            fs.renameSync(staged, path.join(approvedDir, name));
            summary.released += 1;
            done.push({ ...item, task });
          }
        } catch (e) {
          // Put it back rather than strand it in staging.
          try { if (fs.existsSync(staged) && !fs.existsSync(src)) fs.renameSync(staged, src); } catch { /* best effort */ }
          throw e;
        }
      } catch (e) {
        summary.errors += 1;
        console.error(`[expiry-sweep] ${item.id}: ${e.message}`);
      }
    }
    if (done.length && typeof ex.record === 'function' && !dryRun) {
      try { ex.record({ results: done, now }); } catch (e) { summary.errors += 1; console.error(`[expiry-sweep] ${source.name}.record failed: ${e.message}`); }
    }
  }

  if (!dryRun) {
    try { writeJsonAtomicSync(statePath, { lastRunAt: nowIso, lastSummary: { ...summary } }); } catch { /* best effort */ }
  }
  return summary;
}

function main() {
  const argv = process.argv.slice(2);
  require('./task-sources.js');
  try { require('./config.js').ensureRegistered(); } catch { /* best-effort */ }
  const { getConfig } = require('./config.js');
  const { getRegisteredSources } = require('./task-source-registry.js');
  const summary = sweepExpiry({
    pipelineDir: getConfig().pipelineDir, sources: getRegisteredSources(),
    dryRun: argv.includes('--dry-run'), force: argv.includes('--force'),
  });
  process.stdout.write(JSON.stringify(summary));
}

module.exports = { sweepExpiry, DEFAULT_INTERVAL_MINUTES };

if (require.main === module) main();
