'use strict';

// hub-rename.js -- give a hub's own record the HUB#### id (hub-serial.js labels a hub and its members; a hub record keeps the id of the task
// that became it, e.g. `function-length-fix-ac-2`). 2026-09-20, Grimmethy: "Please also rename the current hub."
//
// What changes: the hub file (queue/coordinating/<old>.json -> <HUB####>.json) and its `id`; `formerIds` records the old id; every reference to the
// old id that a hub owns -- its members' `promptContext.decomposedFrom`, a nested hub's `parentHub`, the parent hub's checklist entry, `dependsOn`
// edges from unstarted tasks. Member ids are NOT renamed: a member's id is in its commit trailer, which merge detection (depWorkIsOnMainBranch)
// reads, and in its branch and worklog.
//
// A member a worker is mid-way through (drafting / pending / review / approved) is not rewritten under it -- the worker saves its own copy of the
// file and would undo the edit. Those references are healed by repairStaleHubRefs() (called from coordinator-sweep.js every tick) once the member
// settles; until then the stale decomposedFrom simply fails open (the child is not ordered/held as a hub child, it is still a leaf).

const fs = require('fs');
const path = require('path');
const { findTaskRecordById } = require('./forensic-bundle.js');
const { RETITLE_SAFE_STATES } = require('./hub-serial.js');
const { appendHistoryEvent } = require('./task-history.js');

function writeJsonAtomic(file, obj) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

// Rewrite one record with `mutate(task) -> boolean changed`, only when its state is safe and nothing wrote it meanwhile.
function rewriteIfIdle(rec, mutate) {
  const idle = (st) => RETITLE_SAFE_STATES.has(st) || ['coordinating', 'archived_no_action', 'archived'].includes(st);
  if (!rec || !rec.file || !idle(rec.state)) return 'deferred';
  try {
    const before = fs.statSync(rec.file).mtimeMs;
    const fresh = JSON.parse(fs.readFileSync(rec.file, 'utf8'));
    if (!mutate(fresh)) return 'unchanged';
    if (fs.statSync(rec.file).mtimeMs !== before) return 'deferred';
    writeJsonAtomic(rec.file, fresh);
    return 'rewritten';
  } catch { return 'deferred'; }
}

