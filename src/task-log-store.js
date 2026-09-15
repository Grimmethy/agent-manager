'use strict';

// The durable, git-tracked task log. task-history.js's task.history is the intended
// single append-only document for a task's whole lifecycle, but it lives inside
// queue/<state>/<id>.json -- a file that is gitignored, gets rewritten wholesale by some
// callers (api_task_requeue in python/dashboard/app.py used to replace `history` outright
// on a manual requeue, discarding every prior event including the real blockedReason --
// see AGENTS.md's task-log section), and eventually gets moved into a dated archive
// bucket or pruned. None of that is available "at a click" once a branch has merged and
// its queue/ file is gone, and none of it survives a resetToMain() or a lost pipeline
// host.
//
// This module writes a curated snapshot of the task's full history to
// task-logs/<taskId>.json, alongside the same commit that applies the task's real change
// -- durable across queue/ archival, no live pipeline state, no queue/ archive-hunting, no
// requeue-attribution.db query needed to find it later.
//
// RE-EVALUATED 2026-09-15 (Grimmethy: a captured brain-dump note with a private Google
// Sheets link, and this repo being PUBLIC on GitHub): task-logs/ used to be git-tracked
// and pushed. buildTaskLogRecord below deliberately retains implementResponse/
// planResponse/promptContext.rawText verbatim -- for a task derived from a brain-dump
// entry, that rawText IS the user's own free-typed personal/business note content, not
// grounded task text. Confirmed live: 13 of 48 already-committed task-logs/ entries
// originated from brain-dump entries. task-logs/ is now in .gitignore -- this module still
// writes the file (apply-task.js's writeTaskLogFile call, and the dashboard's
// api_git_merge_branch merge-disposition update in pipeline_1_more.py) for the user's own
// local reference, but neither caller stages/commits/pushes it any more.

const fs = require('fs');
const path = require('path');

const TASK_LOG_DIR = 'task-logs';

function taskLogRelPath(taskId) {
  return path.posix.join(TASK_LOG_DIR, `${taskId}.json`);
}

function taskLogAbsPath(repoRoot, taskId) {
  return path.join(repoRoot, TASK_LOG_DIR, `${taskId}.json`);
}

// Curated, not the raw task object -- but curated to EXCLUDE only the one thing that's
// genuinely disproportionate (promptContext.fetchedFiles: full source-file snapshots,
// already visible in the diff itself, sometimes tens of KB), not the prose that makes the
// log legible. app.py's _describe_change() -- the function the dashboard already uses to
// render a plain-English "what changed" for a branch -- reads implementResponse,
// planResponse, and promptContext.body; dropping those would make a task-log-store
// fallback record strictly WORSE than the live queue/ file it stands in for, exactly
// backwards from "should arguably have more information than an in-process task"
// (2026-09-12, Grimmethy). Every field here is either already append-only (history) or a
// terminal snapshot (the LAST known value of a field that only ever gets set once per
// stage, e.g. blockedReason at the moment of apply -- there is no earlier value to lose).
function buildTaskLogRecord(task) {
  const record = {
    id: task.id,
    title: task.title,
    domain: task.domain,
    source: task.source,
    createdAt: task.createdAt,
    history: Array.isArray(task.history) ? task.history : [],
  };
  if (task.promptContext && typeof task.promptContext === 'object') {
    const { fetchedFiles, ...rest } = task.promptContext;
    record.promptContext = rest;
  }
  // Optional richer fields, included only when present -- the exact data this mechanism
  // exists to stop losing (2026-09-12: observability-fix-ac-158's blockedReason and
  // priorRejectionFeedback were both discarded by a manual requeue before this existed).
  for (const key of [
    'blockedReason', 'priorRejectionFeedback', 'draftAttempts', 'draftFailureCount',
    'localVerdict', 'localVotes', 'voteErrors', 'acceptanceCriteria', 'draftModel',
    'terminalDisposition', 'implementResponse', 'planResponse', 'reviewedAt', 'claimedAt',
  ]) {
    if (task[key] !== undefined) record[key] = task[key];
  }
  return record;
}

// Writes (or overwrites -- see mergeAppendEvent below for the post-merge update path)
// the task log file at repoRoot/task-logs/<id>.json. Returns the repoRoot-relative path,
// the same shape apply-task.js's other artifact.file entries use, so callers can push it
// straight onto filesToAdd without any path translation.
function writeTaskLogFile(repoRoot, task) {
  const relPath = taskLogRelPath(task.id);
  const absPath = taskLogAbsPath(repoRoot, task.id);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, JSON.stringify(buildTaskLogRecord(task), null, 2) + '\n', 'utf8');
  return relPath;
}

module.exports = { TASK_LOG_DIR, taskLogRelPath, taskLogAbsPath, buildTaskLogRecord, writeTaskLogFile };
