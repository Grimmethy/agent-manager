'use strict';

// fix-signature-sweep.js -- requeue tasks parked on a failure class whose fix has landed (see known-fixed-failures.js).
//
// A watchdog one-shot. For every KNOWN_FIXED entry it drains, ONCE, each task in blocked/ or needs-clarification/ that
//   - matches the entry (`applies`),
//   - FAILED BEFORE this sweep first saw the entry (state file: firstSeen[id]) -- i.e. before the fix was live. A task that fails the same
//     way after that means the fix did not cure it; requeueing it again would just loop,
//   - has not already been requeued for this entry (task.requeuedForFixes), and
//   - was never applied to a branch (an applied task has real work on a branch a redraft would orphan; that is a human's call).
//
// A SECOND candidate set (done-unmerged-branch scope): for entries whose `appliesScope` includes 'done-unmerged-branch' (or is 'both'),
// tasks in done/ whose branch is unmerged and whose branch-verdicts.json card carries a 'needs-work' verdict are requeued as a fresh draft
// against current master. The old branch is NOT deleted or merged (human's call for that); the old card is marked 'replacement queued: <id>'.
// Dedup uses the same requeuedForFixes field so a second sweep is a no-op.
//
// Requeue keeps the coordination fields the dashboard's own requeue keeps (stacked / dependsOn / atomic / ...) and puts the task where its
// kind is claimed (pending/ for a normal task, adhoc/ or derived/ for adhoc-shaped ones).
// Kill switch: AGENT_MANAGER_FIX_SIGNATURE_SWEEP=false. CLI: node fix-signature-sweep.js [--dry-run]

const fs = require('fs');
const path = require('path');
const { appendHistoryEvent } = require('./task-history.js');
const { KNOWN_FIXED } = require('./known-fixed-failures.js');

const STATE_FILE = 'fix-signature-state.json';
const COORDINATION_FIELDS = ['stacked', 'dependsOn', 'prerequisiteHubs', 'softDependsOn', 'atomic', 'noDecompose', 'parentHub', 'premiumPriority', 'hubPriority', 'humanQueued'];

function enabled() { return process.env.AGENT_MANAGER_FIX_SIGNATURE_SWEEP !== 'false'; }

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function writeJson(p, data) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(data, null, 2)); }

const isAdhocShaped = (task) => task.domain === 'adhoc' || task.source === 'manual' || task.source === 'derived_task';

// When this task last entered its stuck state: the newest blocked / needs-clarification / exhausted history event, else the file's mtime.
function stuckSince(task, filePath) {
  let latest = 0;
  for (const h of Array.isArray(task.history) ? task.history : []) {
    if (!h || !['blocked', 'needs-clarification', 'exhausted'].includes(h.stage || h.status)) continue;
    const t = Date.parse(h.at || '');
    if (Number.isFinite(t) && t > latest) latest = t;
  }
  if (latest) return latest;
  try { return fs.statSync(filePath).mtimeMs; } catch { return Date.now(); }
}

function destinationDir(queueDir, task) {
  if (task.source === 'derived_task') return path.join(queueDir, 'derived');
  if (isAdhocShaped(task)) return path.join(queueDir, 'adhoc');
  return path.join(queueDir, 'pending');
}

function freshShape(task, entry, from, nowIso) {
  const fresh = {
    id: task.id, domain: task.domain, source: task.source, title: task.title, promptContext: task.promptContext,
    status: 'pending', createdAt: task.createdAt || nowIso,
    requeuedForFixes: [...(Array.isArray(task.requeuedForFixes) ? task.requeuedForFixes : []), entry.id],
    history: Array.isArray(task.history) ? [...task.history] : [],
  };
  for (const k of COORDINATION_FIELDS) if (k in task) fresh[k] = task[k];
  appendHistoryEvent(fresh, 'requeued', `auto-requeued from ${from}/: the fix for "${entry.id}" landed (${entry.fixedIn}) after this task failed on it`);
  return fresh;
}

