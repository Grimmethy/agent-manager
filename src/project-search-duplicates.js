'use strict';

// project_search duplicate cleanup (the source's `expiry` hook, src/expiry-sweep.js). The generator makes a fresh search task whenever it is the
// source's turn and keeps no memory of an unclaimed one, so a throttle leak (2026-10-20 to 10-23) left 1,196 interchangeable copies in queue/pending/.
// Each copy holds the same project docs and the known-lead URLs of its moment, so ONE is enough: the NEWEST (it knows the most leads) stays, the older
// copies are archived (reversible, id stays reserved). Pure: reads only what the sweep hands in.

function createdMs(task) {
  const t = Date.parse(task && task.createdAt);
  return Number.isFinite(t) ? t : null;
}

function groupKey(task) {
  const pc = (task && task.promptContext) || {};
  return String(task.generatedForRepoRoot || pc.projectTag || '');
}

// tasks: [{ id, task }] -> [{ id, action: 'archive', reason }]
function findDuplicateProjectSearch({ tasks } = {}) {
  const groups = new Map();
  for (const entry of tasks || []) {
    if (!entry || !entry.task) continue;
    const key = groupKey(entry.task);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  const out = [];
  for (const [, members] of groups) {
    if (members.length < 2) continue;
    const dated = members.filter((m) => createdMs(m.task) !== null);
    // An undated task is not provably older than anything, so it is left out of `dated` and never archived.
    dated.sort((a, b) => (createdMs(a.task) - createdMs(b.task)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const keep = dated[dated.length - 1];
    const tag = (keep.task.promptContext && keep.task.promptContext.projectTag) || groupKey(keep.task);
    for (const m of dated) {
      if (m === keep) continue;
      out.push({ id: m.id, action: 'archive', reason: `duplicate queued project_search search for ${tag}: superseded by ${keep.id}` });
    }
  }
  return out;
}

module.exports = { findDuplicateProjectSearch };
