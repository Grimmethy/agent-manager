'use strict';

// inert-target.js -- is the code a derived finding is ABOUT even reachable?
//
// 2026-10-08 (TaxHarvest): a derived finding "`_patchRun` silently drops status changes when run is already 'Stopped'" went draft -> review -> apply -> a
// branch awaiting a human, although `_patchRun` has no caller anywhere (the run state lives in importJobStore). The finding had been raised while a
// deadcode_triage task examined the same module; nothing in the derived flow asked whether the thing it wanted fixed is ever called. The dead-code
// scanner ALREADY knew: queue/dead-code-flags.json listed `_patchRun` with callSites []. Replayed over the 196 TaxHarvest derived tasks, the same
// lookup matches 3 distinct tasks, all in runStore.js, all dead-path work (one of them was MERGED); no other merged task. A modest filter, not a cure.
//
// Rule (pure, no model call, no grep of its own -- it reads what the scanner already wrote):
//   target   the task's PRIMARY symbol: the first backticked identifier in the title, else the first in the body;
//   inert    a flags entry for that symbol, defined in a file the task cites, with no call sites;
//   genuine  a deadcode_triage record in done/ for the same symbol + file that reached a GENUINE verdict (its implementResponse carries the vetted
//            `### AC-N` removal candidate, Strength: Strong). Only this lets the sweep RETIRE the task; an inert target without it is HELD.
// A flags entry that now HAS call sites releases a held task and restores a retired one (the paired re-admission).
//
// Known limit: a human who later discards that removal candidate at a sift does not un-genuine the triage record. The retirement is archived
// (done/_archived_no_action), reversible, and re-admitted the moment the symbol gains a caller.
//
// Never throws: anything unreadable means "no match".

const fs = require('fs');
const path = require('path');

const IDENT_BACKTICK_RE = /`([A-Za-z_$][\w$]*)(?:\(\))?`/g;
const FLAGS_FILE = 'dead-code-flags.json';

const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '');

function inertTargetMode(env = process.env) {
  const v = String(env.AGENT_MANAGER_DERIVED_INERT_TARGET || '').trim().toLowerCase();
  return v === 'off' || v === 'hold' ? v : 'retire';
}

function readFlags(pipelineDir) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(pipelineDir, 'queue', FLAGS_FILE), 'utf8'));
    const list = Array.isArray(d) ? d : (Array.isArray(d && d.flags) ? d.flags : []);
    return list.filter((f) => f && typeof f.symbol === 'string' && typeof f.definedIn === 'string' && Array.isArray(f.callSites));
  } catch { return []; }
}

const textOf = (task) => String((task && task.promptContext && typeof task.promptContext === 'object' && task.promptContext.rawText) || '');

// The symbol the finding is about: first backticked identifier in the title, else in the body. null when there is none.
function primarySymbol(task) {
  for (const text of [String((task && task.title) || ''), textOf(task)]) {
    const m = [...text.matchAll(IDENT_BACKTICK_RE)][0];
    if (m) return m[1];
  }
  return null;
}

// Does the task cite a file this flag's definedIn path points at? (suffix match either way; a bare `runStore.js` matches `a/b/runStore.js`.)
function citesFile(citedPaths, definedIn) {
  const d = norm(definedIn);
  return citedPaths.some((c) => {
    const p = norm(c);
    return d === p || d.endsWith(`/${p}`) || p.endsWith(`/${d}`);
  });
}

// -> { symbol, definedIn } or null: the primary symbol is flagged unreferenced in a cited file.
function findInertTarget(task, flags, citedPaths) {
  try {
    const symbol = primarySymbol(task);
    if (!symbol || !Array.isArray(flags) || !flags.length || !citedPaths.length) return null;
    const mine = flags.filter((f) => f.symbol === symbol && citesFile(citedPaths, f.definedIn));
    if (mine.length === 0) return null;
    // A same-named symbol in a cited file that IS referenced means the name is ambiguous: do not claim it is dead.
    if (mine.some((f) => f.callSites.length > 0)) return null;
    return { symbol, definedIn: mine[0].definedIn };
  } catch { return null; }
}

