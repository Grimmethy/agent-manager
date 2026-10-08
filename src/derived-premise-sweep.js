'use strict';

// derived-premise-sweep.js -- a watchdog one-shot that retires derived_task findings which are deterministically dead, before a lane spends a draft
// on them (design and evidence: derived-gate.js). No model call. Two rules, both auto-retire (archive as 'abandoned', with the reason recorded):
//   raised-by-abandoned-task  the task that raised the finding (promptContext.derivedFrom.taskId) was itself retired/abandoned. States: derived
//                             (unclaimed), pending, adhoc, needs-clarification, blocked. NEVER a task a lane holds (drafting/review/approved).
//   all-cited-files-missing   every file the finding cites is missing from the working tree, origin/<main> AND (skipped when stacked) its branch.
//                             States: derived, pending, adhoc only (a task already worked may cite files legitimately gone).
// Never retires a human-prioritised task (premiumPriority / humanQueued / pinnedWorker) or an inert leftover origin record in derived/.
// A third rule, target-unreferenced (lib/inert-target.js): the finding is about a symbol the dead-code scanner lists with NO call sites. When the dead-code
// triage reached a GENUINE verdict for that symbol it auto-retires; without one the task is stamped `inertTarget` and HELD (derived/ only; capped like any hold),
// and a later scan that finds a caller releases/restores it. AGENT_MANAGER_DERIVED_INERT_TARGET=off|hold|retire (default retire).
// It also REPORTS which derived tasks are currently held by an overlapping open task (the hold itself is in task-sources.js, via derived-gate.js).
// Kill switch: AGENT_MANAGER_DERIVED_PREMISE_SWEEP=false. CLI: node derived-premise-sweep.js [--dry-run]

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const gate = require('./derived-gate.js');
const inertTarget = require('./lib/inert-target.js');

const CASCADE_STATES = ['derived', 'pending', 'adhoc', 'needs-clarification', 'blocked'];
const PREMISE_STATES = ['derived', 'pending', 'adhoc'];
const FETCH_TTL_MS = 60_000;

function writeJson(p, data) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(data, null, 2)); }

// Best-effort, rate-limited: a stale origin/<main> would make a brand-new file look "missing", so refresh it (at most once a minute) first.
function refreshMain(repoRoot, mainBranch, markerPath, now) {
  try {
    const last = fs.existsSync(markerPath) ? fs.statSync(markerPath).mtimeMs : 0;
    if (now - last < FETCH_TTL_MS) return;
    execFileSync('git', ['fetch', '-q', 'origin', mainBranch], { cwd: repoRoot, stdio: 'ignore', timeout: 30_000 });
    fs.writeFileSync(markerPath, String(now));
  } catch { /* offline / no origin: the check then uses what is already fetched, and the working tree */ }
}

function retire({ queueDir, task, filePath, rule, detail, nowIso, brainDumpPath, dryRun, extra = {} }) {
  const destDir = path.join(queueDir, 'done', '_archived_no_action');
  const dest = path.join(destDir, path.basename(filePath));
  if (fs.existsSync(dest)) return false; // an archived copy already exists: leave both alone
  if (dryRun) return true;
  task.history = Array.isArray(task.history) ? task.history : [];
  task.history.push({ stage: 'abandoned', at: nowIso, detail: `auto-retired (${rule}): ${detail}` });
  if (!task.terminalDisposition) task.terminalDisposition = 'abandoned';
  task.autoRetired = { rule, detail, at: nowIso, ...extra };
  writeJson(dest, task);
  fs.unlinkSync(filePath);
  const entryId = task.promptContext && task.promptContext.brainDumpEntryId;
  if (entryId && brainDumpPath) {
    try {
      require('./apply-group-a-brain-dump.js').closeBrainDumpEntryResolved({ brainDumpPath, brainDumpEntryId: entryId, note: `auto-retired before drafting (${rule}): ${detail}` });
    } catch { /* the entry stays as it was; the task is archived either way */ }
  }
  return true;
}

