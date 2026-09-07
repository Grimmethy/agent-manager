'use strict';

// Backfills promptContext.deterministicApply onto EXISTING file-decompose script-extract
// move child tasks that don't have it yet (2026-09-07, Grimmethy: "if we could find a way
// to make more of this process deterministic so that the model only has to call a
// function rather than do a whole lot of work").
//
// The deterministic path itself already exists (local-draft.js's
// tryDeterministicScriptExtractEdit / review-task.js's matching auto-approve gate, "Ghost
// in the Machine", 2026-09-06) and file-decompose-to-hub.js's validatePlan() already
// stamps NEW hub children with it at creation time when every named symbol resolves
// unambiguously via script-extract.js's V8-parser oracle. The gap this file closes: a
// child task minted BEFORE that check happened to resolve cleanly (or whose sibling moves
// have since landed, which can only ever make an UNRELATED move's own symbol set easier to
// find, never harder) has no way to pick the flag up later -- it just keeps burning full
// plan+implement LLM passes on a task shape that a cheap, deterministic, already-proven
// check would resolve for free.
//
// Root-caused live for the exact task that prompted this (analytics-and-discovery.js
// move, blocked "Plan pass degenerate: truncated" after 6 draft cycles / ~3 hours): its
// 29 symbols ALL resolve cleanly against the current repo right now via
// staticCheckScriptExtractMove, confirmed by calling it directly -- it was simply never
// stamped, because when it was created its check result wasn't recorded onto the CHILD
// task's own JSON. Re-running the whole hub's validatePlan() would incorrectly flag this
// as broken (two sibling moves already landed and physically removed THEIR symbols from
// the source file, so validatePlan()'s own hardProblems list is stale for the whole
// request) -- this module checks each eligible child's OWN move in isolation instead,
// which is exactly what actually matters for that one task's own apply path.
//
// Only ever ADDS the flag; never removes one, never touches a task otherwise. If the
// per-move check no longer resolves cleanly (a symbol got renamed, moved by hand, etc)
// the task is left exactly as it already is -- the normal LLM plan/implement path, same
// as today. Idempotent: a task that already has promptContext.deterministicApply is
// skipped outright, so re-running this sweep costs nothing once a task is stamped.
//
// Kill switch: AGENT_MANAGER_DECOMPOSE_DETERMINISM_BACKFILL=false.

const fs = require('fs');
const path = require('path');
const { getConfig } = require('./config.js');
const { writeJsonAtomicSync } = require('./atomic-write.js');
const { appendHistoryEvent } = require('./task-history.js');
const { staticCheckScriptExtractMove } = require('./file-decompose-to-hub.js');

const SCAN_DIRS = ['pending', 'needs-clarification', 'blocked'];
const HUB_PREFIX = 'file-decompose-hub-';

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'x';
}

function listTaskFiles(pipelineDir, dirNames) {
  const out = [];
  for (const d of dirNames) {
    const dir = path.join(pipelineDir, 'queue', d);
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const f of names) {
      if (f.endsWith('.json')) out.push(path.join(dir, f));
    }
  }
  return out;
}

// Eligible: a file-decompose move child (not the coordinator hub itself, not the wiring
// task -- neither carries promptContext.moveIndex) that hasn't been stamped yet.
function isEligible(task) {
  const ctx = task.promptContext;
  if (!ctx || task.promptContext.deterministicApply) return false;
  if (typeof ctx.decomposedFrom !== 'string' || !ctx.decomposedFrom.startsWith(HUB_PREFIX)) return false;
  if (!Number.isInteger(ctx.moveIndex) || typeof ctx.newFile !== 'string') return false;
  return true;
}