// The inverse, for re-admission: the flags now show a call site for this symbol in this file.
function nowReferenced(symbol, definedIn, flags) {
  try {
    return (flags || []).some((f) => f.symbol === symbol && norm(f.definedIn) === norm(definedIn) && f.callSites.length > 0);
  } catch { return false; }
}

// Index of GENUINE dead-code triage verdicts: Set of `${symbol}|${definedIn}`. Memoised on the done/ directory's mtime (the sweep runs every tick).
const _indexCache = new Map();
function genuineVerdictIndex(doneDir) {
  try {
    const mtime = fs.statSync(doneDir).mtimeMs;
    const hit = _indexCache.get(doneDir);
    if (hit && hit.mtime === mtime) return hit.index;
    const index = new Set();
    for (const f of fs.readdirSync(doneDir)) {
      if (!f.startsWith('deadcode-') || !f.endsWith('.json')) continue;
      let t;
      try { t = JSON.parse(fs.readFileSync(path.join(doneDir, f), 'utf8')); } catch { continue; }
      const pc = t && t.promptContext;
      if (!t || !pc || typeof pc.symbol !== 'string' || typeof pc.definedIn !== 'string') continue;
      if (t.source !== 'deadcode_triage' && t.source !== 'unused_export') continue;
      if (t.terminalDisposition === 'abandoned') continue;
      const resp = String(t.implementResponse || '');
      if (/^\s*###\s*AC-\d+\b/m.test(resp) && /^\s*Strength:\s*Strong\b/mi.test(resp)) index.add(`${pc.symbol}|${norm(pc.definedIn)}`);
    }
    _indexCache.set(doneDir, { mtime, index });
    return index;
  } catch { return new Set(); }
}

const hasGenuineVerdict = (index, target) => !!(index && target && index.has(`${target.symbol}|${norm(target.definedIn)}`));

// The reviewer-facing line for a task that reached review while carrying an inert-target stamp.
function formatInertTargetSection(it) {
  if (!it || typeof it.symbol !== 'string') return '';
  return [
    '--- Inert target (deterministic, advisory) ---',
    `The dead-code scanner lists \`${it.symbol}\` (defined in ${it.definedIn}) with NO call sites. This finding is about code nothing calls, so a fix to it changes no behaviour a user or test can reach.`,
    'Weigh whether the change is worth landing at all; if the right action is removing the dead code, say so rather than approving a fix to it.',
  ].join('\n');
}

// Replay summary over historical records: which tasks the rule WOULD have matched, and which of those turned out to be useful work (a task that was merged
// or applied is a FALSE POSITIVE for a rule that retires/holds). entries: [{ state, task }]; flags/genuine as above; citedPaths(task) -> string[].
const USEFUL_OUTCOMES = new Set(['merged', 'pending-merge', 'applied-direct']);
function summariseReplay(entries, flags, genuine, citedPaths) {
  const matches = [];
  let total = 0;
  for (const { state, task } of entries || []) {
    if (!task || task.source !== 'derived_task') continue;
    total += 1;
    const target = findInertTarget(task, flags, citedPaths(task));
    if (!target) continue;
    const outcome = task.terminalDisposition || task.status || state;
    matches.push({
      state, id: task.id, outcome, symbol: target.symbol, definedIn: target.definedIn,
      action: hasGenuineVerdict(genuine, target) ? 'retire' : 'hold', falsePositive: USEFUL_OUTCOMES.has(outcome),
    });
  }
  return { total, matches, falsePositives: matches.filter((m) => m.falsePositive) };
}

module.exports = {
  summariseReplay, USEFUL_OUTCOMES,
  inertTargetMode, readFlags, primarySymbol, findInertTarget, nowReferenced, genuineVerdictIndex, hasGenuineVerdict, formatInertTargetSection, FLAGS_FILE,
};
