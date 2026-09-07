'use strict';

// Deterministic build-tally backfill (2026-09-06, Grimmethy: "I envision them as a sort
// of hub we can return to and develop and optimize over time" -- real registry data
// confirmed the actual gap: 14 of 16 tracked concepts sat at builtFromScratchCount/
// adaptedFromResourceCount 0/0 despite real, obviously-related shipped work -- because
// the ONLY existing signal (CONCEPT-BUILD:, self-reported by the model) requires a task
// to be explicitly opted in via promptContext at draft time, which almost never happens
// in practice even for work that is clearly tied to a tracked concept).
//
// This sweep closes the gap for the one case it CAN close safely: a done/shipped task
// whose own title or rawText literally names a tracked concept. That is a real,
// deterministic, high-confidence signal -- concept names are deliberately distinct,
// human-chosen phrases, so an exact case-insensitive substring match needs no model
// judgment call and carries none of the false-attribution risk a fuzzy keyword sweep
// would (this pipeline has been burned by exactly that risk shape before -- brain-dump
// self-project hallucination, etc.). It deliberately does NOT retroactively fix a task
// that shipped before its concept existed and never mentions it anywhere (e.g. the
// original file-decompose-to-hub.js work, which predates the "File Componentization"
// concept) -- there is no real textual signal to backfill from there without guessing,
// and guessing is exactly what this sweep exists to avoid.
//
// linkedTaskCount/linkedTaskIds are kept SEPARATE from the existing self-reported
// builtFromScratchCount/adaptedFromResourceCount tally -- this is a different, genuinely
// deterministic kind of signal, and conflating the two would blur the "NOT verified,
// self-reported" caveat the existing tally still needs to carry (it can't tell scratch
// from adapted, only "a real task really did mention this concept by name").
//
// Real incident this sizing is built around: app.py's own _concept_task_history_rows
// found an UNBOUNDED scan of this pipeline's real done/ (6,077 files, 290MB accumulated
// this session) took 73 SECONDS -- so this sweep, like task-log-reconcile.js's own
// state-file convention, remembers every task id it has already checked and only ever
// scans NEW ones on a later call, bounded per-call by a wall-clock budget so a single
// invocation (e.g. one watchdog tick) can never repeat that hazard even on the very
// first run against the full backlog.

const fs = require('fs');
const path = require('path');
const { getConfig } = require('./config.js');
const { loadConcepts, writeConcepts } = require('./concepts.js');

const DEFAULT_BUDGET_MS = 5000;
const MIN_CONCEPT_NAME_LENGTH = 4; // a name shorter than this risks matching almost anything

function statePath(pipelineDir) {
  return path.join(pipelineDir, 'queue', 'concept-tally-backfill-state.json');
}

function loadState(pipelineDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(pipelineDir), 'utf8'));
    return { checkedIds: new Set(Array.isArray(parsed.checkedIds) ? parsed.checkedIds : []) };
  } catch {
    return { checkedIds: new Set() };
  }
}

function saveState(pipelineDir, state) {
  const out = { updatedAt: new Date().toISOString(), checkedIds: [...state.checkedIds].sort() };
  try { fs.writeFileSync(statePath(pipelineDir), JSON.stringify(out, null, 2)); } catch { /* best-effort */ }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Every directory a shipped task can live in -- mirrors python/dashboard/app.py's own
// _concept_task_history_rows enumeration (done/, done/_archived_no_action/, every
// done/_archived/<YYYY-MM>/ bucket) so this sweep and that dashboard view agree on what
// "shipped" means.
function doneDirs(pipelineDir) {
  const qdir = path.join(pipelineDir, 'queue');
  const dirs = [path.join(qdir, 'done')];
  const noAction = path.join(qdir, 'done', '_archived_no_action');
  if (fs.existsSync(noAction)) dirs.push(noAction);
  const datedRoot = path.join(qdir, 'done', '_archived');
  if (fs.existsSync(datedRoot)) {
    let entries = [];
    try { entries = fs.readdirSync(datedRoot); } catch { entries = []; }
    for (const name of entries) {
      const full = path.join(datedRoot, name);
      try { if (fs.statSync(full).isDirectory()) dirs.push(full); } catch { /* skip */ }
    }
  }
  return dirs;
}

// Exact, case-insensitive phrase match -- deliberately strict, not fuzzy keyword scoring.
function taskMentionsConcept(task, concept) {
  const name = String((concept && concept.name) || '').trim().toLowerCase();
  if (name.length < MIN_CONCEPT_NAME_LENGTH) return false;
  const haystack = `${(task && task.title) || ''}\n${(task && task.promptContext && task.promptContext.rawText) || ''}`.toLowerCase();
  return haystack.includes(name);
}

// Walks NEW done/archived tasks (never checked before, per the state file) and links
// each to every concept whose name it mentions verbatim. Idempotent: a task id is
// remembered once examined and never re-read again, and linkedTaskIds itself de-dupes
// regardless. budgetMs bounds THIS call's wall-clock cost -- never an unbounded scan,
// even on the very first run against the full historical backlog.
function backfillConceptTally(pipelineDir, { budgetMs = DEFAULT_BUDGET_MS, now = Date.now } = {}) {
  const data = loadConcepts(pipelineDir);
  if (!data.concepts.length) return { checked: 0, linked: 0, truncated: false };
  const state = loadState(pipelineDir);
  const deadline = now() + budgetMs;

  let checked = 0;
  let linked = 0;
  let truncated = false;
  let dirty = false;

  outer:
  for (const dir of doneDirs(pipelineDir)) {
    let names;
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { continue; }
    for (const name of names) {
      if (now() > deadline) { truncated = true; break outer; }
      const id = name.slice(0, -'.json'.length);
      if (state.checkedIds.has(id)) continue;
      state.checkedIds.add(id);
      checked += 1;
      const task = readJson(path.join(dir, name));
      if (!task) continue;
      for (const concept of data.concepts) {
        if (!taskMentionsConcept(task, concept)) continue;
        concept.linkedTaskIds = concept.linkedTaskIds || [];
        if (concept.linkedTaskIds.includes(id)) continue;
        concept.linkedTaskIds.push(id);
        concept.linkedTaskCount = concept.linkedTaskIds.length;
        linked += 1;
        dirty = true;
      }
    }
  }

  if (dirty) writeConcepts(pipelineDir, data);
  saveState(pipelineDir, state);
  return { checked, linked, truncated };
}

module.exports = { backfillConceptTally, taskMentionsConcept, doneDirs, statePath, DEFAULT_BUDGET_MS };

if (require.main === module) {
  let cfg;
  try { cfg = getConfig(); } catch (e) {
    process.stderr.write(`concept-tally-backfill: ${e.message}\n`);
    process.exit(0);
  }
  const summary = backfillConceptTally(cfg.pipelineDir);
  process.stdout.write(JSON.stringify(summary));
}
