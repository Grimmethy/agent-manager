'use strict';

// One-time backfill for the mislabeling coordinator-sweep.js's zero-sub-tasks completion
// path used to have (2026-09-14, screaminggoatclubmt: "fix the mislabeling. Also should
// we be archiving this pile of adhoc tasks?" -> "Fold it into the watchdog sweep."):
// coordinator-sweep.js only ever scans queue/coordinating/, so its fix (route a hub
// rejected at creation to `noop` + queue/done/_archived_no_action/ instead of `merged`)
// only ever applies to a hub that is STILL in coordinating/ at the moment it ships. It has
// no way to reach a hub that had already been (mis)closed out into queue/done/'s top level
// before the fix landed. Confirmed live: 28 such records exist, matched precisely by
// `coordinatorBlocked` set + empty `subTasks` + `terminalDisposition: 'merged'` (a
// slightly broader title-text grep for "plan needs revision" turns up 33 files, but 5 of
// those are unrelated tasks that happen to mention the phrase in prose, not
// coordinator-blocked hubs themselves -- this backfill only ever touches the precise
// match, never the title text).
//
// Scans queue/done/ TOP LEVEL ONLY (same non-recursive readdirSync guarantee
// done-archive.js/debrief-bundle.js/etc already rely on -- never descends into
// _archived_no_action/ or _archived/<YYYY-MM>/) so a record this itself already moved is
// naturally never revisited. Idempotent: nothing left to find once the 28 are done, so
// leaving this wired into the watchdog costs one cheap readdir a tick forever after,
// matching decompose-move-determinism-backfill.js/concept-tally-backfill.js's own
// "safe to leave running" precedent for a historical one-time fix.
//
// Kill switch: AGENT_MANAGER_REJECTED_HUB_BACKFILL=false.

const fs = require('fs');
const path = require('path');
const { getConfig } = require('./config.js');
const { appendHistoryEvent } = require('./task-history.js');

function isRejectedAtCreationMislabel(task) {
  return !!task.coordinatorBlocked
    && (!Array.isArray(task.subTasks) || task.subTasks.length === 0)
    && task.terminalDisposition === 'merged';
}

function backfillRejectedHubDisposition({ pipelineDir }) {
  const result = {
    checked: 0, fixed: 0, relabeledInPlace: 0, errors: [],
  };
  if (process.env.AGENT_MANAGER_REJECTED_HUB_BACKFILL === 'false') return result;

  const doneDir = path.join(pipelineDir, 'queue', 'done');
  const destDir = path.join(doneDir, '_archived_no_action');

  let entries;
  try {
    entries = fs.readdirSync(doneDir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return result;
    result.errors.push(`readdir(${doneDir}): ${e.message}`);
    return result;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const src = path.join(doneDir, entry.name);

    let task;
    try {
      task = JSON.parse(fs.readFileSync(src, 'utf8'));
    } catch (e) {
      result.errors.push(`parse(${src}): ${e.message}`);
      continue;
    }
    result.checked += 1;
    if (!isRejectedAtCreationMislabel(task)) continue;

    // Re-labels the false 'merged' event in place (never inserts a duplicate) so the
    // history reads honestly as "created -> noop -> done[ -> archived]", matching exactly
    // what coordinator-sweep.js's own fixed path now produces for a fresh hub.
    const mergedEvent = Array.isArray(task.history) ? task.history.find((h) => h.stage === 'merged') : null;
    if (mergedEvent) {
      mergedEvent.stage = 'noop';
      mergedEvent.detail = 'coordinator hub: plan rejected at creation, no sub-tasks were ever filed (relabeled by one-time backfill, was incorrectly stamped merged)';
    }
    task.terminalDisposition = 'noop';

    // 2026-09-14, screaminggoatclubmt: confirmed live -- the proactive decompose sweep can
    // generate more than one hub record for the same source file over time, sharing the
    // same deterministic id/filename. When an EARLIER attempt's hub already occupies the
    // archive destination (already correctly labeled by this same backfill or by
    // coordinator-sweep.js itself), never clobber it -- but still fix the honesty of the
    // label on the stuck duplicate in place, rather than leave it lying about 'merged'
    // forever just because it lost the race for the shared filename. It stays in done/'s
    // top level (not archived) since there's nowhere safe to move it without a naming
    // scheme change this backfill isn't the place to make.
    const dest = path.join(destDir, entry.name);
    let destTaken = false;
    try {
      destTaken = fs.existsSync(dest);
    } catch (e) {
      result.errors.push(`stat(${dest}): ${e.message}`);
    }

    if (destTaken) {
      try {
        fs.writeFileSync(src, JSON.stringify(task, null, 2));
        result.relabeledInPlace += 1;
      } catch (e) {
        result.errors.push(`relabel-in-place(${src}): ${e.message}`);
      }
      continue;
    }

    appendHistoryEvent(task, 'archived', 'Auto-archived by one-time backfill: coordinator hub rejected at creation, no sub-tasks were ever filed -- nothing to review or wait on');
    try {
      fs.mkdirSync(destDir, { recursive: true });
      fs.writeFileSync(dest, JSON.stringify(task, null, 2));
      fs.unlinkSync(src);
      result.fixed += 1;
    } catch (e) {
      result.errors.push(`move(${src}): ${e.message}`);
    }
  }

  return result;
}

module.exports = { backfillRejectedHubDisposition, isRejectedAtCreationMislabel };

if (require.main === module) {
  const { pipelineDir } = getConfig();
  process.stdout.write(JSON.stringify(backfillRejectedHubDisposition({ pipelineDir })));
}
