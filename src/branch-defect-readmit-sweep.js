'use strict';

// branch-defect-readmit-sweep.js -- a watchdog one-shot that sends a single-task agent/* branch back for ONE redraft when a current chat/manual
// needs-work verdict names defects in it.
//
// Why (2026-10-24): 86 of the 87 branches in the Unmerged Branches list were needs-work, 82 of them from chat/manual verification, and for 61 the
// pipeline's own task had already finished as done: review and apply approved changes that a second look found defective. A chat/manual needs-work
// verdict is stamped onto the owning task as promptContext.priorVerdict (python/dashboard/branch_verdicts.py apply_prior_verdict) and the redraft
// prompt reads it (lib/prompt-blocks.js priorVerdictBlock), but nothing requeued the task, so the branch sat until a human filed a replacement.
// branch-conflict-readmit-sweep.js is the paired re-admission for main conflicts; this is the one for defects. It reuses that module's eligibility
// rules and requeues through the same code path (chat-task-requeue.js requeueBlockedTask: it deletes the superseded branch, records the removal and
// marks the old attempt abandoned).
//
// Scope, deliberately narrow (the same limits as the conflict sweep, except for human-prioritised tasks, see below):
//   - only a task in done/ with terminalDisposition 'pending-merge' whose latest `applied` event names an agent/* branch that still exists on origin
//     and is ahead of <main>; never a hub child or stacked task, never a pinned task, never a branch with a live sibling on it. A human-queued or
//     premium task IS eligible (owner decision 2026-10-30: the trigger here is a human verdict) and is requeued with its priority kept;
//   - only a verdict that is current: priorVerdict.verdict 'needs-work', source 'chat' or 'manual', not kind 'main-moved', and priorVerdict.sha equal
//     to the branch's CURRENT origin head. A verdict for an older commit is stale (the branch moved) and is ignored;
//   - the same verdict on the same head must be seen on two runs at least SETTLE_MS apart (a merge, apply or re-verification may be in flight);
//   - ONE redraft per task. The count is the number of 'defect-readmit' events in the task's history, NOT a field on priorVerdict: a later chat
//     verdict replaces priorVerdict wholesale and would reset a counter kept there, and requeueBlockedTask carries history over. A task that was
//     already re-admitted once and is needs-work again is left in place and reported as `exhausted`.
//
// AGENT_MANAGER_DEFECT_READMIT=off|dry-run|on (default dry-run: records what it saw in the state file and the summary, changes no task and no branch).
// CLI: node branch-defect-readmit-sweep.js [--dry-run]

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { liveSiblingsOnBranch } = require('./lib/shared-branch.js');
const { requeueBlockedTask } = require('./chat-task-requeue.js');
const { appliedBranch, eligibleTask, SETTLE_MS } = require('./branch-conflict-readmit-sweep.js');

const MAX_READMITS = 1;
const REASON_CHARS = 160;
const STATE_FILE = 'branch-defect-readmit-state.json';
const READMIT_STAGE = 'defect-readmit';

function mode() {
  const v = String(process.env.AGENT_MANAGER_DEFECT_READMIT || 'dry-run').toLowerCase();
  return v === 'off' || v === 'false' || v === '0' ? 'off' : v === 'on' || v === 'true' || v === '1' ? 'on' : 'dry-run';
}

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p);
}

function defaultGit(repoRoot, args) {
  try {
    return { code: 0, out: execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }) };
  } catch (e) {
    return { code: typeof e.status === 'number' ? e.status : 2, out: String(e.stdout || ''), err: String(e.stderr || '') };
  }
}

// The task's priorVerdict when it is a defect verdict from a person (chat/manual), else null.
function defectVerdict(task) {
  const pv = task && task.promptContext && typeof task.promptContext === 'object' ? task.promptContext.priorVerdict : null;
  if (!pv || typeof pv !== 'object' || pv.verdict !== 'needs-work' || pv.kind === 'main-moved') return null;
  if (pv.source !== 'chat' && pv.source !== 'manual') return null;
  if (typeof pv.sha !== 'string' || !pv.sha) return null;
  return Array.isArray(pv.reasons) && pv.reasons.some((r) => typeof r === 'string' && r.trim()) ? pv : null;
}

// How many times this task was already sent back by this sweep.
function countReadmits(task) {
  return (Array.isArray(task && task.history) ? task.history : []).filter((e) => e && e.stage === READMIT_STAGE).length;
}

