'use strict';

// Recovers a worker's own orphaned claims from a prior life -- Grimmethy, 2026-08-24:
// found live, 60 real tasks silently stuck in queue/drafting/worker-1/ for as long as
// ~19 hours, every one predating the CURRENT worker-1 process's own start time.
// dead-process-check.js already decides when a hung/dead worker PROCESS needs
// restarting, but nothing there (or anywhere else) ever reconciled the FILES a dead
// worker had claimed -- the replacement process just starts pulling brand-new work from
// nextXTask(), leaving whatever the old one had claimed to rot forever (invisible to
// every dashboard tab, and taskIdExistsInQueue() correctly treats it as "already
// queued" so it can never even be regenerated).
//
// Called once, at worker startup, BEFORE the main claim loop begins -- at that exact
// moment ANY file already sitting in THIS instance's own drafting/<instanceId>/ folder
// is, by definition, orphaned: a freshly-started process hasn't claimed anything yet.
//
// Always sent to queue/pending/ -- CORRECTED 2026-08-24 (same day as this file was
// written) after finding, live, that the original version's adhoc/research routing was
// itself wrong: queue/adhoc/ and queue/research/ are permanent, append-only staging
// logs -- nextAdhocTask()/nextResearchTask() read a candidate from there and PROMOTE it
// into queue/pending/ via writeTask(), but never delete the original file, so it sits
// there forever as a historical record. A task that reached drafting/ was ALWAYS
// claimed from its promoted pending/ copy, never the adhoc/research original -- sending
// a reclaim back to adhoc/research means writing to a path THAT ALREADY EXISTS (the
// permanent original), which this function's own "never clobber" safety then correctly
// refuses, silently leaving the orphan stuck forever -- the exact failure mode this
// whole file exists to fix, just relocated. pending/ is the one directory a promoted
// task's own id is genuinely gone from once claimed, so it's always safe to write back to.
//
// CLI: node reclaim-orphaned-drafts.js <instanceId>
// Writes one line of JSON to stdout: { reclaimed: N, ids: [...] }

const fs = require('fs');
const path = require('path');
const { getConfig } = require('./config.js');
const { appendHistoryEvent } = require('./task-history.js');

function destinationDirFor(_domain) {
  return 'pending';
}

function reclaimOrphanedDrafts({ pipelineDir, instanceId }) {
  const draftingDir = path.join(pipelineDir, 'queue', 'drafting', instanceId);
  let names = [];
  try {
    names = fs.readdirSync(draftingDir).filter((f) => f.endsWith('.json'));
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return { reclaimed: 0, ids: [] };
    }
    // err?.message ?? String(err) / err?.code (2026-09-15): a non-Error throw (null,
    // undefined, or a bare string from an unusual filesystem layer) would otherwise throw
    // a TypeError reading .message/.code off it INSIDE this catch, escaping the function
    // entirely instead of the best-effort "log and return empty" this block exists for.
    console.warn(`reclaimOrphanedDrafts: failed to read ${draftingDir} -- code=${err?.code}, message=${err?.message ?? String(err)}`);
    return { reclaimed: 0, ids: [] };
  }

  const ids = [];
  for (const name of names) {
    const filePath = path.join(draftingDir, name);
    let task;
    try {
      task = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      // Same err?.message ?? String(err) / err?.code guard as above -- a non-Error throw
      // here would otherwise abort the whole reclaim loop (escaping this file's own
      // try/catch) instead of just skipping this one file and continuing to the rest.
      console.warn(`reclaimOrphanedDrafts: skipping unreadable draft file ${filePath} -- message=${err?.message ?? String(err)}${err?.code ? ` (code=${err.code})` : ''}`);
      continue; // unreadable/mid-write -- leave it, next startup can try again
    }

    const destDirName = destinationDirFor(task.domain);
    const destDir = path.join(pipelineDir, 'queue', destDirName);
    fs.mkdirSync(destDir, { recursive: true });
    const destPath = path.join(destDir, name);
    if (fs.existsSync(destPath)) continue; // something's already there -- don't clobber, leave for manual investigation

    appendHistoryEvent(task, 'reclaimed', `Orphaned claim from a prior ${instanceId} process, recovered at startup -- sent back to queue/${destDirName}/`);
    fs.writeFileSync(filePath, JSON.stringify(task, null, 2));
    fs.renameSync(filePath, destPath);
    ids.push(task.id || name.replace(/\.json$/, ''));
  }

  if (ids.length > 0) {
    try {
      fs.appendFileSync(path.join(pipelineDir, 'reclaim-log.jsonl'), JSON.stringify({ ts: new Date().toISOString(), instanceId, count: ids.length, ids }) + '\n');
    } catch (logErr) {
      console.warn('reclaimOrphanedDrafts: reclaim-log write failed -- ' + logErr.message);
    }
  }

  return { reclaimed: ids.length, ids };
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

// Recovers drafts stranded in the folder of a RETIRED lane. Worker lanes are now one per GPU
// (src/lanes.js: worker-3090, worker-p40); the old layout's drafting/worker-1, worker-reasoning,
// worker-reasoning-p40 folders have no process that will ever own them again, and
// reclaimOrphanedDrafts() above only ever looks at a worker's OWN folder, so their tasks would sit
// there forever (taskIdExistsInQueue() counts them as queued, so they can't even be regenerated).
// A worker-* drafting folder that is not a currently defined lane and whose heartbeat pid is not
// alive is retired: its drafts go back to pending/, then the empty folder and the stale heartbeat
// file (which would otherwise show as an offline lane forever) are removed.
function reclaimRetiredLaneDrafts({ pipelineDir, laneIds, alive = pidAlive }) {
  const draftingRoot = path.join(pipelineDir, 'queue', 'drafting');
  const instancesDir = path.join(pipelineDir, 'instances');
  const out = { retired: [], reclaimed: 0, ids: [] };
  let dirs = [];
  try {
    dirs = fs.readdirSync(draftingRoot, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith('worker-'));
  } catch {
    return out;
  }
  for (const d of dirs) {
    if (laneIds.includes(d.name)) continue;
    const hbPath = path.join(instancesDir, `${d.name}.json`);
    let hb = null;
    try { hb = JSON.parse(fs.readFileSync(hbPath, 'utf8')); } catch { /* no/unreadable heartbeat */ }
    if (hb && alive(hb.pid)) continue; // a live process still owns it -- never touch
    const r = reclaimOrphanedDrafts({ pipelineDir, instanceId: d.name });
    out.reclaimed += r.reclaimed;
    out.ids.push(...r.ids);
    out.retired.push(d.name);
    try { fs.rmdirSync(path.join(draftingRoot, d.name)); } catch { /* not empty (an unreadable file was left) -- leave the folder */ }
    try { fs.unlinkSync(hbPath); } catch { /* no heartbeat file */ }
  }
  return out;
}

function main() {
  const instanceId = process.argv[2];
  if (!instanceId) {
    console.error('Usage: node reclaim-orphaned-drafts.js <instanceId> | --retired-lanes');
    process.exit(1);
  }
  const { pipelineDir } = getConfig();
  if (instanceId === '--retired-lanes') {
    const { getLanes } = require('./lanes.js');
    process.stdout.write(`${JSON.stringify(reclaimRetiredLaneDrafts({ pipelineDir, laneIds: getLanes().map((l) => l.id) }))}\n`);
    return;
  }
  const result = reclaimOrphanedDrafts({ pipelineDir, instanceId });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

module.exports = { reclaimOrphanedDrafts, reclaimRetiredLaneDrafts, destinationDirFor };

if (require.main === module) {
  main();
}