function loadRequestForHub(requestsDir, hubDecomposedFrom) {
  const planSlug = hubDecomposedFrom.slice(HUB_PREFIX.length);
  let names;
  try { names = fs.readdirSync(requestsDir); } catch { return null; }
  for (const f of names) {
    if (!f.endsWith('.json')) continue;
    let request;
    try { request = JSON.parse(fs.readFileSync(path.join(requestsDir, f), 'utf8')); } catch { continue; }
    if (request && slugify(request.id) === planSlug) return request;
  }
  return null;
}

function backfillDeterministicApply({ pipelineDir, repoRoot, now = Date.now() } = {}) {
  const summary = { checked: 0, stamped: 0, notEligibleYet: 0, errors: 0, skipped: [] };
  if (process.env.AGENT_MANAGER_DECOMPOSE_DETERMINISM_BACKFILL === 'false') return summary;
  let resolvedRepoRoot = repoRoot;
  if (!resolvedRepoRoot) {
    try { ({ repoRoot: resolvedRepoRoot } = getConfig()); } catch (err) {
      console.error(`[decompose-move-determinism-backfill] getConfig() failed; falling back to pipelineDir as repoRoot: ${err.message}`, err.stack);
      resolvedRepoRoot = pipelineDir;
    }
  }
  const requestsDir = path.join(pipelineDir, 'queue', 'file-decompose-requests');

  for (const taskFile of listTaskFiles(pipelineDir, SCAN_DIRS)) {
    let task;
    try { task = JSON.parse(fs.readFileSync(taskFile, 'utf8')); } catch { continue; }
    if (!isEligible(task)) continue;
    summary.checked += 1;

    const ctx = task.promptContext;
    const request = loadRequestForHub(requestsDir, ctx.decomposedFrom);
    if (!request || !Array.isArray(request.moves) || !request.moves[ctx.moveIndex]) {
      summary.skipped.push(`${task.id}: no matching file-decompose-request found for ${ctx.decomposedFrom} move ${ctx.moveIndex}`);
      continue;
    }
    const move = request.moves[ctx.moveIndex];
    if (move.kind !== 'script-extract' || !Array.isArray(move.symbols) || move.symbols.length === 0) {
      summary.skipped.push(`${task.id}: move ${ctx.moveIndex} is not an eligible script-extract move`);
      continue;
    }

    try {
      const check = staticCheckScriptExtractMove(resolvedRepoRoot, request.sourceFile, move.symbols);
      if (!check || !check.resolvable) {
        summary.skipped.push(`${task.id}: source file not checkable right now (${request.sourceFile})`);
        continue;
      }
      if (!check.ok) {
        summary.notEligibleYet += 1;
        summary.skipped.push(`${task.id}: not deterministic-eligible yet -- ${check.missing.join(', ')}`);
        continue;
      }
      task.promptContext.deterministicApply = 'script-extract';
      task.promptContext.sourceFile = request.sourceFile;
      task.promptContext.symbols = move.symbols;
      appendHistoryEvent(task, 'advisory',
        `decompose-move-determinism-backfill: stamped deterministicApply (all ${move.symbols.length} symbol(s) resolve cleanly) -- future draft attempts skip the LLM plan/implement pass entirely`);
      writeJsonAtomicSync(taskFile, task);
      summary.stamped += 1;
    } catch (e) {
      console.error(`[decompose-move-determinism-backfill] ${task.id}: ${e && e.message}`, e && e.stack);
      summary.errors += 1;
    }
  }
  return summary;
}

module.exports = { backfillDeterministicApply, isEligible, loadRequestForHub };

if (require.main === module) {
  const { pipelineDir, repoRoot } = getConfig();
  const s = backfillDeterministicApply({ pipelineDir, repoRoot });
  const parts = [`checked=${s.checked}`, `stamped=${s.stamped}`, `notEligibleYet=${s.notEligibleYet}`, `errors=${s.errors}`];
  if (s.skipped.length) parts.push(`skipped=[${s.skipped.join('; ')}]`);
  console.log(`decompose-move-determinism-backfill: ${parts.join(' ')}`);
  process.exit(0);
}
