'use strict';

// local-tool-task-tools.js -- extracted from src/local-tool-client.js ([[hub-task-integration]] node-module decompose).

const { isGitWriteRequest, GIT_WRITE_REQUEST_REFUSAL } = require('./lib/git-ownership.js');
const path = require('path');
const fs = require('fs');
const { findTaskAnywhere, QUEUE_STATES } = require('./task-anywhere.js');
const { lineMatches } = require('./text-match.js');
const { getConfig } = require('./config.js');
const { queueAdhocTask } = require('./queue-adhoc-task.js');
const { resolveInsideRepo, resolveInsideRoots, rootsAndArgs, boundWindow, readFileTool, listDirectoryTool, listRootsTool, capBashOutput, writeFileTool, editFileTool, withApplyLock, runBashTool, MAX_READ_FILE_CHARS, READ_FILE_DEFAULT_LINES, READ_FILE_MAX_LINES, APPLY_LOCK_PATH, APPLY_LOCK_CHILD_FD, RISKY_GIT_COMMAND_RE, CHAT_BASH_TIMEOUT_MS, MAX_BASH_OUTPUT_CHARS } = require('./local-tool-fs-tools.js');

const READ_TASK_SECTIONS = { plan: 'planResponse', implement: 'implementResponse', blockedReason: 'blockedReason', history: 'history' };

const MAX_SEARCH_TASK_RESULTS = 15;

function taskSummary(data, fallbackId) {
  return {
    id: data.id || fallbackId,
    title: data.title,
    domain: data.domain,
    source: data.source,
    status: data.status,
    blockedReason: data.blockedReason,
    blockedStage: data.blockedStage,
    branch: data.branch,
    compareUrl: data.compareUrl,
    doneMarker: data.doneMarker,
    createdAt: data.createdAt,
    reviewedAt: data.reviewedAt,
    appliedAt: data.appliedAt,
    localRejectCount: data.localRejectCount != null ? data.localRejectCount : data.ornithRejectCount,
    needsClarification: data.needsClarification,
    stalenessFlag: data.stalenessFlag,
    contextTrimFlag: data.contextTrimFlag,
    subTasks: data.subTasks,
    progress: data.progress,
    coordinatorBlocked: data.coordinatorBlocked,
  };
}

function formatTaskHistory(history) {
  if (!Array.isArray(history)) return '';
  return history.map((h) => `${h.at || ''} [${h.stage || ''}]${h.detail ? ` -- ${h.detail}` : ''}`).join('\n');
}

function windowSectionText(text, offset, limit) {
  const lines = (text || '').split('\n');
  const totalLines = lines.length;
  const windowGiven = offset != null || limit != null;
  let off = Number.isFinite(offset) ? Math.floor(offset) : 1;
  if (off < 1) off = 1;
  let lim = Number.isFinite(limit) ? Math.floor(limit) : READ_FILE_DEFAULT_LINES;
  if (lim < 1) lim = 1;
  if (lim > READ_FILE_MAX_LINES) lim = READ_FILE_MAX_LINES;

  if (off > totalLines) {
    return { content: '', offset: off, limit: lim, totalLines, nextOffset: null, truncated: false };
  }
  const endLine = Math.min(totalLines, off - 1 + lim);
  const { slice, truncated, returnedThrough } = boundWindow(lines, off, endLine);
  const nextOffset = returnedThrough < totalLines ? returnedThrough + 1 : null;
  const out = { content: slice, offset: off, limit: lim, totalLines, nextOffset, truncated };
  if (nextOffset != null) {
    out.notice = windowGiven
      ? `showing lines ${off}-${returnedThrough} of ${totalLines}. Re-call with offset=${nextOffset} for the next window.`
      : `showing 1-${returnedThrough} of ${totalLines} lines; re-call with offset=${nextOffset} to page further (limit up to ${READ_FILE_MAX_LINES}).`;
  }
  return out;
}

function readTaskTool(pipelineDir, { taskId, section, offset, limit } = {}) {
  if (typeof taskId !== 'string' || !taskId.trim()) {
    return { error: 'read_task requires a non-empty "taskId" argument' };
  }
  if (section != null && !Object.prototype.hasOwnProperty.call(READ_TASK_SECTIONS, section)) {
    return { error: `unknown section '${section}'. Valid sections: ${Object.keys(READ_TASK_SECTIONS).join(', ')}, or omit section for a summary.` };
  }
  const found = findTaskAnywhere(pipelineDir, taskId);
  if (!found) {
    return { error: `task ${taskId} not found in any queue state` };
  }
  const { data, foundState } = found;
  if (!section) {
    return { ...taskSummary(data, taskId), foundState };
  }
  const field = READ_TASK_SECTIONS[section];
  const raw = field === 'history' ? formatTaskHistory(data.history) : data[field];
  if (!raw) {
    return { error: `task ${taskId} has no ${section} content`, foundState };
  }
  return { taskId, foundState, section, ...windowSectionText(raw, offset, limit) };
}

