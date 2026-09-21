'use strict';

// derived-gate.js -- DETERMINISTIC (no model, no agent cycle) gating for derived_task findings.
//
// Why (2026-09-21, PF): a project changing at ~35 commits/day plus a review of every commit yields findings about code that is edited again within
// hours. Of 35 abandoned PF tasks the median lived 1.3 h and 33 died within 12 h. A replay of candidate checks against the 27 labelled PF derived
// tasks (main as it stood when each was picked up) found the cheap "does the finding still hold on main" checks catch only ~1 in 4-5 (most obsolete
// tasks were still TRUE on main when picked up: they were about another task's unmerged work), so this is a modest, honest filter, not a cure:
//   1. premiseGone   -- every file the finding cites is missing from the working tree, origin/main AND the task's stacked branch (0 of 7 good tasks
//                       wrongly caught in the replay; 2 of 20 obsolete caught). The strongest check, so the only one that auto-retires by itself.
//   2. raisedByAbandoned -- the task that raised the finding was abandoned/retired (derivedFrom.taskId): exact provenance, cascade.
//   3. isHeld        -- HOLD, never skip: while another open code-changing task names the same file, keep the finding queued and let the lane take
//                       something else; it is re-evaluated (by 1) when released. A wrong hold only delays.
// The sweep that acts on 1 and 2 is derived-premise-sweep.js; task-sources.js calls isHeld while choosing the next derived task.
// Kill switches: AGENT_MANAGER_DERIVED_HOLD=false, AGENT_MANAGER_DERIVED_PREMISE_SWEEP=false. Hold cap: AGENT_MANAGER_DERIVED_HOLD_MAX_HOURS (24).

const fs = require('fs');
const path = require('path');

// Findings cite files as `src/x/y.tsx`, `App.tsx:93`, nginx.conf ... (broader than fact-checker's list: css / conf / yml / sh matter here).
const FILE_RE = /(?<![\w/.-])((?:[\w.@-]+\/)*[\w.@-]+\.(?:tsx?|jsx?|mjs|cjs|css|conf|md|json|ya?ml|ps1|sh|py|html))(?![\w-])/g;
const GENERATED_DOC_RE = /(_CANDIDATES\.md$|PRODUCT_SPEC(_OUTLINE)?\.md$|TROUBLE_LOG\.md$|BACKLOG_CANDIDATES\.md$)/;

// Sources that only READ code: they can hold nothing back.
const READ_ONLY_SOURCES = new Set([
  'change_review', 'pipeline_health_audit', 'pipeline_self_audit', 'pipeline_debrief', 'pipeline_forensics', 'pipeline_forensics_fix',
  'brain_dump_sort', 'staleness_audit', 'research_task',
]);
const OPEN_DIRS = ['adhoc', 'pending', 'review', 'approved', 'awaiting-confirm', 'derived'];
const OTHER_DIRS = ['adhoc', 'pending', 'review', 'approved', 'awaiting-confirm', 'blocked', 'needs-clarification', 'coordinating', 'done'];

const off = (name) => String(process.env[name] || '').trim().toLowerCase() === 'false';
const holdEnabled = () => !off('AGENT_MANAGER_DERIVED_HOLD');
const sweepEnabled = () => !off('AGENT_MANAGER_DERIVED_PREMISE_SWEEP');
function maxHoldMs() {
  const h = Number(process.env.AGENT_MANAGER_DERIVED_HOLD_MAX_HOURS);
  return (Number.isFinite(h) && h > 0 ? h : 24) * 3600 * 1000;
}

const rawTextOf = (task) => String((task && task.promptContext && typeof task.promptContext === 'object' && task.promptContext.rawText) || '');

