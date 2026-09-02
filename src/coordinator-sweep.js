'use strict';

// Coordinator sweep (2026-09-02). A RESOLUTION: decompose parent no longer goes to done/
// and is forgotten -- applyAdhocDiff routes it to queue/coordinating/ with a `subTasks`
// checklist, and its children flow through the normal adhoc pipeline. This sweep runs on
// the queue-watchdog tick: for each coordinating parent it re-derives every child's real
// state, writes the checklist + progress back onto the parent, and once every child has
// reached a terminal-good state (done / merged / gone) it moves the parent to done/.
//
// Cheap by construction -- one readdirSync of a small dir plus a bounded findTaskRecordById
// per child -- so it runs unconditionally every tick (no --check-due gate). Best-effort per
// file: a malformed parent JSON is skipped, never fatal, same discipline as
// reject-retry-check.js / blocked-drain.js.

const fs = require('fs');
const path = require('path');
const { getConfig } = require('./config.js');
const { findTaskRecordById } = require('./forensic-bundle.js');
const { appendHistoryEvent } = require('./task-history.js');

// findTaskRecordById state -> the status shown on the parent's checklist.
function classifyChildStatus(rec) {
  if (!rec) return 'gone'; // not found anywhere -- completed and aged out, or hand-removed
  const state = rec.state;
  const merged = rec.task && rec.task.mergedAt;
  if (state === 'done') return merged ? 'merged' : 'done';
  if (state === 'archived') return 'merged'; // aged out of done/ into a month bucket -- it shipped
  if (state === 'archived_no_action') return 'abandoned';
  if (state === 'blocked' || state === 'needs-clarification' || state === 'awaiting-confirm') return state;
  return 'in-progress'; // pending / adhoc / drafting / review / approved / coordinating
}

// A child in one of these is finished as far as the parent is concerned. `abandoned` is
// deliberately terminal-good too: a human archived that sub-task on purpose, so it should
// not hold the parent open forever.
const TERMINAL_GOOD = new Set(['done', 'merged', 'gone', 'abandoned']);

function coordinatorSweep({ pipelineDir }) {
  const coordDir = path.join(pipelineDir, 'queue', 'coordinating');
  const doneDir = path.join(pipelineDir, 'queue', 'done');
  const summary = { checked: 0, updated: 0, completed: 0, errors: 0 };

  let names;
  try {
    names = fs.readdirSync(coordDir).filter((f) => f.endsWith('.json'));
  } catch {
    return summary; // no coordinating/ dir yet -- nothing to sweep
  }

  for (const name of names) {
    const file = path.join(coordDir, name);
    let parent;
    try {
      parent = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      summary.errors += 1;
      continue; // a malformed coordinating file is not this sweep's problem to fix
    }
    if (!Array.isArray(parent.subTasks) || parent.subTasks.length === 0) {
      // A coordinating parent with no checklist is a bug upstream -- complete it out so it
      // does not sit here forever.
      parent.status = 'done';
      parent.doneMarker = 'coordinator had no sub-tasks -- completed';
      appendHistoryEvent(parent, 'done', parent.doneMarker);
      moveToDone(file, doneDir, name, parent);
      summary.checked += 1;
      summary.completed += 1;
      continue;
    }

    summary.checked += 1;
    let doneCount = 0;
    for (const st of parent.subTasks) {
      const rec = st && st.id ? findTaskRecordById(pipelineDir, st.id) : null;
      st.status = classifyChildStatus(rec);
      if (TERMINAL_GOOD.has(st.status)) doneCount += 1;
    }
    parent.progress = { done: doneCount, total: parent.subTasks.length };
    parent.lastReconciledAt = new Date().toISOString();

    if (doneCount === parent.subTasks.length) {
      parent.status = 'done';
      parent.doneMarker = `coordinator complete: all ${parent.subTasks.length} sub-task(s) done`;
      appendHistoryEvent(parent, 'done', parent.doneMarker);
      moveToDone(file, doneDir, name, parent);
      summary.completed += 1;
    } else {
      try {
        fs.writeFileSync(file, JSON.stringify(parent, null, 2));
        summary.updated += 1;
      } catch {
        summary.errors += 1;
      }
    }
  }

  return summary;
}

function moveToDone(srcFile, doneDir, name, parent) {
  try {
    fs.mkdirSync(doneDir, { recursive: true });
    const dest = path.join(doneDir, name);
    if (fs.existsSync(dest)) return; // don't clobber -- something already put it there
    fs.writeFileSync(dest, JSON.stringify(parent, null, 2));
    fs.unlinkSync(srcFile);
  } catch { /* best-effort -- next tick retries */ }
}

module.exports = { coordinatorSweep, classifyChildStatus, TERMINAL_GOOD };

if (require.main === module) {
  const { pipelineDir } = getConfig();
  process.stdout.write(JSON.stringify(coordinatorSweep({ pipelineDir })));
}
