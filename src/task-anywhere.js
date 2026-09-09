'use strict';

// Node-side port of python/dashboard/app.py's api_task_anywhere (2026-09-07, for
// local-tool-client.js's read_task/search_tasks chat tools -- see that file's own header
// on why this is a duplicate Node implementation rather than a subprocess shell-out to
// Python: this is a stable, simple, fixed-order directory search with low drift risk,
// unlike reasoningTierFor()-style business logic (live config + registered sources),
// which genuinely IS shelled out to Node from Python elsewhere in this codebase because
// reimplementing THAT twice would be risky. api_task_anywhere itself is untouched by
// this -- the dashboard's own click-through has no reason to route through Node.
//
// Precedence, mirrored exactly from api_task_anywhere (app.py:2854-2897): drafting/
// (every lane, so an actively-claimed task resolves first, the common case for an
// instance's currentTaskId), then each QUEUE_STATES dir in order, then adhoc/ (a task
// task-sources.js hasn't materialized into pending/ yet), then done/_archived_no_action/,
// then done/_archived/<month>/ newest month first.

const fs = require('fs');
const path = require('path');

// Kept in sync by hand with python/dashboard/app.py's own QUEUE_STATES (app.py:301) --
// a plain, rarely-changed list of directory names, not business logic.
const QUEUE_STATES = ['pending', 'review', 'approved', 'blocked', 'done', 'needs-clarification', 'awaiting-confirm', 'coordinating'];

function readJsonSafe(fullPath) {
  try {
    return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  } catch {
    return null;
  }
}

function readDirSafe(fullPath) {
  try {
    return fs.readdirSync(fullPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

// Returns { data, foundState } (foundState is 'drafting', one of QUEUE_STATES, 'adhoc',
// or 'archived') or null if the task isn't found anywhere.
function findTaskAnywhere(pipelineDir, taskId) {
  if (!pipelineDir || !taskId) return null;
  const qdir = path.join(pipelineDir, 'queue');

  const draftingRoot = path.join(qdir, 'drafting');
  for (const lane of readDirSafe(draftingRoot)) {
    if (!lane.isDirectory()) continue;
    const data = readJsonSafe(path.join(draftingRoot, lane.name, `${taskId}.json`));
    if (data) return { data, foundState: 'drafting' };
  }

  for (const state of QUEUE_STATES) {
    const data = readJsonSafe(path.join(qdir, state, `${taskId}.json`));
    if (data) return { data, foundState: state };
  }

  const adhocData = readJsonSafe(path.join(qdir, 'adhoc', `${taskId}.json`));
  if (adhocData) return { data: adhocData, foundState: 'adhoc' };

  const derivedData = readJsonSafe(path.join(qdir, 'derived', `${taskId}.json`));
  if (derivedData) return { data: derivedData, foundState: 'derived' };

  const noActionData = readJsonSafe(path.join(qdir, 'done', '_archived_no_action', `${taskId}.json`));
  if (noActionData) return { data: noActionData, foundState: 'archived' };

  const datedArchiveRoot = path.join(qdir, 'done', '_archived');
  const months = readDirSafe(datedArchiveRoot)
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .reverse(); // newest month first, matching api_task_anywhere's sorted(..., reverse=True)
  for (const month of months) {
    const data = readJsonSafe(path.join(datedArchiveRoot, month, `${taskId}.json`));
    if (data) return { data, foundState: 'archived' };
  }

  return null;
}

module.exports = { findTaskAnywhere, QUEUE_STATES };