// Paths a task cites (title + rawText), normalised, generated docs dropped.
function citedPaths(task) {
  const text = `${(task && task.title) || ''}\n${rawTextOf(task)}`;
  const out = new Set();
  for (const m of text.matchAll(FILE_RE)) {
    const p = m[1].replace(/\\/g, '/').replace(/^\.\//, '');
    if (!GENERATED_DOC_RE.test(p)) out.add(p);
  }
  return [...out];
}

const base = (p) => p.split('/').pop().toLowerCase();
// Two path sets overlap when a pair is the same file: equal, one a path-suffix of the other, or (bare name on either side) the same basename.
function filesOverlap(a, b) {
  for (const x of a) {
    for (const y of b) {
      const lx = x.toLowerCase(); const ly = y.toLowerCase();
      if (lx === ly || lx.endsWith(`/${ly}`) || ly.endsWith(`/${lx}`)) return true;
      if ((!lx.includes('/') || !ly.includes('/')) && base(lx) === base(ly)) return true;
    }
  }
  return false;
}

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function names(dir) { try { return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)); } catch { return []; } }

function createdAtMs(task) {
  const h = Array.isArray(task.history) ? task.history.find((x) => x && x.at) : null;
  const t = Date.parse(task.createdAt || (h && h.at) || '');
  return Number.isFinite(t) ? t : 0;
}

// Ids present in any state other than derived/ (and the archive): a derived/ file whose id is here is an inert leftover origin record.
function otherIds(queueDir) {
  const ids = new Set();
  for (const d of OTHER_DIRS) for (const n of names(path.join(queueDir, d))) ids.add(n);
  try { for (const lane of fs.readdirSync(path.join(queueDir, 'drafting'))) for (const n of names(path.join(queueDir, 'drafting', lane))) ids.add(n); } catch { /* none */ }
  for (const n of names(path.join(queueDir, 'done', '_archived_no_action'))) ids.add(n);
  return ids;
}

// Every open code-changing task once: [{ id, createdAt, files, source, derivedLive }].
function openTaskIndex(pipelineDir) {
  const queueDir = path.join(pipelineDir, 'queue');
  const elsewhere = otherIds(queueDir);
  const dirs = OPEN_DIRS.map((d) => [d, path.join(queueDir, d)]);
  try { for (const lane of fs.readdirSync(path.join(queueDir, 'drafting'))) dirs.push(['drafting', path.join(queueDir, 'drafting', lane)]); } catch { /* none */ }
  const index = [];
  for (const [state, dir] of dirs) {
    for (const id of names(dir)) {
      const task = readJson(path.join(dir, `${id}.json`));
      if (!task || typeof task !== 'object' || READ_ONLY_SOURCES.has(task.source)) continue;
      const derivedLive = state === 'derived';
      if (derivedLive && elsewhere.has(id)) continue; // inert leftover copy of a task that lives (or ended) elsewhere
      const files = citedPaths(task);
      if (files.length) index.push({ id: task.id || id, createdAt: createdAtMs(task), files, source: task.source, derivedLive });
    }
  }
  return index;
}

// HOLD decision for one derived candidate. Never holds a human-prioritised task, a task with no cited files, or one older than the hold cap.
// An open task X holds D when they overlap AND (X is not itself waiting in derived/, OR X is older): the strict order means the oldest derived task
// is never held by a newer one, so two overlapping derived tasks cannot hold each other forever.
function isHeld(candidate, index, { now = Date.now() } = {}) {
  if (!holdEnabled() || !candidate) return { held: false, by: [] };
  if (candidate.premiumPriority || candidate.humanQueued || candidate.pinnedWorker) return { held: false, by: [] };
  const files = citedPaths(candidate);
  if (!files.length) return { held: false, by: [] };
  const created = createdAtMs(candidate);
  if (created && now - created > maxHoldMs()) return { held: false, by: [] };
  const by = [];
  for (const x of index) {
    if (x.id === candidate.id || !filesOverlap(files, x.files)) continue;
    if (x.derivedLive && !(x.createdAt < created || (x.createdAt === created && x.id < candidate.id))) continue;
    by.push(x.id);
  }
  return { held: by.length > 0, by };
}

