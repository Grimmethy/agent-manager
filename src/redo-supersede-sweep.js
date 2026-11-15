'use strict';

// redo-supersede-sweep.js -- when a redo merges, record a discard on the branch it replaced.
//
// Why (2026-10-30, owner: "why isn't the task log recycled ... instead of ... leaving the NW branch in the pool?"): a redo filed for a needs-work branch carries
// promptContext.redoOf (the id of the task it replaces), but nothing read it, so after the redo merged the old branch stayed in Unmerged Branches as a needs-work
// card until a human discarded it (premium provenance, the C4 backfill and the GitHub toolset all merged with their predecessors still listed).
//
// This sweep reads every registered project's done/ tasks that have redoOf and are merged (terminalDisposition 'merged', set by the dashboard merge route), finds the
// card of the task they replaced, and records a DISCARD verdict on it through the dashboard's own verdict route. It only records: deleting the remote branch is the
// owner's Discard click. Why a sweep and not python/dashboard/branch_verdicts.py's deterministic checks: a chat/manual verdict for a head is final there (a
// deterministic one never replaces it) and deterministic verdicts are recomputed on every list build, so a recorded one would be cleared.
//
// Never touches: a card already discard, a card whose current verdict is merge (reported), the redo's own branch, a card of another project, a redo that is not merged.
// AGENT_MANAGER_REDO_SUPERSEDE=off|dry-run|on (default on: it records one reversible verdict). CLI: node redo-supersede-sweep.js [--dry-run]. One JSON line on stdout.
//
// ADR-0024 (queue-events journal, HUB0330): the sweep no longer lists and parses all of queue/done on every watchdog tick. Per project it drains the journal and examines
// only the redos a `branch_merged` event names. A FULL scan (the old behaviour) still runs on the first run and again every AGENT_MANAGER_EVENTS_RECONCILE_SECS (default
// 1800) as the safety net; a supersede that full reconcile scan records for a redo no event named is counted with recordCorrection (a producer forgot to emit). Position and
// scan time only advance after a clean live run (no errors, no retry-later, no card without a head sha, not dry-run), so unfinished work is always retried.
// AGENT_MANAGER_QUEUE_EVENTS=off restores the old full scan on every run exactly.

const fs = require('fs');
const path = require('path');
const { listProjects } = require('./chat-projects.js');
const { httpRequest, fetchRows } = require('./chat-branch-verdict.js');
const queueEvents = require('./queue-events.js');

function mode(env = process.env) {
  const v = String(env.AGENT_MANAGER_REDO_SUPERSEDE || 'on').toLowerCase();
  return v === 'off' || v === 'false' || v === '0' ? 'off' : v === 'dry-run' ? 'dry-run' : 'on';
}

// A task id and the same task seen through its hub branch ('decompose-' prefix) are the same thing.
const norm = (id) => String(id || '').replace(/^decompose-/, '');

// [{ id, redoOf, mergedAt, project }] for every merged redo in the project's done/ directory.
// One done/ task -> { id, redoOf, mergedAt, project }, or null when it is not a merged redo.
function redoFromTask(task, name, project) {
  const redoOf = task && task.promptContext && task.promptContext.redoOf;
  if (typeof redoOf !== 'string' || !redoOf.trim()) return null;
  if (task.terminalDisposition !== 'merged' || !task.mergedAt) return null;
  return { id: task.id || name.replace(/\.json$/, ''), redoOf: redoOf.trim(), mergedAt: task.mergedAt, project };
}

function mergedRedos(project, fsImpl = fs) {
  const dir = path.join(project.pipelineDir, 'queue', 'done');
  let names;
  try { names = fsImpl.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let task;
    try { task = JSON.parse(fsImpl.readFileSync(path.join(dir, name), 'utf8')); } catch { continue; }
    const redo = redoFromTask(task, name, project);
    if (redo) out.push(redo);
  }
  return out;
}

