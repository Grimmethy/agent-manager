'use strict';

// Daily archive pass for queue/done/ (2026-08-22, real production incident: done/ grew to
// ~3900 files with no rotation and caused a real timeout -- the dashboard's /api/queue/done
// route reads+parses every file in done/ whenever a source-type filter is applied, see
// python/dashboard/app.py's api_queue_state comment; the unfiltered default already avoids
// this via a cheap stat-only sort, but the filtered case doesn't, and done/ is exactly the
// tab users filter by source most). This module built directly, 2026-08-24, after the task
// meant to build it (an adhoc-domain task asking Claude's real agentic pass to write it)
// exhausted 5 retries in a row without ever producing a diff -- twice hitting max_turns
// (30, then 60 after the turn-budget retry fix) without even reaching a RESOLUTION line,
// and twice degenerating into a "no-changes-needed" cop-out review correctly rejected. The
// scope (this module + queue-watcher.sh wiring + dashboard route updates) genuinely needs
// more investigation than fits in one agentic session's turn budget.
//
// Never deletes -- same "always reversible, archive don't discard" principle established
// everywhere else in this codebase (api_task_archive's own header frames this project's
// explicit design goal as "the always reversible promise"). Moves a done/ task older than
// the retention window into queue/done/_archived/<YYYY-MM>/ -- a SEPARATE location from the
// pre-existing queue/done/_archived_no_action/, which means something different (a human
// explicitly archived one specific task via the dashboard's Archive button; see
// api_task_archive/api_task_requeue's 'archived' pseudo-state in python/dashboard/app.py).
// This is automatic, time-based housekeeping of tasks that simply finished and have been
// sitting around -- monthly buckets (not one folder per day) to avoid thousands of tiny
// directories over time.
//
// Bucketed by the month the archive PASS runs in, not the month the task itself completed
// -- simpler ("everything I archived this month is together") and matches how a human
// browsing "what did I clean up last month" would actually look for it, versus trying to
// back-date a bucket to a task's own (possibly much older, if this pass was ever paused)
// completion time.
//
// mtime is the retention signal, not a field parsed out of the task JSON itself -- checked
// live against real done/ tasks before picking: every task's file mtime already reflects
// "when did this task's processing last write," and a done/ task is terminal (nothing ever
// touches it again except this archive pass itself), so file mtime IS the completion
// timestamp already, with no JSON parsing needed to get it. Simpler and, per the task's own
// "mtime is the safe fallback either way" framing, no less correct than threading a
// specific history-entry timestamp through.

const fs = require('fs');
const path = require('path');
const { getConfig } = require('./config.js');

const DEFAULT_RETENTION_DAYS = 30;
// Only run the real archive pass once per real day, not once per queue-watcher.sh tick --
// exact same lastScannedAt-in-a-small-state-file shape src/maintenance/observability-
// review.js's own RESCAN_INTERVAL_MS already established for this identical "expensive
// periodic housekeeping, cheap due-check every tick" problem.
const RECHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const ARCHIVE_DIRNAME = '_archived';

function retentionMs() {
  const days = Number(process.env.AGENT_MANAGER_DONE_ARCHIVE_AFTER_DAYS) || DEFAULT_RETENTION_DAYS;
  return days * 24 * 60 * 60 * 1000;
}

function statePath(pipelineDir) {
  return process.env.AGENT_MANAGER_DONE_ARCHIVE_STATE_PATH || path.join(pipelineDir, 'done-archive-state.json');
}