// The missing-files rule is only sound for findings that CLAIM a file exists. Two exemptions, found by dry-running it on agent-manager's own queue (5 of
// 5 candidates were false positives; PF's code-claim findings never showed this):
//   * the finding is ABOUT invented / fabricated / nonexistent / fixture / example paths ("the model cited `src/x.js`, which does not exist"): the
//     missing paths are its subject, not a broken premise;
//   * it was raised by the pipeline's own meta-analysis (pipeline_debrief / forensics / health audit / reject-retry / staleness / *_research): those
//     talk ABOUT the pipeline's failures and quote paths as illustrations.
const ABOUT_INVENTED_RE = /\b(invent|fabricat|hallucinat|nonexistent|non-existent|does not exist|doesn.t exist|not exist|fixture|e\.g\.|for example|illustrat|placeholder)/i;
const META_SOURCE_RE = /^(pipeline_|reject-retry|staleness|concept)|_research$/;
function missingFilesIsUnsafe(task) {
  const raiser = task && task.promptContext && task.promptContext.derivedFrom && task.promptContext.derivedFrom.source;
  if (typeof raiser === 'string' && META_SOURCE_RE.test(raiser)) return `raised by the pipeline's own analysis (${raiser})`;
  if (ABOUT_INVENTED_RE.test(`${(task && task.title) || ''}\n${rawTextOf(task)}`)) return 'the finding is about invented / fixture / example paths';
  return null;
}

// Deterministic premise check: does ANY cited file exist in the working tree, on origin/<main>, or on the task's own stacked branch?
// (repoRoot, mainBranch, extraRef, extraRoots) come from the caller; the existence primitives are injectable for tests.
function premiseGone(task, { repoRoot, mainBranch, extraRef = null, extraRoots = [], existsOnDisk, existsAtRef } = {}) {
  const { isDeclaredCreateTarget } = require('./plan-target-guard.js');
  const text = `${(task && task.title) || ''}\n${rawTextOf(task)}`;
  const paths = citedPaths(task).filter((p) => !isDeclaredCreateTarget(text, p));
  if (!paths.length || !repoRoot) return { gone: false, evidence: [] };
  const onDisk = existsOnDisk || ((p) => !!require('./fact-checker.js').resolveAgainstRepo(repoRoot, p, extraRoots));
  const atRef = existsAtRef || ((ref, p) => !!require('./stacked-grounding.js').resolveAtRef(repoRoot, ref, p, extraRoots));
  const missing = [];
  for (const p of paths) {
    let found = false;
    try { found = onDisk(p) || (!!mainBranch && atRef(mainBranch, p)) || (!!extraRef && atRef(extraRef, p)); } catch { found = true; } // an error is "unknown", never "gone"
    if (!found) missing.push(p);
  }
  const unsafe = missing.length === paths.length ? missingFilesIsUnsafe(task) : null;
  if (unsafe) return { gone: false, exempt: unsafe, evidence: [] };
  return missing.length === paths.length
    ? { gone: true, evidence: [`every file this finding cites is missing from the working tree, origin/${mainBranch || 'main'}${extraRef ? ` and ${extraRef}` : ''}: ${missing.join(', ')}`] }
    : { gone: false, evidence: [] };
}

// The task that raised this finding (promptContext.derivedFrom.taskId), when it was abandoned/retired: its id, else null.
function raisedByAbandoned(task, pipelineDir) {
  const pc = task && task.promptContext;
  const raiser = pc && pc.derivedFrom && typeof pc.derivedFrom === 'object' ? pc.derivedFrom.taskId : null;
  if (typeof raiser !== 'string' || !raiser) return null;
  const rec = readJson(path.join(pipelineDir, 'queue', 'done', '_archived_no_action', `${raiser}.json`));
  return rec && (rec.terminalDisposition === 'abandoned' || rec.manualArchive) ? raiser : null;
}

module.exports = {
  citedPaths, filesOverlap, openTaskIndex, isHeld, premiseGone, raisedByAbandoned, holdEnabled, sweepEnabled, otherIds, names, readJson,
  READ_ONLY_SOURCES, FILE_RE,
};