function candidateTaskFiles(pipelineDir, state) {
  const qdir = path.join(pipelineDir, 'queue');
  const out = []; // [{ fullPath, foundState }]
  const addDir = (dirPath, foundState) => {
    let names;
    try { names = fs.readdirSync(dirPath); } catch { return; }
    for (const name of names) {
      if (name.endsWith('.json')) out.push({ fullPath: path.join(dirPath, name), foundState });
    }
  };
  if (state === 'drafting') {
    const draftingRoot = path.join(qdir, 'drafting');
    let lanes;
    try { lanes = fs.readdirSync(draftingRoot, { withFileTypes: true }); } catch { lanes = []; }
    for (const lane of lanes) {
      if (lane.isDirectory()) addDir(path.join(draftingRoot, lane.name), `drafting:${lane.name}`);
    }
  } else if (state === 'adhoc') {
    addDir(path.join(qdir, 'adhoc'), 'adhoc');
  } else if (QUEUE_STATES.includes(state)) {
    addDir(path.join(qdir, state), state);
  }
  return out;
}

function archivedTaskFiles(pipelineDir) {
  const qdir = path.join(pipelineDir, 'queue');
  const out = [];
  const noActionDir = path.join(qdir, 'done', '_archived_no_action');
  let names;
  try { names = fs.readdirSync(noActionDir); } catch { names = []; }
  for (const name of names) {
    if (name.endsWith('.json')) out.push({ fullPath: path.join(noActionDir, name), foundState: 'archived' });
  }
  const datedRoot = path.join(qdir, 'done', '_archived');
  let months;
  try { months = fs.readdirSync(datedRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { months = []; }
  for (const month of months) {
    const monthDir = path.join(datedRoot, month);
    let files;
    try { files = fs.readdirSync(monthDir); } catch { continue; }
    for (const name of files) {
      if (name.endsWith('.json')) out.push({ fullPath: path.join(monthDir, name), foundState: 'archived' });
    }
  }
  return out;
}

function searchTasksTool(pipelineDir, { query, state, includeArchived } = {}) {
  if (typeof query !== 'string' || !query.trim()) {
    return { error: 'search_tasks requires a non-empty "query" argument' };
  }
  const validStates = ['drafting', 'adhoc', ...QUEUE_STATES];
  let candidates = [];
  if (state != null) {
    if (state.startsWith('drafting:')) {
      const lane = state.slice('drafting:'.length);
      candidates = candidateTaskFiles(pipelineDir, 'drafting').filter((c) => c.foundState === `drafting:${lane}`);
    } else if (validStates.includes(state)) {
      candidates = candidateTaskFiles(pipelineDir, state);
    } else {
      return { error: `unknown state '${state}'. Valid: ${validStates.join(', ')}, a 'drafting:<lane>' name, or omit to search everywhere live.` };
    }
  } else {
    candidates = [
      ...candidateTaskFiles(pipelineDir, 'drafting'),
      ...QUEUE_STATES.flatMap((s) => candidateTaskFiles(pipelineDir, s)),
      ...candidateTaskFiles(pipelineDir, 'adhoc'),
    ];
  }
  if (includeArchived) candidates = [...candidates, ...archivedTaskFiles(pipelineDir)];

  const results = [];
  for (const { fullPath, foundState } of candidates) {
    if (results.length >= MAX_SEARCH_TASK_RESULTS) break;
    let data;
    try { data = JSON.parse(fs.readFileSync(fullPath, 'utf8')); } catch { continue; }
    const fallbackId = path.basename(fullPath, '.json');
    const haystack = `${data.title || ''} ${data.id || fallbackId}`;
    if (!lineMatches(haystack, query)) continue;
    results.push({ ...taskSummary(data, fallbackId), foundState });
  }
  return { results };
}

function queueReviewedTaskTool(pipelineDir, { title, description }) {
  if (typeof title !== 'string' || !title.trim()) return { error: 'queue_reviewed_task requires a non-empty "title" argument' };
  if (typeof description !== 'string' || !description.trim()) return { error: 'queue_reviewed_task requires a non-empty "description" argument' };
  if (isGitWriteRequest({ title, description })) return { error: GIT_WRITE_REQUEST_REFUSAL };
  const { domainsPath } = getConfig();
  try {
    // premiumPriority: true (2026-09-16, Grimmethy: "any tasks that chat is working on
    // directly should be labelled premium priority") -- every task Chat itself queues
    // is, by construction, something a human is actively watching Chat work on right
    // now, not a background-priority idea to triage eventually. See
    // queueAdhocTask()'s own header for what this field does.
    const { record } = queueAdhocTask(
      { title, promptContext: { rawText: description, raisedFrom: 'chat' }, premiumPriority: true },
      { pipelineDir, domainsPath },
    );
    return { queuedTaskId: record.id, message: `Queued as ${record.id} (premium priority) -- it will go through the normal review pipeline (see the Adhoc Tasks tab).` };
  } catch (e) {
    return { error: `failed to queue task: ${e.message}` };
  }
}

module.exports = { taskSummary, formatTaskHistory, windowSectionText, readTaskTool, candidateTaskFiles, archivedTaskFiles, searchTasksTool, queueReviewedTaskTool, READ_TASK_SECTIONS, MAX_SEARCH_TASK_RESULTS };