// The merged redos a branch_merged event names, read directly (done/<taskId>.json, and the id without its decompose- prefix): no directory listing.
function redosNamedByEvents(project, events, fsImpl = fs) {
  const dir = path.join(project.pipelineDir, 'queue', 'done');
  const ids = new Set();
  for (const e of events) if (e && e.type === 'branch_merged' && e.taskId) { ids.add(e.taskId); ids.add(norm(e.taskId)); }
  const out = [];
  const seen = new Set();
  for (const id of ids) {
    const name = `${id}.json`;
    let task;
    try { task = JSON.parse(fsImpl.readFileSync(path.join(dir, name), 'utf8')); } catch { continue; }
    const redo = redoFromTask(task, name, project);
    if (redo && !seen.has(redo.id)) { seen.add(redo.id); out.push(redo); }
  }
  return out;
}

const CONSUMER = 'redo-supersede';
const journalOn = (env) => String(env.AGENT_MANAGER_QUEUE_EVENTS || 'on').toLowerCase() !== 'off';
function reconcileMs(env) {
  const n = Number(env.AGENT_MANAGER_EVENTS_RECONCILE_SECS);
  return Number.isFinite(n) && n >= 0 ? n * 1000 : 30 * 60 * 1000;
}
const scanStatePath = (project) => path.join(project.pipelineDir, 'queue-events', 'redo-supersede.scan.json');
function readScanState(project, fsImpl) { try { return JSON.parse(fsImpl.readFileSync(scanStatePath(project), 'utf8')); } catch { return null; } }
function writeScanState(project, fsImpl, now) {
  try {
    fsImpl.mkdirSync(path.dirname(scanStatePath(project)), { recursive: true });
    fsImpl.writeFileSync(scanStatePath(project), JSON.stringify({ at: now }));
  } catch { /* best effort: the next run simply does a full scan again */ }
}

// -> { redos, fullScan, reconcile, announced:Set, finish(clean) } for one project.
function planProject(project, { journal, now, env, fsImpl }) {
  if (!journal) return { redos: mergedRedos(project, fsImpl), fullScan: true, reconcile: false, announced: new Set(), finish() {} };
  const drained = queueEvents.drain(project.pipelineDir, CONSUMER, { fs: fsImpl });
  const state = readScanState(project, fsImpl);
  const due = !state || !Number.isFinite(state.at) || now - state.at >= reconcileMs(env);
  const announced = new Set(drained.events.filter((e) => e.type === 'branch_merged' && e.taskId).flatMap((e) => [e.taskId, norm(e.taskId)]));
  const redos = due ? mergedRedos(project, fsImpl) : redosNamedByEvents(project, drained.events, fsImpl);
  return {
    redos, fullScan: due, reconcile: due && !!state, announced,
    finish(clean) {
      if (!clean) return;                                   // unfinished work: re-read the same events (and scan again) next run
      drained.commit();
      if (due) writeScanState(project, fsImpl, now);
    },
  };
}