// Paired re-admission: a task retired by target-unreferenced comes back (once) to derived/ when the scanner now finds a caller for its symbol.
function readmitInertTargets({ queueDir, flags, nowIso, dryRun }) {
  const restored = [];
  const archDir = path.join(queueDir, 'done', '_archived_no_action');
  for (const id of gate.names(archDir)) {
    const filePath = path.join(archDir, `${id}.json`);
    const task = gate.readJson(filePath);
    const ar = task && task.autoRetired;
    if (!ar || ar.rule !== 'target-unreferenced' || task.inertTargetReadmitted || !ar.symbol || !ar.definedIn) continue;
    if (!inertTarget.nowReferenced(ar.symbol, ar.definedIn, flags)) continue;
    const dest = path.join(queueDir, 'derived', `${id}.json`);
    if (fs.existsSync(dest)) continue;
    restored.push(task.id || id);
    if (dryRun) continue;
    task.history = Array.isArray(task.history) ? task.history : [];
    task.history.push({ stage: 'readmitted', at: nowIso, detail: `restored: the dead-code scanner now finds a caller for ${ar.symbol} (${ar.definedIn}), so the finding is no longer about unreachable code` });
    delete task.autoRetired;
    delete task.terminalDisposition;
    task.inertTargetReadmitted = true;
    writeJson(dest, task);
    fs.unlinkSync(filePath);
  }
  return restored;
}

