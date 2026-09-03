'use strict';

// decompose-loop-autoroute.js (2026-09-03, Grimmethy: "we need to figure out a way to get
// hub 1 to decompose itself ... make the system do the work without stepping in").
//
// adhoc-staleness-flag.js stamps `stalenessFlag.reason = 'decompose-loop'` on a task whose
// every draft attempt answered "decompose" but never produced usable pieces -- then leaves
// it frozen in needs-clarification/ for a human. When that task's target is an OVERSIZED
// FILE (the real reason the local model can't split it -- see file-decompose-plan-pass.js),
// a human is not required: this watchdog sweep
//   1. authors a moves[] plan via runFileDecomposePlanPass (deterministic symbol
//      extraction -> the model only groups names)
//   2. writes it as queue/file-decompose-requests/<id>.json -- file-decompose-to-hub.js
//      turns it into a stacked hub the model CAN execute
//   3. re-points the stuck task at that hub: `dependsOn: [<hubId>]`, back to pending/, so
//      it re-drafts once the file is actually smaller
//   4. if the stuck task is a coordinator child, swaps it for the decompose hub in the
//      parent's checklist and rewrites dependent siblings' dependsOn
//
// A decompose-loop task whose target ISN'T an oversized file is left for the human (the
// product_spec route is a separate follow-up -- product_spec_outline currently truncates
// on large requests, so routing into it would just move the jam).
//
// Kill switch: AGENT_MANAGER_DECOMPOSE_LOOP_AUTOROUTE=false. Bounded: at most one plan
// pass per task per MIN_RETRY_MS, tracked on the task as `autorouteAttempts`.

const fs = require('fs');
const path = require('path');
const { getConfig } = require('./config.js');
const { appendHistoryEvent } = require('./task-history.js');
const { runFileDecomposePlanPass } = require('./file-decompose-plan-pass.js');
const { sweep: fileDecomposeToHubSweep } = require('./file-decompose-to-hub.js');

const SCAN_DIRS = ['blocked', 'needs-clarification'];
const MIN_RETRY_MS = 6 * 60 * 60 * 1000; // don't re-attempt the plan pass more often than this
const MAX_ATTEMPTS = 3;

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'x';
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// The set of file paths currently flagged too-long (queue/file-length-flags.json, written
// by agent-manager-hygiene's file-length-scan.js).
function oversizedFiles(pipelineDir) {
  const data = readJson(path.join(pipelineDir, 'queue', 'file-length-flags.json'));
  const out = new Set();
  for (const f of (data && data.findings) || []) {
    if (f && f.file) out.add(f.file);
  }
  return out;
}

// The oversized file this task is about, or null. Matches the longest flagged path that
// appears verbatim in the task's request text / title (longest so a/b/app.py wins over
// app.py if both were flagged).
function targetOversizedFile(task, oversized) {
  const hay = `${task.title || ''}\n${(task.promptContext && task.promptContext.rawText) || ''}`;
  let best = null;
  for (const f of oversized) {
    if (hay.includes(f) && (!best || f.length > best.length)) best = f;
  }
  return best;
}

function attemptGate(task, now) {
  const a = task.autorouteAttempts;
  if (!a) return true;
  if ((a.count || 0) >= MAX_ATTEMPTS) return false;
  const last = Date.parse(a.lastAt || '');
  return !Number.isFinite(last) || now - last >= MIN_RETRY_MS;
}

function bumpAttempt(task, now, note) {
  const a = task.autorouteAttempts || { count: 0 };
  task.autorouteAttempts = { count: (a.count || 0) + 1, lastAt: new Date(now).toISOString(), lastNote: note };
}

// Re-point a coordinator parent + dependent siblings from the stuck child to the new hub.
function rewireCoordinatorParent(pipelineDir, childId, hubId) {
  const coordDir = path.join(pipelineDir, 'queue', 'coordinating');
  let names;
  try { names = fs.readdirSync(coordDir).filter((n) => n.endsWith('.json')); } catch { return null; }
  for (const name of names) {
    const file = path.join(coordDir, name);
    const parent = readJson(file);
    if (!parent || !Array.isArray(parent.subTasks)) continue;
    const idx = parent.subTasks.findIndex((st) => st && st.id === childId);
    if (idx === -1) continue;
    parent.subTasks[idx] = { id: hubId, title: `${parent.subTasks[idx].title || childId} (re-decomposed as a file-decompose hub)`, status: 'in-progress' };
    // sibling dependsOn edges live on the child task files, not the parent -- rewrite those
    for (const st of parent.subTasks) {
      if (!st || !st.id || st.id === hubId) continue;
      for (const d of SCAN_DIRS.concat(['pending', 'adhoc', 'approved', 'review'])) {
        const sf = path.join(pipelineDir, 'queue', d, `${st.id}.json`);
        const sib = readJson(sf);
        if (sib && Array.isArray(sib.dependsOn) && sib.dependsOn.includes(childId)) {
          sib.dependsOn = sib.dependsOn.map((x) => (x === childId ? hubId : x));
          try { fs.writeFileSync(sf, JSON.stringify(sib, null, 2)); } catch { /* best-effort */ }
        }
      }
    }
    appendHistoryEvent(parent, 'advisory', `child ${childId} re-decomposed into file-decompose hub ${hubId} (decompose-loop autoroute)`);
    if (parent.coordinatorBlocked) { delete parent.coordinatorBlocked; delete parent.blockedReason; }
    try { fs.writeFileSync(file, JSON.stringify(parent, null, 2)); } catch { /* best-effort */ }
    return parent.id;
  }
  return null;
}

