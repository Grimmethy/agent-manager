'use strict';

// Queue presence: "is this task id already somewhere in the queue?" -- every task source asks it before minting a task, so a task that is pending, claimed,
// blocked, finished or archived is never regenerated. Moved out of task-sources.js (roadmap step 1, piece P2) so brain-dump-resolution-check.js and the
// task sources share a leaf instead of requiring each other (the import-cycle ratchet is scripts/import-cycles.js). task-sources.js still re-exports
// taskIdExistsInQueue, so every other importer is unchanged.

const fs = require('fs');
const path = require('path');
const { getConfig } = require('./config.js');
const { listArchivedMonthDirs } = require('./done-archive.js');

// BUG FIXED 2026-08-21 (Grimmethy, via the dashboard's Queue tab: found the SAME task id
// sitting as two genuinely different files, one in done/ and one in
// done/_archived_no_action/): this list used to omit 'needs-clarification',
// 'awaiting-confirm', and the nested done/_archived_no_action/ pseudo-state entirely, so
// taskIdExistsInQueue (below) was blind to a task that had reached any of those three
// locations. For a source like observability_review that re-derives the SAME id from the
// SAME (rule, file, line) on every worker tick as long as the underlying flag is still in
// queue/observability-flags.json (findings are never pruned just for having already
// produced a task -- see nextObservabilityReviewTask's own comment), this was not a rare
// coincidence: the tick right after any of its tasks got archived would mint a brand-new
// task under the identical id, guaranteed, every time. system-report.js already treats
// done/_archived_no_action/ as its own 'archived' pseudo-state for exactly this reason
// (scanning "what actually got done"); this brings the dedup check in line with that
// instead of leaving it as the one place still blind to it.
const QUEUE_STATES = ['pending', 'drafting', 'review', 'approved', 'blocked', 'done',
  'needs-clarification', 'awaiting-confirm', 'coordinating'];

// A claimed task lives at queue/drafting/<InstanceId>/<id>.json, not queue/drafting/<id>.json
// directly (a per-instance claim subfolder) -- every task source shares this function, so a
// task actively being drafted is correctly seen as already-queued, not regenerated.
// A hub renamed to its HUB#### id (hub-rename.js) leaves the id of the task it was as `formerIds`. Without this the source that derived that task
// (function_length_fix re-derives AC-2 every tick) sees no queued task under the old id and files a DUPLICATE -- seen live 2026-09-20, minutes after
// the AC-2 hub was renamed. Memoised on the coordinating/ dir's mtime (a rename or a new hub changes it).
const _formerHubIdsMemo = new Map(); // coordDir -> { mtimeMs, ids:Set }
function formerHubIds(queueDir) {
  const coordDir = path.join(queueDir, 'coordinating');
  let mtimeMs;
  try { mtimeMs = fs.statSync(coordDir).mtimeMs; } catch { return new Set(); }
  const hit = _formerHubIdsMemo.get(coordDir);
  if (hit && hit.mtimeMs === mtimeMs) return hit.ids;
  const ids = new Set();
  try {
    for (const f of fs.readdirSync(coordDir)) {
      if (!f.endsWith('.json')) continue;
      try { const h = JSON.parse(fs.readFileSync(path.join(coordDir, f), 'utf8')); for (const x of (Array.isArray(h.formerIds) ? h.formerIds : [])) ids.add(x); } catch { /* malformed -- skip */ }
    }
  } catch { /* unreadable */ }
  _formerHubIdsMemo.set(coordDir, { mtimeMs, ids });
  return ids;
}

function taskIdExistsInQueue(id) {
  const { pipelineDir } = getConfig();
  const queueDir = path.join(pipelineDir, 'queue');
  if (formerHubIds(queueDir).has(id)) return true;
  if (fs.existsSync(path.join(queueDir, 'done', '_archived_no_action', `${id}.json`))) return true;
  // done-archive.js's own dated month buckets (queue/done/_archived/<YYYY-MM>/, 2026-08-24)
  // -- without this, a task's underlying item (a brain-dump entry, a deep_dive community,
  // an arch_import itemId) would look "never queued" the moment its completed task aged
  // past the retention window and got moved out of done/'s top level, and could be
  // regenerated as a live duplicate -- the exact bug this function exists to prevent, same
  // reasoning as the _archived_no_action check just above.
  if (listArchivedMonthDirs(pipelineDir).some((dir) => fs.existsSync(path.join(dir, `${id}.json`)))) return true;
  return idInQueueStates(queueDir, id, QUEUE_STATES);
}

// Does <id>.json sit in any of these queue/<state>/ dirs (drafting has per-worker subfolders)?
function idInQueueStates(queueDir, id, states) {
  return states.some((state) => {
    if (state !== 'drafting') return fs.existsSync(path.join(queueDir, state, `${id}.json`));

    const draftingDir = path.join(queueDir, 'drafting');
    if (fs.existsSync(path.join(draftingDir, `${id}.json`))) return true; // legacy: no subfolder
    let entries;
    try {
      entries = fs.readdirSync(draftingDir, { withFileTypes: true });
    } catch {
      return false;
    }
    return entries
      .filter((e) => e.isDirectory())
      .some((e) => fs.existsSync(path.join(draftingDir, e.name, `${id}.json`)));
  });
}

// True when the ONLY thing holding this id is a FINISHED task (queue/done/, its dated archive buckets or _archived_no_action) -- nothing live,
// blocked, held or coordinating carries it. A finished task is spent: it cannot be "already queued", so a caller that needs a fresh attempt may move
// on to the next id. Anything not finished (pending, drafting, review, approved, blocked, needs-clarification, ... or a former hub id) still blocks.
function taskIdHeldOnlyByFinishedTask(id) {
  const { pipelineDir } = getConfig();
  const queueDir = path.join(pipelineDir, 'queue');
  if (formerHubIds(queueDir).has(id)) return false;
  if (idInQueueStates(queueDir, id, QUEUE_STATES.filter((s) => s !== 'done'))) return false;
  if (fs.existsSync(path.join(queueDir, 'done', `${id}.json`))) return true;
  if (fs.existsSync(path.join(queueDir, 'done', '_archived_no_action', `${id}.json`))) return true;
  return listArchivedMonthDirs(pipelineDir).some((dir) => fs.existsSync(path.join(dir, `${id}.json`)));
}

module.exports = { QUEUE_STATES, formerHubIds, taskIdExistsInQueue, idInQueueStates, taskIdHeldOnlyByFinishedTask };
