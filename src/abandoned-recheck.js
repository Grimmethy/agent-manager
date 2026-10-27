'use strict';

// abandoned-recheck.js -- `abandoned` ("branch gone, work lost -- the one an audit must never miss") is a STABLE terminal stage, so a WRONG one never
// healed (task-log-reconcile.js's own header says so). Two ways it goes wrong, both seen 2026-10-07/08 on TaxHarvest when a requeue deleted a hub's
// shared branch:
//   * the "lost" work was already on <main> (HUB0007-01: 68 of 68 distinctive lines present) -> correct it, via the same resolveDisposition chain with
//     `abandoned` allowed to reopen (it then says superseded / merged / pending-merge);
//   * the work really was lost to another task's requeue (HUB0018-01) -> restore it (shared-branch-restore.js).
// A bounded, throttled pass run at the end of each reconcile sweep. State (queue/abandoned-recheck-state.json): the abandoned ids, when each was last
// checked, and the mtime watermark of the last scan of done/ -- the first run parses every done record once, later runs only files touched since.

const fs = require('fs');
const path = require('path');
const { resolveDisposition, realGit } = require('./task-disposition.js');
const { appendHistoryEvent } = require('./task-history.js');
const { shouldRestore, restoreRecord, restoreEnabled } = require('./shared-branch-restore.js');

const TTL_MS = 6 * 3600 * 1000;
const LIMIT = 25;
const statePath = (pipelineDir) => path.join(pipelineDir, 'queue', 'abandoned-recheck-state.json');
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

function loadState(pipelineDir) {
  const s = readJson(statePath(pipelineDir)) || {};
  return { scannedAtMs: Number(s.scannedAtMs) || 0, abandoned: Array.isArray(s.abandoned) ? s.abandoned : [], checked: s.checked && typeof s.checked === 'object' ? s.checked : {} };
}
function saveState(pipelineDir, st) {
  try { fs.writeFileSync(statePath(pipelineDir), JSON.stringify({ updatedAt: new Date().toISOString(), scannedAtMs: st.scannedAtMs, abandoned: [...new Set(st.abandoned)].sort(), checked: st.checked }, null, 2)); } catch { /* best-effort */ }
}

// Finds abandoned done records touched since the last scan (all of them on the first run).
function scanForAbandoned(doneDir, st) {
  const since = st.scannedAtMs;
  const now = Date.now();
  let names = [];
  try { names = fs.readdirSync(doneDir).filter((f) => f.endsWith('.json')); } catch { return; }
  const known = new Set(st.abandoned);
  for (const f of names) {
    const id = f.slice(0, -5);
    let mtime = 0;
    try { mtime = fs.statSync(path.join(doneDir, f)).mtimeMs; } catch { continue; }
    if (since && mtime < since && !known.has(id)) continue;
    const rec = readJson(path.join(doneDir, f));
    if (rec && rec.terminalDisposition === 'abandoned') known.add(id);
    else known.delete(id);
  }
  st.abandoned = [...known];
  st.scannedAtMs = now - 60000; // a minute of overlap: a write during the scan is seen next time
}

function recheckAbandoned({ pipelineDir, repoRoot, ctx, git = realGit, now = Date.now(), ttlMs = TTL_MS, limit = LIMIT, dryRun = false, env = process.env }) {
  const out = { rechecked: 0, corrected: [], restored: [], errors: 0 };
  if (!pipelineDir || !repoRoot || !ctx) return out;
  if (String(env.AGENT_MANAGER_ABANDONED_RECHECK || '').trim().toLowerCase() === 'false') return out;
  const doneDir = path.join(pipelineDir, 'queue', 'done');
  const st = loadState(pipelineDir);
  scanForAbandoned(doneDir, st);
  const due = st.abandoned.filter((id) => !st.checked[id] || now - Date.parse(st.checked[id]) >= ttlMs)
    .sort((a, b) => (Date.parse(st.checked[a]) || 0) - (Date.parse(st.checked[b]) || 0)).slice(0, limit);
  for (const id of due) {
    const file = path.join(doneDir, `${id}.json`);
    const record = readJson(file);
    if (!record || record.terminalDisposition !== 'abandoned') { st.abandoned = st.abandoned.filter((x) => x !== id); continue; }
    try {
      out.rechecked += 1;
      const outcome = resolveDisposition(record, { repoRoot, ctx, git, allowReopenFrom: new Set(['abandoned']), pipelineDir });
      if (outcome && outcome.stage !== 'abandoned') {
        out.corrected.push({ id, from: 'abandoned', to: outcome.stage });
        if (!dryRun) {
          appendHistoryEvent(record, outcome.stage, `abandoned-recheck: ${outcome.detail}`);
          record.terminalDisposition = outcome.stage;
          fs.writeFileSync(file, JSON.stringify(record, null, 2));
        }
        st.abandoned = st.abandoned.filter((x) => x !== id);
        continue;
      }
      if (restoreEnabled(env)) {
        const decision = shouldRestore(record, { pipelineDir, repoRoot, mainBranch: ctx.mainBranch, git });
        if (decision.restore) {
          if (dryRun) { out.restored.push({ id, branch: decision.branch, removedBy: decision.removedBy }); }
          else if (restoreRecord(record, decision, { pipelineDir, doneFile: file })) {
            out.restored.push({ id, branch: decision.branch, removedBy: decision.removedBy });
            st.abandoned = st.abandoned.filter((x) => x !== id);
            continue;
          }
        }
      }
      st.checked[id] = new Date(now).toISOString();
    } catch (e) {
      out.errors += 1;
      console.error(`abandoned-recheck: ${id}: ${e.message}`);
    }
  }
  if (!dryRun) saveState(pipelineDir, st);
  return out;
}

module.exports = { recheckAbandoned, scanForAbandoned, loadState, TTL_MS };
