'use strict';

// hub-restack.js -- repair a hub that was built BEFORE "one hub = one stacked chain" (apply-adhoc-diff.js queueSubTasks).
//
// Those hubs could be MIXED: some pieces stacked on a shared branch (the ones the model linked with `after`), others independent and
// unstacked. The independent piece was held by hubHasUnmergedEarlierSibling behind an earlier sibling's UNMERGED branch (a human merge),
// and a later piece that needed both would draft on a branch missing the independent piece's work. PF function-length-fix-ac-2's nested
// hub (create tileGrid.ts / create usePropertyLocation.ts / wire both) froze exactly there.
//
// For a coordinating hub that already has a chain (every stacked child on ONE branch), this puts each not-yet-started child onto that
// chain in hub order: stacked {branch, seq: position, total}, dependsOn its predecessor. It never touches a child that has started
// (drafting / review / approved / blocked / done), a hub with no chain at all (fully independent pieces are left as they are), a hub whose
// stacked children span several branches, or a file-decompose hub (its own model). Idempotent. Kill switch AGENT_MANAGER_HUB_RESTACK=false.

const fs = require('fs');
const { appendHistoryEvent } = require('./task-history.js');

const UNSTARTED_STATES = new Set(['adhoc', 'pending', 'derived']);

function enabled() { return process.env.AGENT_MANAGER_HUB_RESTACK !== 'false'; }

function sameList(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);
}

// parent: the coordinating hub record. recById: Map<childId, { task, state, file } | null>. Returns the ids it changed.
function restackHubChain(parent, recById) {
  const changed = [];
  if (!enabled() || !parent || parent.decomposeHub === true || parent.mode) return changed;
  const subs = Array.isArray(parent.subTasks) ? parent.subTasks : [];
  if (subs.length < 2) return changed;
  const recs = subs.map((st) => (st && st.id ? recById.get(st.id) || null : null));

  const branches = new Set(recs.filter((r) => r && r.task && r.task.stacked && r.task.stacked.branch).map((r) => r.task.stacked.branch));
  if (branches.size !== 1) return changed; // no chain to join, or several -- not ours to merge into one
  const branch = [...branches][0];
  const siblingIds = new Set(subs.map((st) => st && st.id).filter(Boolean));
  // A NESTED hub (this hub is itself a stacked piece of a chain on the SAME branch) occupies its parent's slot in that chain, exactly as
  // apply-adhoc-diff.js queueSubTasks numbers it: children run firstSeq..firstSeq+n-1 of (parentTotal - 1 + n). Numbering them 1..n here
  // instead made the first child look like the chain's start, and apply-task.js's seq===1 path resets to main and recreates the branch --
  // discarding the parent chain's already-pushed steps (PF HUB0003-01: three identical non-fast-forward push failures, then needs-clarification).
  const own = parent.stacked && parent.stacked.branch === branch ? parent.stacked : null;
  const firstSeq = own ? (Number(own.seq) || 1) : 1;
  const chainTotal = own ? (Number(own.total) || firstSeq) - 1 + subs.length : subs.length;

  subs.forEach((st, i) => {
    const rec = recs[i];
    if (!rec || !rec.task || !UNSTARTED_STATES.has(rec.state) || !rec.file) return;
    // nearest EARLIER sibling that still has a record (a missing one would leave a dependsOn that can never be satisfied)
    let prev = null;
    for (let k = i - 1; k >= 0; k -= 1) { if (recs[k] && recs[k].task) { prev = subs[k].id; break; } }
    const task = rec.task;
    const keep = (Array.isArray(task.dependsOn) ? task.dependsOn : []).filter((d) => !siblingIds.has(d));
    const wantDeps = prev ? [...keep, prev] : keep;
    const wantStacked = { branch, seq: firstSeq + i, total: chainTotal };
    const stackedOk = task.stacked && task.stacked.branch === branch && task.stacked.seq === wantStacked.seq && task.stacked.total === wantStacked.total;
    const depsOk = sameList(task.dependsOn || [], wantDeps) || (!task.dependsOn && wantDeps.length === 0);
    if (stackedOk && depsOk) return;
    task.stacked = wantStacked;
    if (wantDeps.length) task.dependsOn = wantDeps; else delete task.dependsOn;
    appendHistoryEvent(task, 'restacked', `hub-restack: joined ${branch} as step ${wantStacked.seq}/${wantStacked.total}${prev ? `, after ${prev}` : ''} (one hub = one branch, so nothing waits on a merge)`);
    try { fs.writeFileSync(rec.file, JSON.stringify(task, null, 2)); changed.push(st.id); } catch { /* best-effort: retried next tick */ }
  });
  return changed;
}

module.exports = { restackHubChain };