// Returns { renamed, from, to, rewritten, deferred[] } or { renamed:false, reason }.
function renameHub(pipelineDir, oldId) {
  const coordDir = path.join(pipelineDir, 'queue', 'coordinating');
  const oldFile = path.join(coordDir, `${oldId}.json`);
  let hub;
  try { hub = JSON.parse(fs.readFileSync(oldFile, 'utf8')); } catch { return { renamed: false, reason: `no coordinating hub ${oldId}` }; }
  const newId = hub.hubLabel;
  if (!newId) return { renamed: false, reason: `${oldId} has no hubLabel yet (the coordinator sweep labels it)` };
  if (oldId === newId) return { renamed: false, reason: 'already renamed' };
  const newFile = path.join(coordDir, `${newId}.json`);
  if (fs.existsSync(newFile)) return { renamed: false, reason: `${newFile} already exists` };

  hub.formerIds = [...new Set([...(hub.formerIds || []), oldId])];
  hub.id = newId;
  appendHistoryEvent(hub, 'advisory', `renamed ${oldId} -> ${newId} (hub-serial naming); members keep their ids`);
  writeJsonAtomic(newFile, hub);
  fs.unlinkSync(oldFile);

  const out = { renamed: true, from: oldId, to: newId, rewritten: 0, deferred: [] };
  const swap = (arr) => (Array.isArray(arr) ? arr.map((d) => (d === oldId ? newId : d)) : arr);

  // members: decomposedFrom
  for (const st of Array.isArray(hub.subTasks) ? hub.subTasks : []) {
    if (!st || !st.id) continue;
    const rec = findTaskRecordById(pipelineDir, st.id);
    if (!rec || !rec.task.promptContext || rec.task.promptContext.decomposedFrom !== oldId) continue;
    const r = rewriteIfIdle(rec, (t) => { if (!t.promptContext || t.promptContext.decomposedFrom !== oldId) return false; t.promptContext.decomposedFrom = newId; return true; });
    if (r === 'rewritten') out.rewritten += 1; else if (r === 'deferred') out.deferred.push(st.id);
  }

  // other hubs: a nested hub's parentHub, and the checklist entry that lists THIS hub as a member
  let names = [];
  try { names = fs.readdirSync(coordDir).filter((f) => f.endsWith('.json') && f !== `${newId}.json`); } catch { /* none */ }
  for (const name of names) {
    const file = path.join(coordDir, name);
    try {
      const other = JSON.parse(fs.readFileSync(file, 'utf8'));
      let changed = false;
      if (other.parentHub === oldId) { other.parentHub = newId; changed = true; }
      if (other.promptContext && other.promptContext.decomposedFrom === oldId) { other.promptContext.decomposedFrom = newId; changed = true; }
      for (const st of Array.isArray(other.subTasks) ? other.subTasks : []) if (st && st.id === oldId) { st.id = newId; changed = true; }
      const dep = swap(other.dependsOn); if (changed || (Array.isArray(other.dependsOn) && dep.some((d, i) => d !== other.dependsOn[i]))) { other.dependsOn = dep; changed = true; }
      if (changed) { writeJsonAtomic(file, other); out.rewritten += 1; }
    } catch { /* malformed -- not ours */ }
  }

  // unstarted tasks that wait on this hub (decompose-loop rescue: dependsOn:[<hub>])
  for (const state of ['adhoc', 'derived', 'blocked', 'needs-clarification']) {
    const dir = path.join(pipelineDir, 'queue', state);
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { continue; }
    for (const f of files) {
      const rec = { file: path.join(dir, f), state };
      const r = rewriteIfIdle(rec, (t) => {
        const a = Array.isArray(t.dependsOn) && t.dependsOn.includes(oldId);
        const b = Array.isArray(t.softDependsOn) && t.softDependsOn.includes(oldId);
        if (!a && !b) return false;
        if (a) t.dependsOn = swap(t.dependsOn);
        if (b) t.softDependsOn = swap(t.softDependsOn);
        return true;
      });
      if (r === 'rewritten') out.rewritten += 1;
    }
  }
  return out;
}

// Heal members a rename had to skip: any member of `hub` whose decomposedFrom is one of the hub's former ids gets the current id, once idle.
// recById: Map<childId, { task, state, file } | null>. Returns the number rewritten.
function repairStaleHubRefs(hub, recById) {
  const former = Array.isArray(hub && hub.formerIds) ? hub.formerIds : [];
  if (!former.length || !Array.isArray(hub.subTasks)) return 0;
  let n = 0;
  for (const st of hub.subTasks) {
    const rec = st && st.id ? recById.get(st.id) : null;
    if (!rec || !rec.task || !rec.task.promptContext || !former.includes(rec.task.promptContext.decomposedFrom)) continue;
    const r = rewriteIfIdle(rec, (t) => {
      if (!t.promptContext || !former.includes(t.promptContext.decomposedFrom)) return false;
      t.promptContext.decomposedFrom = hub.id;
      return true;
    });
    if (r === 'rewritten') { rec.task.promptContext.decomposedFrom = hub.id; n += 1; }
  }
  return n;
}

module.exports = { renameHub, repairStaleHubRefs };

if (require.main === module) {
  // node src/hub-rename.js <pipelineDir> <oldId>...   (or --all: every labelled hub whose id is not its label, oldest first)
  const [pipelineDir, ...ids] = process.argv.slice(2);
  let targets = ids;
  if (ids[0] === '--all') {
    const coordDir = path.join(pipelineDir, 'queue', 'coordinating');
    targets = fs.readdirSync(coordDir).filter((f) => f.endsWith('.json')).map((f) => {
      try { const h = JSON.parse(fs.readFileSync(path.join(coordDir, f), 'utf8')); return h.hubLabel && h.id !== h.hubLabel ? { id: h.id, n: h.hubSerial || 0 } : null; } catch { return null; }
    }).filter(Boolean).sort((a, b) => a.n - b.n).map((h) => h.id);
  }
  for (const id of targets) console.log(JSON.stringify(renameHub(pipelineDir, id)));
}
