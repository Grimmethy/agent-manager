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

const fs = require('fs');
const path = require('path');
const { listProjects } = require('./chat-projects.js');
const { httpRequest, fetchRows } = require('./chat-branch-verdict.js');

function mode(env = process.env) {
  const v = String(env.AGENT_MANAGER_REDO_SUPERSEDE || 'on').toLowerCase();
  return v === 'off' || v === 'false' || v === '0' ? 'off' : v === 'dry-run' ? 'dry-run' : 'on';
}

// A task id and the same task seen through its hub branch ('decompose-' prefix) are the same thing.
const norm = (id) => String(id || '').replace(/^decompose-/, '');

// [{ id, redoOf, mergedAt, project }] for every merged redo in the project's done/ directory.
function mergedRedos(project, fsImpl = fs) {
  const dir = path.join(project.pipelineDir, 'queue', 'done');
  let names;
  try { names = fsImpl.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let task;
    try { task = JSON.parse(fsImpl.readFileSync(path.join(dir, name), 'utf8')); } catch { continue; }
    const redoOf = task && task.promptContext && task.promptContext.redoOf;
    if (typeof redoOf !== 'string' || !redoOf.trim()) continue;
    if (task.terminalDisposition !== 'merged' || !task.mergedAt) continue;
    out.push({ id: task.id || name.replace(/\.json$/, ''), redoOf: redoOf.trim(), mergedAt: task.mergedAt, project });
  }
  return out;
}

function safeReal(p) { try { return fs.realpathSync(p); } catch { return path.resolve(String(p)); } }
const sameRepo = (row, project) => !!(row.project && row.project.repoRoot) && safeReal(row.project.repoRoot) === safeReal(project.repoRoot);
async function sweep({ projects, request = httpRequest, env = process.env, fsImpl = fs, log = (l) => console.error(l) } = {}) {
  const m = mode(env);
  const summary = { mode: m, redos: 0, matched: 0, recorded: 0, wouldRecord: 0, skipped: {}, errors: 0 };
  if (m === 'off') return summary;
  const skip = (why) => { summary.skipped[why] = (summary.skipped[why] || 0) + 1; };
  const registry = projects || listProjects();
  const redos = registry.flatMap((p) => mergedRedos(p, fsImpl));
  summary.redos = redos.length;
  if (!redos.length) return summary;
  const { rows, error } = await fetchRows(request);
  if (error) { summary.error = error; log(`[redo-supersede] ${error}`); return summary; }
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
      if (res.status === 200) { summary.recorded += 1; log(`[redo-supersede] ${card.branch}: discard recorded (superseded by ${redo.id})`); }
      else if (res.status === 409) { skip('head-moved-retry-later'); }
      else { summary.errors += 1; log(`[redo-supersede] ${card.branch}: HTTP ${res.status}`); }
    }
  }
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

module.exports = { sweep, mergedRedos, mode, norm };

if (require.main === module) main();
