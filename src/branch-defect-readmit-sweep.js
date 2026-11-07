'use strict';

// branch-defect-readmit-sweep.js -- a watchdog one-shot that sends a single-task agent/* branch back for ONE redraft when a current chat, manual or
// worker needs-work verdict names defects in it.
//
// Why (2026-10-24): 86 of the 87 branches in the Unmerged Branches list were needs-work, 82 of them from chat/manual verification, and for 61 the
// pipeline's own task had already finished as done: review and apply approved changes that a second look found defective. A chat/manual needs-work
// verdict is stamped onto the owning task as promptContext.priorVerdict (python/dashboard/branch_verdicts.py apply_prior_verdict) and the redraft
// prompt reads it (lib/prompt-blocks.js priorVerdictBlock), but nothing requeued the task, so the branch sat until a human filed a replacement.
// 2026-11-02: the branch verifier worker (agent-manager-pipeline-ops, verdict source 'worker') now records most verdicts and apply_prior_verdict stamps
// them the same way, so its needs-work verdicts count here too (25 Needs-Work cards sat on the board with this sweep ignoring 7 of them).
// branch-conflict-readmit-sweep.js is the paired re-admission for main conflicts; this is the one for defects. It reuses that module's eligibility
// rules and requeues through the same code path (chat-task-requeue.js requeueBlockedTask: it deletes the superseded branch, records the removal and
// marks the old attempt abandoned).
//
// Scope, deliberately narrow (the same limits as the conflict sweep, except for human-prioritised tasks, see below):
//   - only a task in done/ with terminalDisposition 'pending-merge' whose latest `applied` event names an agent/* branch that still exists on origin
//     and is ahead of <main>; never a hub child or stacked task, never a pinned task, never a branch with a live sibling on it. A human-queued or
//     premium task IS eligible (owner decision 2026-10-30: the trigger here is a human verdict) and is requeued with its priority kept;
//   - only a verdict that is current: priorVerdict.verdict 'needs-work', source 'chat', 'manual' or 'worker', not kind 'main-moved', and priorVerdict.sha equal
//     to the branch's CURRENT origin head. A verdict for an older commit is stale (the branch moved) and is ignored;
//   - the same verdict on the same head must be seen on two runs at least SETTLE_MS apart (a merge, apply or re-verification may be in flight);
//   - ONE redraft per task. The count is the number of 'defect-readmit' events in the task's history, NOT a field on priorVerdict: a later chat
//     verdict replaces priorVerdict wholesale and would reset a counter kept there, and requeueBlockedTask carries history over. A task that was
//     already re-admitted once and is needs-work again is left in place and reported as `exhausted`.
//
// AGENT_MANAGER_DEFECT_READMIT=off|dry-run|on (default dry-run: records what it saw in the state file and the summary, changes no task and no branch).
//
// ADR-0024 (queue-events journal, HUB0330): the sweep no longer lists and parses all of queue/done on every watchdog tick. It drains the journal and examines only the tasks a
// `verdict_recorded` event names (branch agent/<id> -> done/<id>.json) plus the tasks whose first sighting is still awaiting its second look (the SETTLE rule below needs
// no new event). The FULL scan (the old behaviour) runs on the first run and every AGENT_MANAGER_EVENTS_RECONCILE_SECS (default 1800); a defect verdict that reconcile scan newly
// observes and no event named is counted with recordCorrection (a producer forgot to emit; the first run is the catch-up and counts nothing). An idle run makes no git call, no fetch and no directory listing. The dashboard stamps priorVerdict on the
// task just AFTER it records the verdict, so an event younger than STAMP_GRACE_MS whose task has no defect verdict yet keeps the journal position where it is and is read again.
// AGENT_MANAGER_QUEUE_EVENTS=off restores the old full scan on every run exactly.
// CLI: node branch-defect-readmit-sweep.js [--dry-run]

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { liveSiblingsOnBranch, buildQueueSnapshot } = require('./lib/shared-branch.js');
const queueEvents = require('./queue-events.js');
const { requeueBlockedTask } = require('./chat-task-requeue.js');
const { appliedBranch, eligibleTask, SETTLE_MS } = require('./branch-conflict-readmit-sweep.js');

