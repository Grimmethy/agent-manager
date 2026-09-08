'use strict';

// One-off migration: normalizes every task.history[] entry still written in the divergent
// { status, at, note } shape (context-trim-sweep.js / blocked-drain.js, before their
// 2026-09-08 fix) to the canonical { stage, at, detail } shape every other stage-transition
// writer uses (task-history.js's appendHistoryEvent). See task-history.js's own header for
// the schema, and context-trim-sweep.js/blocked-drain.js's own comments for the incident
// this closes -- a downstream consumer expecting .stage/.detail silently missed or blanked
// these entries (confirmed live: python/dashboard/app.py's _summarize_task_record had a
// .stage/.status fallback but no .detail/.note one, so these entries' explanatory text
// rendered blank in the Unmerged Branches detail modal).
//
// Walks every real task location a task file can sit in: queue/pending, blocked,
// needs-clarification, coordinating, adhoc, drafting/<every lane>, done, and done's own
// archives (_archived_no_action, _archived/<month>). Same directory set task-anywhere.js's
// QUEUE_STATES + drafting/adhoc/archive walk already establishes -- this script mirrors
// that precedence purely to enumerate every file, not to resolve a single id.
//
// Per-entry rule: an entry that already has `stage` is left completely untouched (makes a
// second run a safe no-op). An entry with `status` but no `stage` is rewritten to
// `{ stage: <status>, at, detail: <note, only if detail isn't already set> }` -- every
// other key on the entry, and every other field on the task, is preserved exactly.
//
// Flags (deliberately safer-by-default than task-log-reconcile.js's own convention, since
// that script runs harmlessly every pipeline tick while this one is a manual, one-time,
// whole-queue rewrite):
//   --report   (default) count what WOULD change, write nothing.
//   --write    actually rewrite the affected files. Required to make real changes.

const fs = require('fs');
const path = require('path');
const { QUEUE_STATES } = require('./task-anywhere.js');

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function readDirSafe(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

// Every real task-file location, newest/most-live first purely for a nicer --report
// ordering -- migration order has no other significance since each file is independent.
function allTaskFiles(pipelineDir) {
  const qdir = path.join(pipelineDir, 'queue');
  const files = [];

  for (const state of QUEUE_STATES) {
    for (const e of readDirSafe(path.join(qdir, state))) {
      if (e.isFile() && e.name.endsWith('.json')) files.push(path.join(qdir, state, e.name));
    }
  }

  const draftingRoot = path.join(qdir, 'drafting');
  for (const lane of readDirSafe(draftingRoot)) {
    if (!lane.isDirectory()) continue;
    for (const e of readDirSafe(path.join(draftingRoot, lane.name))) {
      if (e.isFile() && e.name.endsWith('.json')) files.push(path.join(draftingRoot, lane.name, e.name));
    }
  }

  for (const e of readDirSafe(path.join(qdir, 'adhoc'))) {
    if (e.isFile() && e.name.endsWith('.json')) files.push(path.join(qdir, 'adhoc', e.name));
  }

  const noActionDir = path.join(qdir, 'done', '_archived_no_action');
  for (const e of readDirSafe(noActionDir)) {
    if (e.isFile() && e.name.endsWith('.json')) files.push(path.join(noActionDir, e.name));
  }

  const datedArchiveRoot = path.join(qdir, 'done', '_archived');
  for (const month of readDirSafe(datedArchiveRoot)) {
    if (!month.isDirectory()) continue;
    const monthDir = path.join(datedArchiveRoot, month.name);
    for (const e of readDirSafe(monthDir)) {
      if (e.isFile() && e.name.endsWith('.json')) files.push(path.join(monthDir, e.name));
    }
  }

  return files;
}

// Returns { changed: bool, entriesFixed: number } -- mutates `data.history` in place when
// changed. Never touches an entry that already has `stage`.
function normalizeHistory(data) {
  const history = Array.isArray(data && data.history) ? data.history : null;
  if (!history || history.length === 0) return { changed: false, entriesFixed: 0 };
  let entriesFixed = 0;
  for (const entry of history) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.stage !== undefined) continue; // already canonical -- leave alone
    if (entry.status === undefined) continue; // neither shape -- leave alone (unrelated entry)
    entry.stage = entry.status;
    delete entry.status;
    if (entry.detail === undefined && entry.note !== undefined) entry.detail = entry.note;
    if (entry.note !== undefined) delete entry.note;
    entriesFixed += 1;
  }
  return { changed: entriesFixed > 0, entriesFixed };
}

function migrate({ pipelineDir, write = false }) {
  const summary = { scanned: 0, filesChanged: 0, entriesFixed: 0, errors: 0, changedFiles: [] };
  for (const file of allTaskFiles(pipelineDir)) {
    summary.scanned += 1;
    const data = readJsonSafe(file);
    if (!data) { summary.errors += 1; continue; }
    const { changed, entriesFixed } = normalizeHistory(data);
    if (!changed) continue;
    summary.filesChanged += 1;
    summary.entriesFixed += entriesFixed;
    summary.changedFiles.push({ file, entriesFixed });
    if (write) fs.writeFileSync(file, JSON.stringify(data, null, 2));
  }
  return summary;
}

module.exports = { migrate, normalizeHistory, allTaskFiles };

if (require.main === module) {
  const { getConfig } = require('./config.js');
  let cfg;
  try { cfg = getConfig(); } catch (e) {
    process.stderr.write(`migrate-history-status-note: ${e.message}\n`);
    process.exit(0);
  }
  const write = process.argv.includes('--write');
  const summary = migrate({ pipelineDir: cfg.pipelineDir, write });
  process.stderr.write(`migrate-history-status-note: ${write ? 'WROTE' : 'REPORT (dry run -- pass --write to apply)'} ` +
    `${summary.filesChanged}/${summary.scanned} file(s), ${summary.entriesFixed} entr(y/ies) normalized, ${summary.errors} unreadable\n`);
  if (!write) {
    for (const { file, entriesFixed } of summary.changedFiles) {
      process.stderr.write(`  would fix ${entriesFixed}: ${file}\n`);
    }
  }
  process.stdout.write(JSON.stringify(summary));
}