// existsOnDisk / existsAtRef / fetch are injectable so the tests need no real repo or network.
function sweepDerivedPremise({ pipelineDir, repoRoot, mainBranch = 'main', extraRoots = [], brainDumpPath = null, now = Date.now(), dryRun = false, existsOnDisk, existsAtRef, fetch = true } = {}) {
  const summary = { checked: 0, archived: [], held: [], skipped: 0, inertHeld: [], inertReleased: [], inertReadmitted: [] };
  if (!gate.sweepEnabled() || !pipelineDir) return summary;
  const queueDir = path.join(pipelineDir, 'queue');
  const nowIso = new Date(now).toISOString();
  if (fetch && repoRoot) refreshMain(repoRoot, mainBranch, path.join(queueDir, '.derived-premise-fetch'), now);
  const elsewhere = gate.otherIds(queueDir);
  const index = gate.openTaskIndex(pipelineDir);
  const inertMode = inertTarget.inertTargetMode();
  const flags = inertMode === 'off' ? [] : inertTarget.readFlags(pipelineDir);
  const genuine = inertMode === 'retire' ? inertTarget.genuineVerdictIndex(path.join(queueDir, 'done')) : null;
  if (inertMode !== 'off' && flags.length) summary.inertReadmitted = readmitInertTargets({ queueDir, flags, nowIso, dryRun });

  for (const state of CASCADE_STATES) {
    const dir = path.join(queueDir, state);
    for (const id of gate.names(dir)) {
      const filePath = path.join(dir, `${id}.json`);
      const task = gate.readJson(filePath);
      if (!task || typeof task !== 'object' || task.source !== 'derived_task') continue;
      if (state === 'derived' && elsewhere.has(id)) { summary.skipped += 1; continue; } // inert leftover origin record
      if (task.premiumPriority || task.humanQueued || task.pinnedWorker) { summary.skipped += 1; continue; }
      summary.checked += 1;

      const raiser = gate.raisedByAbandoned(task, pipelineDir);
      if (raiser) {
        if (retire({ queueDir, task, filePath, rule: 'raised-by-abandoned-task', detail: `it was raised while working ${raiser}, which was abandoned`, nowIso, brainDumpPath, dryRun })) {
          summary.archived.push({ id: task.id || id, rule: 'raised-by-abandoned-task', from: state });
        }
        continue;
      }
      if (PREMISE_STATES.includes(state) && !(task.stacked && task.stacked.branch)) {
        const p = gate.premiseGone(task, { repoRoot, mainBranch, extraRoots, existsOnDisk, existsAtRef });
        if (p.gone) {
          if (retire({ queueDir, task, filePath, rule: 'all-cited-files-missing', detail: p.evidence[0], nowIso, brainDumpPath, dryRun })) {
            summary.archived.push({ id: task.id || id, rule: 'all-cited-files-missing', from: state });
          }
          continue;
        }
      }
      if (inertMode !== 'off' && PREMISE_STATES.includes(state) && !(task.stacked && task.stacked.branch)) {
        const target = inertTarget.findInertTarget(task, flags, gate.citedPaths(task));
        if (target) {
          if (inertMode === 'retire' && inertTarget.hasGenuineVerdict(genuine, target)) {
            const detail = `its target ${target.symbol} (${target.definedIn}) has no call sites per the dead-code scanner and the dead-code triage judged it GENUINE dead code`;
            if (retire({ queueDir, task, filePath, rule: 'target-unreferenced', detail, nowIso, brainDumpPath, dryRun, extra: { symbol: target.symbol, definedIn: target.definedIn } })) {
              summary.archived.push({ id: task.id || id, rule: 'target-unreferenced', from: state });
            }
            continue;
          }
          if (!task.inertTarget) {
            summary.inertHeld.push({ id: task.id || id, symbol: target.symbol, from: state });
            if (!dryRun) {
              task.inertTarget = { symbol: target.symbol, definedIn: target.definedIn, at: nowIso, held: state === 'derived' };
              task.history = Array.isArray(task.history) ? task.history : [];
              task.history.push({ stage: 'advisory', at: nowIso, detail: `target ${target.symbol} (${target.definedIn}) has no call sites per the dead-code scanner; ${state === 'derived' ? 'held back from drafting (capped) ' : ''}no GENUINE triage verdict yet, so not retired` });
              writeJson(filePath, task);
            }
          }
        } else if (task.inertTarget && inertTarget.nowReferenced(task.inertTarget.symbol, task.inertTarget.definedIn, flags)) {
          summary.inertReleased.push({ id: task.id || id, symbol: task.inertTarget.symbol });
          if (!dryRun) {
            task.history = Array.isArray(task.history) ? task.history : [];
            task.history.push({ stage: 'advisory', at: nowIso, detail: `released: the dead-code scanner now finds a caller for ${task.inertTarget.symbol}` });
            delete task.inertTarget;
            writeJson(filePath, task);
          }
        }
      }
      if (state === 'derived') {
        const h = gate.isHeld(task, index, { now });
        if (h.held) summary.held.push({ id: task.id || id, by: h.by });
      }
    }
  }
  return summary;
}

module.exports = { sweepDerivedPremise, readmitInertTargets, refreshMain, CASCADE_STATES, PREMISE_STATES };

if (require.main === module) {
  const { getConfig } = require('./config.js');
  const { detectDefaultBranch } = require('./git-runner.js');
  const cfg = getConfig();
  const dryRun = process.argv.includes('--dry-run');
  const s = sweepDerivedPremise({
    pipelineDir: cfg.pipelineDir, repoRoot: cfg.repoRoot, mainBranch: detectDefaultBranch(cfg.repoRoot),
    extraRoots: cfg.grepAllowedDirs || [], brainDumpPath: cfg.brainDumpPath, dryRun,
  });
  const arch = s.archived.map((a) => `${a.id}<-${a.rule}`).join(', ');
  const inert = `inert(held=${s.inertHeld.length} released=${s.inertReleased.length} readmitted=${s.inertReadmitted.length})`;
  process.stdout.write(`checked=${s.checked} ${inert} archived=${s.archived.length}${arch ? ` [${arch}]` : ''} held=${s.held.length}${s.held.length ? ` [${s.held.map((h) => `${h.id}<-${h.by.join('+')}`).join(', ')}]` : ''} skipped=${s.skipped}${dryRun ? ' (dry run)' : ''}\n`);
}