const MAX_READMITS = 1;
const REASON_CHARS = 160;
const STATE_FILE = 'branch-defect-readmit-state.json';
const READMIT_STAGE = 'defect-readmit';
const CONSUMER = 'defect-readmit';
const STAMP_GRACE_MS = 2 * 60 * 1000;
const journalOn = (env) => String(env.AGENT_MANAGER_QUEUE_EVENTS || 'on').toLowerCase() !== 'off';
function reconcileMs(env) {
  const n = Number(env.AGENT_MANAGER_EVENTS_RECONCILE_SECS);
  return Number.isFinite(n) && n >= 0 ? n * 1000 : 30 * 60 * 1000;
}
const scanStatePath = (pipelineDir) => path.join(pipelineDir, 'queue-events', 'defect-readmit.scan.json');
const taskIdOfBranch = (branch) => String(branch || '').replace(/^agent\//, '');

function mode() {
  const v = String(process.env.AGENT_MANAGER_DEFECT_READMIT || 'dry-run').toLowerCase();
  return v === 'off' || v === 'false' || v === '0' ? 'off' : v === 'on' || v === 'true' || v === '1' ? 'on' : 'dry-run';
}

function readJson(p, fsImpl = fs) { try { return JSON.parse(fsImpl.readFileSync(p, 'utf8')); } catch { return null; } }
// Writes only when the content differs from what is there (a tick that decided nothing new must not rewrite the state file every minute).
function writeJsonIfChanged(p, data, before) {
  if (JSON.stringify(before) === JSON.stringify(data)) return;
  writeJson(p, data);
}

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

// The task's priorVerdict when it is a defect verdict from a person or the verifier worker (chat/manual/worker), else null.
function defectVerdict(task) {
  const pv = task && task.promptContext && typeof task.promptContext === 'object' ? task.promptContext.priorVerdict : null;
  if (!pv || typeof pv !== 'object' || pv.verdict !== 'needs-work' || pv.kind === 'main-moved') return null;
  if (pv.source !== 'chat' && pv.source !== 'manual' && pv.source !== 'worker') return null;
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
  git = defaultGit, requeue = requeueBlockedTask, fetch = true, modeOverride = null, env = process.env, fsImpl = fs,
} = {}) {
  const summary = { mode: modeOverride || mode(), checked: 0, observed: [], settling: [], stale: [], requeued: [], exhausted: [], errors: 0, journal: { events: journalOn(env), fullScan: false, eventRun: false, idle: false, corrections: 0 } };
  if (summary.mode === 'off' || !pipelineDir || !repoRoot) return summary;
  const live = summary.mode === 'on' && !dryRun;
  const queueDir = path.join(pipelineDir, 'queue');
  const nowIso = new Date(now).toISOString();

  const statePath = path.join(queueDir, STATE_FILE);
  const prevState = readJson(statePath, fsImpl);
  const state = prevState || {};

  const doneDir = path.join(queueDir, 'done');
  const listDone = () => { try { return fsImpl.readdirSync(doneDir).filter((f) => f.endsWith('.json')); } catch { return []; } };

  // ---- which done/ files to examine this run ----
  let names;
  const nextState = {};                                    // rebuilt every run, as before: every pending sighting is examined each run, so none needs carrying over
  let drained = null;
  let fullScan = true;
  let reconcile = false;
  const announced = new Set();
  const eventAt = new Map();
  if (!summary.journal.events) {
    names = listDone();
  } else {
    drained = queueEvents.drain(pipelineDir, CONSUMER, { fs: fsImpl });
    let scan = null;
    try { scan = JSON.parse(fsImpl.readFileSync(scanStatePath(pipelineDir), 'utf8')); } catch { scan = null; }
    fullScan = !scan || !Number.isFinite(scan.at) || now - scan.at >= reconcileMs(env);
    reconcile = fullScan && !!scan;
    for (const e of drained.events) {
      if (e.type !== 'verdict_recorded' || !e.branch) continue;
      const id = taskIdOfBranch(e.branch);
      announced.add(id);
      eventAt.set(id, e.at);
    }
    if (fullScan) {
      names = listDone();
    } else {
      const pending = new Set(Object.values(state).map((x) => x && x.taskId).filter(Boolean));
      const wanted = new Set([...announced, ...pending]);
      names = [...wanted].map((id) => `${id}.json`).filter((n) => fsImpl.existsSync(path.join(doneDir, n)));
    }
    summary.journal.fullScan = fullScan;
    summary.journal.eventRun = !fullScan && names.length > 0;
    if (!fullScan && !names.length) {
      summary.journal.idle = drained.events.length === 0;
      drained.commit();                                    // events that name no examinable task are consumed; nothing else to do, no fetch, no git
      return summary;
    }
  }

  let superseded = 0;
  let holdCommit = false;
  let snapshot = null;
  const getSnapshot = () => (snapshot || (snapshot = buildQueueSnapshot(pipelineDir)));
  const missedEvents = [];                                // verdicts the reconcile scan newly found that no event announced

  // Journal bookkeeping, shared by BOTH exits (the no-candidate early return below and the end of the run): count what the scan found unannounced, consume the drained events and stamp
  // the scan. Skipping it on the early return would leave the events pending forever and re-run the full scan every minute.
  const finishJournal = () => {
    if (drained) {
      if (missedEvents.length) {
        try { queueEvents.recordCorrection(pipelineDir, CONSUMER, missedEvents.length, { fs: fsImpl }); summary.journal.corrections = missedEvents.length; } catch { /* the counter is best effort */ }
      }
      if (summary.errors === 0 && !holdCommit) {              // unfinished work (an error, an unstamped fresh verdict) keeps the events and the scan pending
        drained.commit();
        if (fullScan) {
          try { fsImpl.mkdirSync(path.dirname(scanStatePath(pipelineDir)), { recursive: true }); fsImpl.writeFileSync(scanStatePath(pipelineDir), JSON.stringify({ at: now })); } catch { /* best effort */ }
        }
      }
    }
  };

  // Pre-pass (2026-11-03, pool rescan): the cheap local filters first, one read per task. The slow `git fetch` is only worth paying for when a task is left that git has to
  // answer for; with 41 pool projects and no candidate in most of them, a fetch before the filters cost a fetch per project per tick for nothing.
  const candidates = [];
  for (const name of names) {
    const filePath = path.join(doneDir, name);
    const task = readJson(filePath, fsImpl);
    if (!eligibleTask(task, { allowHumanPrioritised: true })) continue;   // the trigger is a human verdict (defectVerdict below)
    const pv = defectVerdict(task);
    if (!pv) {
      const at = eventAt.get(name.replace(/\.json$/, ''));
      if (at && now - Date.parse(at) < STAMP_GRACE_MS) holdCommit = true;   // the dashboard stamps priorVerdict just after it records the verdict: read this event again
      continue;
    }
    const branch = appliedBranch(task);
    if (!branch) continue;
    candidates.push({ name, filePath, task, pv, branch });
  }
  if (!candidates.length) {
    if (Object.keys(state).length) writeJson(statePath, nextState);    // an empty state stays as it is: no write when nothing would change
    finishJournal();
    return summary;
  }
  if (fetch) git(repoRoot, ['fetch', '-q', 'origin']);

  for (const { name, filePath, task, pv, branch } of candidates) {
    try {
      const head = git(repoRoot, ['rev-parse', '--verify', `origin/${branch}`]);
      if (head.code !== 0) continue;                       // branch gone: reconcile's business, not ours
      const sha = String(head.out).trim();
      const ahead = git(repoRoot, ['rev-list', '--count', `origin/${mainBranch}..origin/${branch}`]);
      if (ahead.code !== 0 || !(parseInt(ahead.out, 10) > 0)) continue;   // merged or empty
      const shared = liveSiblingsOnBranch({ pipelineDir, branch, selfId: task.id, ...(summary.journal.events ? { snapshot: getSnapshot() } : {}) });
      if (shared.error || shared.siblings.length) continue;

      summary.checked += 1;
      if (pv.sha !== sha) { summary.stale.push({ id: task.id, branch }); continue; }   // the verdict is for an older commit
      if (countReadmits(task) >= MAX_READMITS) { summary.exhausted.push({ id: task.id, branch }); continue; }

      const prev = state[branch];
      const same = prev && prev.sha === sha && prev.verdictAt === pv.at;
      const firstSeenAt = same ? prev.firstSeenAt : nowIso;
      nextState[branch] = { sha, verdictAt: pv.at, firstSeenAt, taskId: task.id };
      if (!same) {
        summary.observed.push({ id: task.id, branch });
        if (reconcile && !announced.has(task.id)) missedEvents.push(task.id);   // found by the safety-net scan alone: a producer forgot to emit
        continue;
      }
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
      superseded++;
      snapshot = null;                                       // the requeued task is now a live sibling on its branch: a stale snapshot would hide that
    } catch (e) {
      summary.errors += 1;
      console.error(`[branch-defect-readmit] ${task && task.id || name}: ${e.message}`);
    }
  }

  writeJsonIfChanged(statePath, nextState, prevState);
  finishJournal();
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
    process.stdout.write(`mode=${s.mode} checked=${s.checked} observed=${s.observed.length} settling=${s.settling.length} stale=${s.stale.length} requeued=${s.requeued.length} superseded=${s.superseded}${ids(s.requeued)} exhausted=${s.exhausted.length}${ids(s.exhausted)} errors=${s.errors}${dryRun ? ' (dry run)' : ''}\n`);
  }).catch((e) => { console.error('[branch-defect-readmit]', (e && e.stack) || e); process.exit(1); });
}