async function sweepKnownFixedFailures({ pipelineDir, entries = KNOWN_FIXED, now = new Date(), dryRun = false } = {}) {
  const summary = { checked: 0, requeued: [], skipped: 0, newEntries: [] };
  if (!enabled() || !pipelineDir) return summary;
  const queueDir = path.join(pipelineDir, 'queue');
  const statePath = path.join(queueDir, STATE_FILE);
  const state = readJson(statePath) || { firstSeen: {} };
  state.firstSeen = state.firstSeen || {};
  const nowIso = now.toISOString();

  for (const entry of entries) {
    if (!state.firstSeen[entry.id]) { state.firstSeen[entry.id] = nowIso; summary.newEntries.push(entry.id); }
    const liveAt = Date.parse(state.firstSeen[entry.id]);
    for (const dir of entry.dirs || ['blocked', 'needs-clarification']) {
      const stateDir = path.join(queueDir, dir);
      let names;
      try { names = (await fs.promises.readdir(stateDir)).filter((f) => f.endsWith('.json')); } catch { continue; }
      for (const name of names) {
        const filePath = path.join(stateDir, name);
        const task = readJson(filePath);
        if (!task || typeof task !== 'object') continue;
        summary.checked += 1;
        let ok = false;
        try { ok = !!entry.applies(task); } catch { ok = false; }
        if (!ok) continue;
        const already = Array.isArray(task.requeuedForFixes) && task.requeuedForFixes.includes(entry.id);
        const failedAfterFix = stuckSince(task, filePath) > liveAt;
        // A genuine design question is not a drafting failure -- only retry-exhaustion escalations are (same rule as blocked-drain.js).
        const design = task.needsClarification && task.needsClarification.reason === 'design-decision';
        const exhausted = Array.isArray(task.history) && task.history.some((h) => (h.stage || h.status) === 'exhausted');
        const hasBranch = Array.isArray(task.history) && task.history.some((h) => h && h.stage === 'applied');
        if (already || failedAfterFix || (design && !exhausted) || hasBranch || task.reviewInconclusive) { summary.skipped += 1; continue; }
        const dest = path.join(destinationDir(queueDir, task), name);
        // In pending/ or adhoc/ an existing same-name file is a real duplicate: leave it. In derived/ it is a STALE COPY of this very task: a derived task's
        // origin record stays there after it is claimed (taskIdExistsInQueue ignores that dir), so it is replaced by the fuller stuck record. Without this no
        // derived-source task could ever be drained (PF, 2026-09-20: all four victims of the draft-sandbox stdout bug had one and the dry run recovered none).
        if (fs.existsSync(dest) && path.basename(path.dirname(dest)) !== 'derived') { summary.skipped += 1; continue; }
        if (!dryRun) {
          writeJson(dest, freshShape(task, entry, dir, nowIso));
          fs.unlinkSync(filePath);
          try {
            require('./requeue-attribution.js').classifyRequeue(task, { reasonHint: entry.id, requeueWriter: 'fix-signature-sweep', repoRoot: pipelineDir }).catch(() => {});
          } catch { /* attribution is best-effort */ }
        }
        summary.requeued.push({ id: task.id, entry: entry.id, from: dir });
      }
    }

    // SECOND CANDIDATE SET: done-unmerged-branch scope. Tasks in done/ whose branch is unmerged and has a needs-work verdict.
    const appliesScope = entry.appliesScope || 'parked';
    if (appliesScope !== 'done-unmerged-branch' && appliesScope !== 'both') continue;
    const doneDir = path.join(queueDir, 'done');
    let doneNames;
    try { doneNames = (await fs.promises.readdir(doneDir)).filter((f) => f.endsWith('.json')); } catch { continue; }
    // Bounded: limit to 50 candidates per entry per sweep to prevent runaway behavior.
    let doneCount = 0;
    const MAX_DONE_CANDIDATES = 50;
    for (const name of doneNames) {
      if (doneCount >= MAX_DONE_CANDIDATES) break;
      const doneFilePath = path.join(doneDir, name);
      const task = readJson(doneFilePath);
      if (!task || typeof task !== 'object') continue;
      // Check for needs-work verdict on the branch.
      const priorVerdict = task.promptContext && task.promptContext.priorVerdict;
      if (!priorVerdict || priorVerdict.verdict !== 'needs-work') continue;
      // Get the applied branch from history.
      let appliedBranch = null;
      const history = Array.isArray(task.history) ? task.history : [];
      for (let i = history.length - 1; i >= 0; i--) {
        const ev = history[i];
        if (ev && ev.stage === 'applied' && ev.detail) {
          const first = String(ev.detail).split(/\s/)[0];
          if (first.startsWith('agent/')) { appliedBranch = first; break; }
        }
      }
      if (!appliedBranch) continue;
      // Check if the branch is unmerged (exists on origin and ahead of main).
      try {
        const { execFileSync } = require('child_process');
        const head = execFileSync('git', ['rev-parse', '--verify', `origin/${appliedBranch}`], { cwd: pipelineDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
        if (head.code !== 0) continue;
        const sha = String(head).trim();
        const ahead = execFileSync('git', ['rev-list', '--count', `origin/main..origin/${appliedBranch}`], { cwd: pipelineDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
        if (ahead.code !== 0 || !(parseInt(ahead, 10) > 0)) continue;
      } catch { continue; }
      // Dedup: check if already requeued for this entry.
      const already = Array.isArray(task.requeuedForFixes) && task.requeuedForFixes.includes(entry.id);
      if (already) { summary.skipped += 1; continue; }
      doneCount += 1;
      // Create a fresh draft using the existing freshShape helper, then add replacement-specific fields.
      const fresh = freshShape(task, entry, 'done', nowIso);
      fresh.premiumPriority = true;
      fresh.priorRejectionFeedback = priorVerdict.reasons && priorVerdict.reasons.length
        ? priorVerdict.reasons
        : [`needs-work on ${appliedBranch}: ${priorVerdict.detail || 'branch has defects'}`];
      fresh.replacementFor = task.id;
      // Mark the old card with a history entry noting the replacement.
      if (!dryRun) {
        writeJson(doneFilePath, {
          ...task,
          history: [...history, { stage: 'replacement-queued', at: nowIso, detail: `replacement queued: ${task.id}` }],
        });
      }
      summary.requeued.push({ id: task.id, entry: entry.id, from: 'done', branch: appliedBranch });
    }
  }
  if (!dryRun) writeJson(statePath, state);
  return summary;
}

module.exports = { sweepKnownFixedFailures, stuckSince, destinationDir, freshShape, STATE_FILE };

if (require.main === module) {
  const { getConfig } = require('./config.js');
  const { pipelineDir } = getConfig();
  const dryRun = process.argv.includes('--dry-run');
  (async () => {
    const s = await sweepKnownFixedFailures({ pipelineDir, dryRun });
    process.stdout.write(`checked=${s.checked} requeued=${s.requeued.length}${s.requeued.length ? ` [${s.requeued.map((r) => `${r.id}<-${r.entry}`).join(', ')}]` : ''} skipped=${s.skipped}${s.newEntries.length ? ` newEntries=[${s.newEntries.join(',')}]` : ''}${dryRun ? ' (dry run)' : ''}\n`);
  })().catch((e) => { console.error(e); process.exit(1); });
}
