'use strict';

// shared-branch.js -- which OTHER tasks have work on the same agent/* branch?
//
// 2026-10-08 (TaxHarvest): a hub's children are stacked on ONE branch (record.stacked.branch). Requeueing one of them deleted that whole branch
// (routes/task.py, chat-task-requeue.js: `git push origin --delete <applied branch>`), destroying every unmerged sibling commit on it. HUB0018-01's
// approved StartPage change was lost that way and recorded "abandoned: work lost"; HUB0007-01 got the same record although its work was already on
// main. 2 of the 31 requeue-driven deletions on record were shared-branch deletions. Both requeue paths now ask this module first and KEEP a branch
// that other live work sits on.
//
// A sibling is a task other than `selfId` that was APPLIED to `branch` (an `applied` history event naming it, or the same stacked.branch plus any applied
// event) and is not terminal. Terminal = merged | applied-direct | filed | dismissed | noop | abandoned | superseded | aged-out: such a task has nothing
// on the branch that deleting would destroy. A task still waiting to apply (no applied event) has nothing on the branch yet either.
//
// Never throws: any read failure yields { error } and the callers treat that as "shared" (keep the branch) -- a stale pushed branch is the cheap mistake,
// a deleted shared one is the expensive one.

const fs = require('fs');
const path = require('path');

const TERMINAL = new Set(['merged', 'applied-direct', 'filed', 'dismissed', 'noop', 'abandoned', 'superseded', 'aged-out']);
const SCAN_DIRS = ['done', 'review', 'approved', 'pending', 'adhoc', 'blocked', 'needs-clarification', 'awaiting-confirm', 'drafting'];

const bare = (b) => String(b || '').replace(/^(?:refs\/)?(?:remotes\/)?(?:origin\/)?/, '');

function appliedEvents(task) {
  return (Array.isArray(task && task.history) ? task.history : []).filter((h) => h && h.stage === 'applied');
}

// Does this task have an applied commit on `branch`?
function isAppliedTo(task, branch) {
  const want = bare(branch);
  const evs = appliedEvents(task);
  if (evs.some((e) => bare(String(e.detail || '').split(/\s/)[0]) === want)) return true;
  return !!(task && task.stacked && bare(task.stacked.branch) === want && evs.length > 0);
}

function isLive(task) {
  return !(task && TERMINAL.has(task.terminalDisposition));
}

function listJson(dir) {
  try { return fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
}

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

// -> { siblings: [{ id, state }] } or { siblings: [], error }
function liveSiblingsOnBranch({ pipelineDir, branch, selfId }) {
  try {
    if (!pipelineDir || !branch) return { siblings: [], error: 'missing pipelineDir or branch' };
    const out = [];
    const seen = new Set();
    for (const state of SCAN_DIRS) {
      const dir = state === 'drafting' ? path.join(pipelineDir, 'queue', 'drafting') : path.join(pipelineDir, 'queue', state);
      const files = state === 'drafting'
        ? listJson(dir).map((f) => path.join(dir, f)).concat(
          (() => { try { return fs.readdirSync(dir).flatMap((w) => listJson(path.join(dir, w)).map((f) => path.join(dir, w, f))); } catch { return []; } })())
        : listJson(dir).map((f) => path.join(dir, f));
      for (const file of files) {
        const task = readJson(file);
        if (!task || !task.id || task.id === selfId || seen.has(task.id)) continue;
        if (isAppliedTo(task, branch) && isLive(task)) { seen.add(task.id); out.push({ id: task.id, state }); }
      }
    }
    return { siblings: out };
  } catch (e) {
    return { siblings: [], error: String(e && e.message || e) };
  }
}

module.exports = { liveSiblingsOnBranch, isAppliedTo, isLive, TERMINAL, SCAN_DIRS, bare };