function safeReal(p) { try { return fs.realpathSync(p); } catch { return path.resolve(String(p)); } }
const sameRepo = (row, project) => !!(row.project && row.project.repoRoot) && safeReal(row.project.repoRoot) === safeReal(project.repoRoot);
async function sweep({ projects, request = httpRequest, env = process.env, fsImpl = fs, log = (l) => console.error(l), now = Date.now() } = {}) {
  const m = mode(env);
  const summary = { mode: m, redos: 0, matched: 0, recorded: 0, wouldRecord: 0, skipped: {}, errors: 0, journal: { events: journalOn(env), fullScans: 0, eventRuns: 0, idle: 0, corrections: 0 } };
  if (m === 'off') return summary;
  const skip = (why) => { summary.skipped[why] = (summary.skipped[why] || 0) + 1; };
  const registry = projects || listProjects();
  const plans = registry.map((p) => ({ project: p, plan: planProject(p, { journal: summary.journal.events, now, env, fsImpl }) }));
  for (const { plan } of plans) {
    if (plan.fullScan) summary.journal.fullScans += 1; else if (plan.redos.length) summary.journal.eventRuns += 1; else summary.journal.idle += 1;
  }
  const redos = plans.flatMap(({ plan }) => plan.redos);
  summary.redos = redos.length;
  const finishAll = (clean) => { for (const { plan } of plans) plan.finish(clean && m === 'on'); };
  if (!redos.length) { finishAll(true); return summary; }
  const { rows, error } = await fetchRows(request);
  if (error) { summary.error = error; log(`[redo-supersede] ${error}`); return summary; }
  const recordedFor = new Set();
  for (const redo of redos) {
    const wanted = norm(redo.redoOf);
    const cards = rows.filter((r) => sameRepo(r, redo.project) && (norm(r.taskId) === wanted || (r.hub && norm(r.hub.id) === wanted)));
    for (const card of cards) {
      if (norm(card.taskId) === norm(redo.id) || (card.hub && norm(card.hub.id) === norm(redo.id))) { skip('own-branch'); continue; }
      summary.matched += 1;
      if (card.verdict === 'discard') { skip('already-discard'); continue; }
      if (card.verdict === 'merge') { skip('has-merge-verdict'); log(`[redo-supersede] ${card.branch}: kept, it carries a merge verdict although redo ${redo.id} merged`); continue; }
      if (!card.headSha) { skip('no-head-sha'); continue; }
      const reasons = [`Superseded automatically: the redo ${redo.id} (redoOf this task) merged ${redo.mergedAt}. Nothing here is left to land; discard to remove the branch.`];
      if (m === 'dry-run') { summary.wouldRecord += 1; log(`[redo-supersede] dry-run: would discard ${card.branch} (${redo.project.label})`); continue; }
      const url = `/api/git/branches/${encodeURIComponent(card.branch)}/verdict?project=${encodeURIComponent(redo.project.repoRoot)}`;
      let res;
      try { res = await request('POST', url, { verdict: 'discard', reasons, source: 'manual', sha: card.headSha }); } catch (e) { summary.errors += 1; log(`[redo-supersede] ${card.branch}: ${e.message}`); continue; }
      if (res.status === 200) { summary.recorded += 1; recordedFor.add(redo); log(`[redo-supersede] ${card.branch}: discard recorded (superseded by ${redo.id})`); }
      else if (res.status === 409) { skip('head-moved-retry-later'); }
      else { summary.errors += 1; log(`[redo-supersede] ${card.branch}: HTTP ${res.status}`); }
    }
  }
  // A reconcile pass that superseded something no event announced: the producer forgot to emit (counted, ADR-0024 rule 6).
  for (const { project, plan } of plans) {
    if (!plan.reconcile) continue;
    const missed = [...recordedFor].filter((r) => r.project === project && !plan.announced.has(r.id) && !plan.announced.has(norm(r.id))).length;
    if (missed) { try { queueEvents.recordCorrection(project.pipelineDir, CONSUMER, missed, { fs: fsImpl }); summary.journal.corrections += missed; } catch { /* the counter is best effort */ } }
  }
  const clean = summary.errors === 0 && !summary.skipped['head-moved-retry-later'] && !summary.skipped['no-head-sha'];
  finishAll(clean);
  return summary;
}

async function main() {
  if (process.argv.includes('--dry-run')) process.env.AGENT_MANAGER_REDO_SUPERSEDE = 'dry-run';
  try {
    process.stdout.write(`${JSON.stringify(await sweep())}\n`);
  } catch (e) {
    console.error(`[redo-supersede] ${e.message}`);
    process.stdout.write(`${JSON.stringify({ error: e.message })}\n`);
  }
}

module.exports = { sweep, mergedRedos, redosNamedByEvents, mode, norm };

if (require.main === module) main();
