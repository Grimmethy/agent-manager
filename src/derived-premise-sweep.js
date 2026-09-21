'use strict';

// derived-premise-sweep.js -- a watchdog one-shot that retires derived_task findings which are deterministically dead, before a lane spends a draft
// on them (design and evidence: derived-gate.js). No model call. Two rules, both auto-retire (archive as 'abandoned', with the reason recorded):
//   raised-by-abandoned-task  the task that raised the finding (promptContext.derivedFrom.taskId) was itself retired/abandoned. States: derived
//                             (unclaimed), pending, adhoc, needs-clarification, blocked. NEVER a task a lane holds (drafting/review/approved).
//   all-cited-files-missing   every file the finding cites is missing from the working tree, origin/<main> AND (skipped when stacked) its branch.
//                             States: derived, pending, adhoc only (a task already worked may cite files legitimately gone).
// Never retires a human-prioritised task (premiumPriority / humanQueued / pinnedWorker) or an inert leftover origin record in derived/.
// It also REPORTS which derived tasks are currently held by an overlapping open task (the hold itself is in task-sources.js, via derived-gate.js).
// Kill switch: AGENT_MANAGER_DERIVED_PREMISE_SWEEP=false. CLI: node derived-premise-sweep.js [--dry-run]

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const gate = require('./derived-gate.js');

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

function retire({ queueDir, task, filePath, rule, detail, nowIso, brainDumpPath, dryRun }) {
  const destDir = path.join(queueDir, 'done', '_archived_no_action');
  const dest = path.join(destDir, path.basename(filePath));
  if (fs.existsSync(dest)) return false; // an archived copy already exists: leave both alone
  if (dryRun) return true;
  task.history = Array.isArray(task.history) ? task.history : [];
  task.history.push({ stage: 'abandoned', at: nowIso, detail: `auto-retired (${rule}): ${detail}` });
  if (!task.terminalDisposition) task.terminalDisposition = 'abandoned';
  task.autoRetired = { rule, detail, at: nowIso };
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

// existsOnDisk / existsAtRef / fetch are injectable so the tests need no real repo or network.
function sweepDerivedPremise({ pipelineDir, repoRoot, mainBranch = 'main', extraRoots = [], brainDumpPath = null, now = Date.now(), dryRun = false, existsOnDisk, existsAtRef, fetch = true } = {}) {
  const summary = { checked: 0, archived: [], held: [], skipped: 0 };
  if (!gate.sweepEnabled() || !pipelineDir) return summary;
  const queueDir = path.join(pipelineDir, 'queue');
  const nowIso = new Date(now).toISOString();
  if (fetch && repoRoot) refreshMain(repoRoot, mainBranch, path.join(queueDir, '.derived-premise-fetch'), now);
  const elsewhere = gate.otherIds(queueDir);
  const index = gate.openTaskIndex(pipelineDir);

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
      if (state === 'derived') {
        const h = gate.isHeld(task, index, { now });
        if (h.held) summary.held.push({ id: task.id || id, by: h.by });
      }
    }
  }
  return summary;
}

module.exports = { sweepDerivedPremise, CASCADE_STATES, PREMISE_STATES };

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
  process.stdout.write(`checked=${s.checked} archived=${s.archived.length}${arch ? ` [${arch}]` : ''} held=${s.held.length}${s.held.length ? ` [${s.held.map((h) => `${h.id}<-${h.by.join('+')}`).join(', ')}]` : ''} skipped=${s.skipped}${dryRun ? ' (dry run)' : ''}\n`);
}
