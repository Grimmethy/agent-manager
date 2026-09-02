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
    if (err.code === 'ENOENT') {
      return { reclaimed: 0, ids: [] };
    }
    console.warn(`reclaimOrphanedDrafts: failed to read ${draftingDir} -- code=${err.code}, message=${err.message}`);
    return { reclaimed: 0, ids: [] };
  }

  const ids = [];
  for (const name of names) {
    const filePath = path.join(draftingDir, name);
    let task;
    try {
      task = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      console.warn(`reclaimOrphanedDrafts: skipping unreadable draft file ${filePath} -- message=${err.message}${err.code ? ` (code=${err.code})` : ''}`);
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

  return { reclaimed: ids.length, ids };
}

function main() {
  const instanceId = process.argv[2];
  if (!instanceId) {
    console.error('Usage: node reclaim-orphaned-drafts.js <instanceId>');
    process.exit(1);
  }
  const { pipelineDir } = getConfig();
  const result = reclaimOrphanedDrafts({ pipelineDir, instanceId });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

module.exports = { reclaimOrphanedDrafts, destinationDirFor };

if (require.main === module) {
  main();
}