async function sweep({ pipelineDir, repoRoot, call, now = Date.now() } = {}) {
  const summary = { scanned: 0, routed: 0, planFailed: 0, skipped: 0, errors: 0 };
  if (process.env.AGENT_MANAGER_DECOMPOSE_LOOP_AUTOROUTE === 'false') return summary;

  let resolvedRepoRoot = repoRoot;
  if (!resolvedRepoRoot) { try { ({ repoRoot: resolvedRepoRoot } = getConfig()); } catch { resolvedRepoRoot = null; } }

  const oversized = oversizedFiles(pipelineDir);
  if (oversized.size === 0) return summary;

  const reqDir = path.join(pipelineDir, 'queue', 'file-decompose-requests');
  const pendingDir = path.join(pipelineDir, 'queue', 'pending');

  for (const dir of SCAN_DIRS) {
    let names;
    try { names = fs.readdirSync(path.join(pipelineDir, 'queue', dir)).filter((n) => n.endsWith('.json')); } catch { continue; }
    for (const name of names) {
      const file = path.join(pipelineDir, 'queue', dir, name);
      const task = readJson(file);
      if (!task || !task.id) continue;
      const flag = task.stalenessFlag;
      if (!flag || flag.reason !== 'decompose-loop') continue;
      if (task.reroutedTo) { summary.skipped += 1; continue; }
      summary.scanned += 1;

      const targetFile = targetOversizedFile(task, oversized);
      if (!targetFile) { summary.skipped += 1; continue; } // not a file-size problem -> human keeps the flag
      if (!attemptGate(task, now)) { summary.skipped += 1; continue; }

      const requestId = `autodecomp-${slugify(task.id)}`.slice(0, 60);
      const hubId = `file-decompose-hub-${requestId}`;
      // Already routed on a prior tick (request or hub exists) -- just wire this task to it.
      const alreadyFiled = fs.existsSync(path.join(reqDir, `${requestId}.json`))
        || fs.existsSync(path.join(pipelineDir, 'queue', 'coordinating', `${hubId}.json`));

      try {
        if (!alreadyFiled) {
          const plan = await runFileDecomposePlanPass(targetFile, { repoRoot: resolvedRepoRoot, call, requestId });
          if (!plan || !plan.moves || plan.moves.length < 2) {
            bumpAttempt(task, now, `plan pass produced no usable split for ${targetFile}`);
            appendHistoryEvent(task, 'advisory', `decompose-loop autoroute: could not auto-author a split for ${targetFile} (attempt ${task.autorouteAttempts.count}/${MAX_ATTEMPTS})`);
            try { fs.writeFileSync(file, JSON.stringify(task, null, 2)); } catch { /* best-effort */ }
            summary.planFailed += 1;
            continue;
          }
          fs.mkdirSync(reqDir, { recursive: true });
          fs.writeFileSync(path.join(reqDir, `${requestId}.json`), `${JSON.stringify({
            ...plan,
            note: `Auto-authored by decompose-loop-autoroute for stuck task ${task.id}. ${plan.planPassNote || ''}`,
          }, null, 2)}\n`);
        }

        // Materialise the hub NOW, in this same tick, before re-pointing the parent at it.
        // Otherwise coordinator-sweep runs first on the next tick and classifies the
        // not-yet-created `${hubId}` as `gone` -- which counts as terminal-good and can
        // prematurely complete the parent (caught live 2026-09-03, a 1-tick window).
        if (!fs.existsSync(path.join(pipelineDir, 'queue', 'coordinating', `${hubId}.json`))) {
          try {
            fileDecomposeToHubSweep({ pipelineDir, repoRoot: resolvedRepoRoot, now });
          } catch (e) {
            console.error(`[decompose-loop-autoroute] inline hub materialise failed for ${requestId}: ${e && e.message}`);
          }
        }

        // Re-point the stuck task at the decompose hub and send it back to pending so it
        // re-drafts once the file is split. isDependencySatisfied() gates it until the hub
        // is stamped merged.
        const rerouted = {
          id: task.id, domain: task.domain, source: task.source, title: task.title,
          promptContext: task.promptContext,
          dependsOn: [hubId],
          reroutedTo: { kind: 'file-decompose', requestId, hubId, targetFile, at: new Date(now).toISOString() },
          status: 'pending', createdAt: new Date(now).toISOString(),
          history: [...(task.history || []), {
            stage: 'pending',
            at: new Date(now).toISOString(),
            detail: `decompose-loop autoroute: ${targetFile} is being split (${hubId}); this task waits for that, then re-drafts against the smaller file`,
          }],
        };
        const parentId = rewireCoordinatorParent(pipelineDir, task.id, hubId);
        fs.mkdirSync(pendingDir, { recursive: true });
        fs.writeFileSync(path.join(pendingDir, `${task.id}.json`), `${JSON.stringify(rerouted, null, 2)}\n`);
        fs.unlinkSync(file);
        summary.routed += 1;
        if (parentId) summary.rewiredParents = (summary.rewiredParents || 0) + 1;
      } catch (e) {
        console.error(`[decompose-loop-autoroute] ${task.id}: ${e && e.message}`);
        summary.errors += 1;
      }
    }
  }
  return summary;
}

module.exports = { sweep, targetOversizedFile, oversizedFiles, rewireCoordinatorParent };

if (require.main === module) {
  const { pipelineDir, repoRoot } = getConfig();
  let call;
  try { ({ call } = require('./local-client.js')); } catch { /* plan pass just won't run */ }
  sweep({ pipelineDir, repoRoot, call })
    .then((s) => { console.log(`decompose-loop-autoroute: ${JSON.stringify(s)}`); process.exit(0); })
    .catch((e) => { console.error('[decompose-loop-autoroute]', (e && e.stack) || e); process.exit(0); });
}