function readState(sp) {
  try {
    return JSON.parse(fs.readFileSync(sp, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    console.error(`[done-archive] read failed at ${sp}: ${e.code || e.name} — ${e.message}`);
    throw e;
  }
}

function writeState(sp, state) {
  fs.mkdirSync(path.dirname(sp), { recursive: true });
  fs.writeFileSync(sp, JSON.stringify(state, null, 2));
}

function monthBucket(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Scans queue/done/ TOP LEVEL ONLY (fs.readdirSync is non-recursive by nature -- never
 * descends into _archived_no_action/ or the dated _archived/<YYYY-MM>/ folders this itself
 * creates) and moves any *.json file whose mtime is older than the retention window into
 * queue/done/_archived/<currentYYYY-MM>/. Idempotent: a file already moved is simply gone
 * from done/'s top level by the next call, nothing left to re-move.
 * @returns {{moved: number, skipped: number, errors: string[]}}
 */
function archiveDoneTasks({ pipelineDir, now = Date.now() }) {
  const doneDir = path.join(pipelineDir, 'queue', 'done');
  const cutoff = now - retentionMs();
  const result = { moved: 0, skipped: 0, errors: [] };

  let entries;
  try {
    entries = fs.readdirSync(doneDir, { withFileTypes: true });
  } catch (e) {
    result.errors.push(`readdir(${doneDir}): ${e.message}`);
    return result;
  }

  const destDir = path.join(doneDir, ARCHIVE_DIRNAME, monthBucket(new Date(now)));
  let destDirEnsured = false;

  for (const entry of entries) {
    // isFile() + .json extension naturally excludes _archived/, _archived_no_action/, and
    // any stray non-task file -- no explicit skip-list needed.
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const src = path.join(doneDir, entry.name);

    let stat;
    try {
      stat = fs.statSync(src);
    } catch (e) {
      result.errors.push(`stat(${src}): ${e.message}`);
      continue;
    }
    if (stat.mtimeMs >= cutoff) {
      result.skipped++;
      continue;
    }

    if (!destDirEnsured) {
      fs.mkdirSync(destDir, { recursive: true });
      destDirEnsured = true;
    }
    try {
      fs.renameSync(src, path.join(destDir, entry.name));
      result.moved++;
    } catch (e) {
      result.errors.push(`rename(${src}): ${e.message}`);
    }
  }

  return result;
}

/**
 * Gate: runs the real archive pass only if RECHECK_INTERVAL_MS has elapsed since the last
 * run (persisted lastArchivedAt in statePath(pipelineDir)) -- the CLI's own `--check-due`
 * mode, meant to be called every queue-watcher.sh tick the same way system-report.js's
 * `--check-due` already is.
 * @returns {null | {moved: number, skipped: number, errors: string[]}} null when not due.
 */
function checkDue({ pipelineDir, now = Date.now() }) {
  const sp = statePath(pipelineDir);
  const state = readState(sp);
  const lastArchivedAt = state.lastArchivedAt ? Date.parse(state.lastArchivedAt) : NaN;
  const due = Number.isNaN(lastArchivedAt) || (now - lastArchivedAt) >= RECHECK_INTERVAL_MS;
  if (!due) return null;

  const result = archiveDoneTasks({ pipelineDir, now });
  writeState(sp, { lastArchivedAt: new Date(now).toISOString() });
  return result;
}

// Every dated bucket under queue/done/_archived/ -- shared by python/dashboard/app.py's
// api_task_requeue 'archived' pseudo-state (so a task moved here by this automatic pass
// can still be found and requeued, same as one moved to _archived_no_action/ by a human)
// and by system-report.js's own historical scan (so a report window that reaches back
// past the retention cutoff doesn't silently miss tasks this pass relocated). Exposed here
// (not hand-duplicated as a glob elsewhere) so both consumers stay correct automatically as
// new month buckets appear -- no consumer needs to know the naming scheme itself.
function listArchivedMonthDirs(pipelineDir) {
  const archiveRoot = path.join(pipelineDir, 'queue', 'done', ARCHIVE_DIRNAME);
  try {
    return fs.readdirSync(archiveRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(archiveRoot, e.name));
  } catch (e) {
    return [];
  }
}

module.exports = { archiveDoneTasks, checkDue, listArchivedMonthDirs, retentionMs, statePath, monthBucket, ARCHIVE_DIRNAME };

if (require.main === module) {
  const { pipelineDir } = getConfig();
  if (process.argv.includes('--check-due')) {
    const result = checkDue({ pipelineDir });
    if (result) {
      console.log(`[done-archive] moved ${result.moved}, skipped ${result.skipped}${result.errors.length ? `, ${result.errors.length} errors: ${result.errors.join('; ')}` : ''}`);
    } else {
      console.log('[done-archive] not due yet');
    }
    process.exit(0);
  }
  const result = archiveDoneTasks({ pipelineDir });
  console.log(JSON.stringify(result));
}