// { pipelineDir, repoRoot, mainBranch?, now?, dryRun?, git?, requeue?, fetch?, modeOverride? } -> Promise<summary>
async function sweepBranchDefects({
  pipelineDir, repoRoot, mainBranch = 'main', now = Date.now(), dryRun = false,
  git = defaultGit, requeue = requeueBlockedTask, fetch = true, modeOverride = null,
} = {}) {
  const summary = { mode: modeOverride || mode(), checked: 0, observed: [], settling: [], stale: [], requeued: [], exhausted: [], errors: 0 };
  if (summary.mode === 'off' || !pipelineDir || !repoRoot) return summary;
  const live = summary.mode === 'on' && !dryRun;
  const queueDir = path.join(pipelineDir, 'queue');
  const nowIso = new Date(now).toISOString();
  if (fetch) git(repoRoot, ['fetch', '-q', 'origin']);

  const statePath = path.join(queueDir, STATE_FILE);
  const state = readJson(statePath) || {};
  const nextState = {};

  const doneDir = path.join(queueDir, 'done');
  let names = [];
  try { names = fs.readdirSync(doneDir).filter((f) => f.endsWith('.json')); } catch { names = []; }

  for (const name of names) {
    const filePath = path.join(doneDir, name);
    const task = readJson(filePath);
    if (!eligibleTask(task, { allowHumanPrioritised: true })) continue;   // the trigger is a human verdict (defectVerdict below)
    const pv = defectVerdict(task);
    if (!pv) continue;
    const branch = appliedBranch(task);
    if (!branch) continue;
    try {
      const head = git(repoRoot, ['rev-parse', '--verify', `origin/${branch}`]);
      if (head.code !== 0) continue;                       // branch gone: reconcile's business, not ours
      const sha = String(head.out).trim();
      const ahead = git(repoRoot, ['rev-list', '--count', `origin/${mainBranch}..origin/${branch}`]);
      if (ahead.code !== 0 || !(parseInt(ahead.out, 10) > 0)) continue;   // merged or empty
      const shared = liveSiblingsOnBranch({ pipelineDir, branch, selfId: task.id });
      if (shared.error || shared.siblings.length) continue;

      summary.checked += 1;
      if (pv.sha !== sha) { summary.stale.push({ id: task.id, branch }); continue; }   // the verdict is for an older commit
      if (countReadmits(task) >= MAX_READMITS) { summary.exhausted.push({ id: task.id, branch }); continue; }

      const prev = state[branch];
      const same = prev && prev.sha === sha && prev.verdictAt === pv.at;
      const firstSeenAt = same ? prev.firstSeenAt : nowIso;
      nextState[branch] = { sha, verdictAt: pv.at, firstSeenAt, taskId: task.id };
      if (!same) { summary.observed.push({ id: task.id, branch }); continue; }
      if (now - Date.parse(firstSeenAt) < SETTLE_MS) { summary.settling.push({ id: task.id, branch }); continue; }

      const entry = { id: task.id, branch };
      if (!live) { summary.requeued.push({ ...entry, dryRun: true }); continue; }

      const first = String(pv.reasons.find((r) => typeof r === 'string' && r.trim()) || '').trim().slice(0, REASON_CHARS);
      task.history = Array.isArray(task.history) ? task.history : [];
      task.history.push({ stage: READMIT_STAGE, at: nowIso, detail: `${branch} had a needs-work verdict (${first}); requeued once for a redraft with the reviewer's reasons` });
      writeJson(filePath, task);
      const res = await requeue(pipelineDir, repoRoot, task.id, { state: 'done', force: true, keepPriority: true });
      if (!res || res.ok !== true) {
        summary.errors += 1;
        console.error(`[branch-defect-readmit] ${task.id}: requeue failed: ${res && res.error}`);
        continue;
      }
      delete nextState[branch];
      summary.requeued.push(entry);
    } catch (e) {
      summary.errors += 1;
      console.error(`[branch-defect-readmit] ${task && task.id || name}: ${e.message}`);
    }
  }

  writeJson(statePath, nextState);
  return summary;
}

module.exports = { sweepBranchDefects, defectVerdict, countReadmits, SETTLE_MS, MAX_READMITS, STATE_FILE, READMIT_STAGE };

if (require.main === module) {
  const { getConfig } = require('./config.js');
  const { detectDefaultBranch } = require('./git-runner.js');
  const cfg = getConfig();
  const dryRun = process.argv.includes('--dry-run');
  sweepBranchDefects({ pipelineDir: cfg.pipelineDir, repoRoot: cfg.repoRoot, mainBranch: detectDefaultBranch(cfg.repoRoot), dryRun }).then((s) => {
    const ids = (a) => (a.length ? ` [${a.map((x) => x.id).join(', ')}]` : '');
    process.stdout.write(`mode=${s.mode} checked=${s.checked} observed=${s.observed.length} settling=${s.settling.length} stale=${s.stale.length} requeued=${s.requeued.length}${ids(s.requeued)} exhausted=${s.exhausted.length}${ids(s.exhausted)} errors=${s.errors}${dryRun ? ' (dry run)' : ''}\n`);
  }).catch((e) => { console.error('[branch-defect-readmit]', (e && e.stack) || e); process.exit(1); });
}
