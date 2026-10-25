'use strict';

// Deterministic "is this brain-dump entry's work already in the queue?" check for
// brain_dump_sort (2026-10-18, owner: "File the brain dump sort check ... high priority").
//
// Incident: the harness-upgrade entries (serials 1889-1905) were carried through the real
// pipeline by an operator session (act-as-local-agent), each task naming its entry as
// promptContext.raisedFrom 'brain-dump-<serial>'. brain_dump_sort still sorted every one of
// them hours later and queued a fresh adhoc task per entry -- three exact duplicates of
// merged/applied work had to be archived by hand from pending/. The only duplicate check was
// the classifier fuzzy-matching queued TITLES (apply-group-a-brain-dump.js applyDuplicateGate):
// a model call standing in for a lookup, and blind to done/ and the archives.
//
// A task belongs to an entry when it is NOT the brain_dump_sort task itself and any of:
//   - promptContext.brainDumpEntryId === entry.id          (the sorter's own adhoc/research tasks)
//   - raisedFrom (top level or promptContext) is 'brain-dump-<entry.id>' or 'brain-dump-<entry.serial>',
//     optionally followed by a space/parenthesis note       (operator-filed records)
//   - its id is the entry's queuedTaskId                    (the dashboard's prioritize route)
//
// Cost: done/ alone is ~486 MB / ~2.5k files plus ~3.9k archived (measured 2026-10-18). A task
// made for an entry is necessarily written after the entry's capturedAt, so only files whose
// mtime is at or after capturedAt are parsed (a filename containing the entry id is always
// checked), and only files containing the entry id, 'brain-dump-<serial>' or the queuedTaskId are parsed at all. An
// entry with no parseable capturedAt has every file read (still pre-filtered).

const fs = require('fs');
const path = require('path');

// Every place a task record can sit, terminal ones included (an archived task still means the
// work was handled). drafting/ and done/_archived/ have one level of subfolders.
const FLAT_DIRS = ['adhoc', 'derived', 'pending', 'review', 'approved', 'blocked', 'needs-clarification',
  'awaiting-confirm', 'coordinating', 'research', 'done', path.join('done', '_archived_no_action'), path.join('done', '_superseded')];
const NESTED_DIRS = ['drafting', path.join('done', '_archived')];

function stateLabel(rel) {
  return rel.split(path.sep).slice(0, 2).join('/');
}

function candidateFiles(queueDir) {
  const out = [];
  const add = (dir, rel) => {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const n of names) if (n.endsWith('.json')) out.push({ file: path.join(dir, n), state: stateLabel(rel) });
  };
  for (const rel of FLAT_DIRS) add(path.join(queueDir, rel), rel);
  for (const rel of NESTED_DIRS) {
    let subs = [];
    try { subs = fs.readdirSync(path.join(queueDir, rel), { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { continue; }
    for (const d of subs) add(path.join(queueDir, rel, d.name), path.join(rel, d.name));
  }
  return out;
}

function raisedFromMatches(value, entry) {
  if (typeof value !== 'string') return false;
  const m = /^brain-dump-(\S+?)(?=$|[\s(])/.exec(value.trim());
  if (!m) return false;
  return m[1] === entry.id || (entry.serial != null && m[1] === String(entry.serial));
}

// Why `task` belongs to `entry` ('brainDumpEntryId' | 'raisedFrom' | 'queuedTaskId'), or null.
function taskMatchesEntry(task, entry) {
  if (!task || typeof task !== 'object' || !entry) return null;
  if (task.source === 'brain_dump_sort' || task.domain === 'brain_dump_sort') return null;
  const pc = task.promptContext || {};
  if (pc.brainDumpEntryId && pc.brainDumpEntryId === entry.id) return 'brainDumpEntryId';
  if (raisedFromMatches(task.raisedFrom, entry) || raisedFromMatches(pc.raisedFrom, entry)) return 'raisedFrom';
  if (entry.queuedTaskId && task.id === entry.queuedTaskId) return 'queuedTaskId';
  return null;
}

// First existing task for `entry` across `pipelineDirs` -> { taskId, state, how, pipelineDir, scanned } or null.
function findExistingWorkForEntry(pipelineDirs, entry) {
  if (!entry || !entry.id) return null;
  const capturedMs = Date.parse(entry.capturedAt);
  const dirs = [...new Set((Array.isArray(pipelineDirs) ? pipelineDirs : [pipelineDirs]).filter(Boolean))];
  let scanned = 0;
  const needles = [entry.id, ...(entry.serial != null ? [`brain-dump-${entry.serial}`] : []), ...(entry.queuedTaskId ? [entry.queuedTaskId] : [])];
  for (const pd of dirs) {
    for (const { file, state } of candidateFiles(path.join(pd, 'queue'))) {
      const base = path.basename(file);
      if (Number.isFinite(capturedMs) && !base.includes(entry.id)) {
        let mtime;
        try { mtime = fs.statSync(file).mtimeMs; } catch { continue; }
        if (mtime < capturedMs) continue;
      }
      let raw;
      try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
      // Substring pre-filter before JSON.parse (parsing large done/ records is most of the cost: an entry captured
      // 2026-08-14 took ~52 s parsing everything newer than it). Every matching rule needs one of these strings in the file.
      if (!needles.some((n) => raw.includes(n))) continue;
      let task;
      try { task = JSON.parse(raw); } catch { continue; }
      scanned += 1;
      const how = taskMatchesEntry(task, entry);
      if (how) return { taskId: task.id || base.replace(/\.json$/, ''), state, how, pipelineDir: pd, scanned };
    }
  }
  return null;
}

// Mark the entry as handled by the found task (mutates `entry`), the same fields the dashboard's
// prioritize route sets, plus a linkedExistingWork stamp saying how and when the link was made.
function linkEntryToExistingWork(entry, found, by) {
  const at = new Date().toISOString();
  entry.status = 'actioned';
  entry.queuedTaskId = found.taskId;
  entry.queuedAt = entry.queuedAt || at;
  entry.linkedExistingWork = { taskId: found.taskId, state: found.state, how: found.how, by, at };
  return entry;
}

module.exports = { findExistingWorkForEntry, linkEntryToExistingWork, taskMatchesEntry, raisedFromMatches, candidateFiles };
