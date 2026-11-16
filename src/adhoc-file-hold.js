'use strict';

// adhoc-file-hold.js -- DETERMINISTIC (no model, no timer) hold for adhoc tasks.
//
// A pick must not start an adhoc task whose files overlap another OPEN task in the same
// hub chain: two sibling pieces editing one file race each other and produce conflicting
// diffs. This module supplies the pure pieces; the pick path (wired separately) builds one
// index per pick call and asks isFileHeld for each candidate.
//
// Contract:
//   filesOfTask(task)            -> Set of repo-relative paths (Files: line + cited paths)
//   openAdhocIndex(sources)      -> Map keyed by `${repo}\0${hubId}` -> [{ id, repo, hubId, state, files }]
//   isFileHeld(task, index, env) -> boolean; fails OPEN (false) on any error
// Kill switch: AGENT_MANAGER_CLAIM_FILE_SERIALIZE=false disables the hold.

const fs = require('fs');
const path = require('path');
const { extractDeclaredFiles } = require('./adhoc-diff-sanity.js');
const { citedPaths, filesOverlap, readJson, names } = require('./derived-gate.js');
const { hubIdForTask } = require('./hub-priority.js');

// States whose tasks count as open. The 'pending' directory is the pending-claimed state;
// the name 'pending-claimed' does not occur in this repo's src, so the directory is used.
const OPEN_STATES = ['drafting', 'review', 'approved', 'pending'];

const rawTextOf = (task) => String((task && (task.rawText || (task.promptContext && task.promptContext.rawText))) || '');

// Repo-relative paths a task touches: its declared Files: line plus paths named in its text.
function filesOfTask(task) {
  const out = new Set();
  if (!task || typeof task !== 'object') return out;
  const declared = extractDeclaredFiles(rawTextOf(task));
  for (const p of declared || []) out.add(p);
  for (const p of citedPaths(task)) out.add(p);
  return out;
}

// sources: [{ repo, pipelineDir }]. Builds a per-call index of open tasks that declare files.
// An unreadable source or entry is skipped (fail open: a missing entry never holds anything).
function openAdhocIndex(sources) {
  const index = new Map();
  for (const src of Array.isArray(sources) ? sources : []) {
    if (!src || typeof src.pipelineDir !== 'string') continue;
    const repo = String(src.repo || '');
    const queueDir = path.join(src.pipelineDir, 'queue');
    const dirs = [];
    for (const state of OPEN_STATES) {
      if (state !== 'drafting') { dirs.push([state, path.join(queueDir, state)]); continue; }
      try {
        for (const lane of fs.readdirSync(path.join(queueDir, 'drafting'))) {
          dirs.push([state, path.join(queueDir, 'drafting', lane)]);
        }
      } catch { /* no drafting dir */ }
    }
    for (const [state, dir] of dirs) {
      for (const id of names(dir)) {
        const task = readJson(path.join(dir, `${id}.json`));
        if (!task || typeof task !== 'object') continue;
        const hubId = hubIdForTask(task);
        if (!hubId) continue;
        const files = filesOfTask(task);
        if (!files.size) continue;
        const key = `${repo}\0${hubId}`;
        if (!index.has(key)) index.set(key, []);
        index.get(key).push({ id: task.id || id, repo, hubId, state, files });
      }
    }
  }
  return index;
}

// True when an open task in the same hub chain (and repo) declares a file that overlaps this task's.
function isFileHeld(task, index, env = process.env) {
  try {
    const flag = String((env && env.AGENT_MANAGER_CLAIM_FILE_SERIALIZE) || '').trim().toLowerCase();
    if (flag === 'false') return false;
    if (!task || typeof task !== 'object') return false;
    const files = filesOfTask(task);
    if (!files.size) return false;
    const hubId = hubIdForTask(task);
    if (!hubId) return false;
    if (!(index instanceof Map)) return false;
    const entries = index.get(`${String(task.repo || '')}\0${hubId}`) || [];
    for (const entry of entries) {
      if (entry.id === task.id) continue;
      if (filesOverlap(files, entry.files)) return true;
    }
    return false;
  } catch {
    return false; // index or task error: fail open
  }
}

module.exports = { filesOfTask, openAdhocIndex, isFileHeld };
