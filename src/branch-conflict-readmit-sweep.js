'use strict';

// branch-conflict-readmit-sweep.js -- a watchdog one-shot that sends a single-task agent/* branch back for a redraft once main has moved
// under it and the branch no longer merges.
//
// Why (2026-10-09, TaxHarvest): six unmerged branches were stuck in needs-work on "conflicts with main" or on a rival. Two of them (HUB0031,
// the HUB0022 follow-up) had been overtaken by a fix for the same finding that merged the same day, so they were already redundant. The
// deterministic conflict check (python/dashboard/branch_verdicts.py _check_conflicts) only COLOURS the card; nothing re-ran the task, so the
// branch sat until a human read it. This is the paired re-admission for that gate.
//
// A rebase cannot help: a branch that conflicts with main under merge-tree conflicts under rebase too. The only repair is a redraft against current
// main, and the redraft's first job is to find out whether the change already landed. So the sweep stamps promptContext.priorVerdict
// ({ kind: 'main-moved', files, ... }) and requeues the task through chat-task-requeue.js (the same code path the dashboard Requeue button
// mirrors: it deletes the superseded branch, records the removal, marks the old attempt abandoned).
//
// Scope, deliberately narrow:
//   - only a task in done/ with terminalDisposition 'pending-merge' whose latest `applied` event names an agent/* branch that still exists
//     on origin and is ahead of <main>;
//   - never a hub child or stacked task, never a branch with a live sibling on it (lib/shared-branch.js), never a human-prioritised task;
//   - only a conflict with MAIN. Two rivals that conflict only with each other are a human choice; once one merges the loser conflicts
//     with main and is picked up here;
//   - the conflict must be seen on two runs at least SETTLE_MS apart for the same head sha (a merge or apply may be in flight);
//   - ONE redraft per task (priorVerdict.attempt). A second conflict is left in place and reported as `exhausted`.
//
// AGENT_MANAGER_CONFLICT_READMIT=off|dry-run|on (default dry-run: records what it saw in the state file and the summary, changes no task).
//
// ADR-0024 (queue-events journal, HUB0330): the trigger for this sweep is "main moved", i.e. a `branch_merged` event. It no longer lists and parses all of queue/done on every
// watchdog tick: with the journal on, a run that drained no branch_merged event and has no first sighting awaiting its second look returns at once (no listing, no snapshot, no
// per-branch git); a run with a merge event lists done/ ONCE and checks every pending-merge task, because any merge can create a conflict in any of them; a run with only pending
// sightings revisits just those tasks, so the two-sightings SETTLE rule needs no new event. A FULL listing also runs on the first run and every AGENT_MANAGER_EVENTS_RECONCILE_SECS
// (default 1800), to catch main moving without an announcement (a direct push); a conflict that reconcile scan newly observes while no merge event was drained is counted with
// recordCorrection (the first run is the catch-up and counts nothing). Position and scan time advance only after a run with no errors and no failed conflict check.
// AGENT_MANAGER_QUEUE_EVENTS=off restores the old full listing on every run exactly. An idle run makes no git call at all, fetch included; every other run fetches once before it examines anything.
// CLI: node branch-conflict-readmit-sweep.js [--dry-run]

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { liveSiblingsOnBranch, buildQueueSnapshot, bare } = require('./lib/shared-branch.js');
const queueEvents = require('./queue-events.js');
const { requeueBlockedTask } = require('./chat-task-requeue.js');

const SETTLE_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 1;
const MAX_FILES_LISTED = 8;
const STATE_FILE = 'branch-conflict-readmit-state.json';
const CONSUMER = 'conflict-readmit';
const journalOn = (env) => String(env.AGENT_MANAGER_QUEUE_EVENTS || 'on').toLowerCase() !== 'off';
function reconcileMs(env) {
  const n = Number(env.AGENT_MANAGER_EVENTS_RECONCILE_SECS);
  return Number.isFinite(n) && n >= 0 ? n * 1000 : 30 * 60 * 1000;
}
const scanStatePath = (pipelineDir) => path.join(pipelineDir, 'queue-events', 'conflict-readmit.scan.json');
let superseded = 0;

function mode() {
  const v = String(process.env.AGENT_MANAGER_CONFLICT_READMIT || 'dry-run').toLowerCase();
  return v === 'off' || v === 'false' || v === '0' ? 'off' : v === 'on' || v === 'true' || v === '1' ? 'on' : 'dry-run';
}

function readJson(p, fsImpl = fs) { try { return JSON.parse(fsImpl.readFileSync(p, 'utf8')); } catch { return null; } }
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

// The agent/* branch a task's most recent `applied` event names, or null.
function appliedBranch(task) {
  for (const ev of [...(Array.isArray(task.history) ? task.history : [])].reverse()) {
    if (ev && ev.stage === 'applied' && ev.detail) {
      const first = bare(String(ev.detail).split(/\s/)[0]);
      return first.startsWith('agent/') ? first : null;
    }
  }
  return null;
}

// Hub children, stacked tasks and pinned tasks are never touched. Human-prioritised tasks (humanQueued / premiumPriority) are skipped too unless the
// caller's trigger is itself a human verdict (branch-defect-readmit-sweep.js passes allowHumanPrioritised: owner decision 2026-10-30, because a task a
// person filed and a person then judged defective is exactly the one that should go back for a redraft).
function eligibleTask(task, { allowHumanPrioritised = false } = {}) {
  if (!task || task.terminalDisposition !== 'pending-merge') return false;
  if (task.hubId || task.parentHub || task.stacked) return false;
  if (task.pinnedWorker) return false;
  if (!allowHumanPrioritised && (task.humanQueued || task.premiumPriority)) return false;
  return true;
}

// -> { conflict: boolean|null, files: string[] }   null = the check itself failed (never reported as a conflict)
function conflictWithMain(git, repoRoot, mainBranch, branch) {
  const r = git(repoRoot, ['merge-tree', '--write-tree', '--name-only', `origin/${mainBranch}`, `origin/${branch}`]);
  if (r.code === 0) return { conflict: false, files: [] };
  if (r.code !== 1) return { conflict: null, files: [] };
  // --name-only prints the tree id, the conflicted paths, a blank line, then informational messages.
  const lines = String(r.out).split('\n').slice(1);
  const blank = lines.indexOf('');
  const files = (blank === -1 ? lines : lines.slice(0, blank)).map((l) => l.trim()).filter(Boolean);
  return { conflict: true, files };
}

// An earlier chat/manual needs-work verdict on this task (priorVerdict without kind 'main-moved') named real defects in the change; the conflict
// message must not overwrite it, so its reasons ride along after ours.
function carriedReasons(task) {
  const pv = task && task.promptContext && task.promptContext.priorVerdict;
  if (!pv || pv.kind === 'main-moved' || pv.verdict !== 'needs-work' || !Array.isArray(pv.reasons)) return [];
  return pv.reasons.filter((r) => typeof r === 'string' && r.trim()).map((r) => `Earlier review of the previous attempt, still applies if you redo the change: ${r.trim()}`);
}

function priorVerdictFor(task, branch, sha, files, mainBranch, nowIso, attempt) {
  const listed = files.slice(0, MAX_FILES_LISTED).join(', ') + (files.length > MAX_FILES_LISTED ? `, +${files.length - MAX_FILES_LISTED} more` : '');
  return {
    verdict: 'needs-work',
    kind: 'main-moved',
    reasons: [
      `${mainBranch} moved after your previous attempt and its branch no longer merges: it conflicts on ${listed || 'unknown files'}. The previous change was not judged wrong.`,
      'FIRST read the current code at those files. If the change this task asks for is already present on '
        + `${mainBranch} (another task or a hand edit landed it), do not re-implement it: finish as already implemented and say what you found and where.`,
      `Otherwise redo the change against the current ${mainBranch}. Re-read the target code before editing; do not reuse line numbers or surrounding context from the earlier attempt.`,
      ...carriedReasons(task),
    ],
    sha, at: nowIso, source: 'sweep', branch, attempt,
  };
}

// { pipelineDir, repoRoot, mainBranch?, now?, dryRun?, git?, requeue?, fetch?, modeOverride? } -> Promise<summary>
async function sweepBranchConflicts({
  pipelineDir, repoRoot, mainBranch = 'main', now = Date.now(), dryRun = false,
  git = defaultGit, requeue = requeueBlockedTask, fetch = true, modeOverride = null, env = process.env, fsImpl = fs,
} = {}) {
  const summary = { mode: modeOverride || mode(), checked: 0, observed: [], settling: [], requeued: [], exhausted: [], cleared: [], errors: 0, journal: { events: journalOn(env), fullScan: false, mergeRun: false, pendingRun: false, idle: false, corrections: 0 } };
  if (summary.mode === 'off' || !pipelineDir || !repoRoot) return summary;
  const live = summary.mode === 'on' && !dryRun;
  const queueDir = path.join(pipelineDir, 'queue');
  const nowIso = new Date(now).toISOString();
  if (fetch && !summary.journal.events) git(repoRoot, ['fetch', '-q', 'origin']);   // journal off: the old behaviour, first thing on every run (journal on: see below)

  const statePath = path.join(queueDir, STATE_FILE);
  const state = readJson(statePath, fsImpl) || {};
  const nextState = {};
  const doneDir = path.join(queueDir, 'done');
  const listDone = () => { try { return fsImpl.readdirSync(doneDir).filter((f) => f.endsWith('.json')); } catch { return []; } };

  // ---- which done/ files to examine this run ----
  let names;
  let drained = null;
  let fullScan = true;
  let reconcile = false;
  let mergeEvent = false;
  if (!summary.journal.events) {
    names = listDone();
  } else {
    drained = queueEvents.drain(pipelineDir, CONSUMER, { fs: fsImpl });
    let scan = null;
    try { scan = JSON.parse(fsImpl.readFileSync(scanStatePath(pipelineDir), 'utf8')); } catch { scan = null; }
    fullScan = !scan || !Number.isFinite(scan.at) || now - scan.at >= reconcileMs(env);
    reconcile = fullScan && !!scan;
    mergeEvent = drained.events.some((e) => e.type === 'branch_merged');
    summary.journal.fullScan = fullScan;
    if (fullScan || mergeEvent) {
      names = listDone();                                  // main moved (or the safety net is due): any pending-merge task may conflict now
      summary.journal.mergeRun = !fullScan;
    } else {
      const pending = new Set(Object.values(state).map((x) => x && x.taskId).filter(Boolean));
      names = [...pending].map((id) => `${id}.json`).filter((n) => fsImpl.existsSync(path.join(doneDir, n)));
      summary.journal.pendingRun = names.length > 0;
      if (!names.length) {
        summary.journal.idle = true;
        drained.commit();                                  // nothing moved and nothing awaits a second look: events of other kinds are consumed, no listing, no snapshot, no per-branch git
        return summary;
      }
    }
  }

  // Journal on: the fetch only matters when this run will actually examine tasks (a first run, a due reconcile, a merge event or a pending sighting). An idle run returned above
  // and made no git call at all (ADR-0024: the watchdog's `git fetch origin` was measured at about 17 launches a minute).
  if (fetch && summary.journal.events) git(repoRoot, ['fetch', '-q', 'origin']);

  let holdCommit = false;                                  // a failed conflict check leaves the events pending
  let snapshot = null;
  const getSnapshot = () => (snapshot || (snapshot = buildQueueSnapshot(pipelineDir)));
  const missedMerges = [];                                 // conflicts the reconcile scan newly found while no merge event was drained

  for (const name of names) {
    const filePath = path.join(doneDir, name);
    const task = readJson(filePath, fsImpl);
    if (!eligibleTask(task)) continue;
    const branch = appliedBranch(task);
    if (!branch) continue;
    try {
      const head = git(repoRoot, ['rev-parse', '--verify', `origin/${branch}`]);
      if (head.code !== 0) continue;                       // branch gone: reconcile's business, not ours
      const sha = String(head.out).trim();
      const ahead = git(repoRoot, ['rev-list', '--count', `origin/${mainBranch}..origin/${branch}`]);
      if (ahead.code !== 0 || !(parseInt(ahead.out, 10) > 0)) continue;   // merged or empty
      const shared = liveSiblingsOnBranch({ pipelineDir, branch, selfId: task.id, ...(summary.journal.events ? { snapshot: getSnapshot() } : {}) });
      if (shared.error || shared.siblings.length) continue;

      summary.checked += 1;
      const c = conflictWithMain(git, repoRoot, mainBranch, branch);
      if (c.conflict === null) { holdCommit = true; if (state[branch]) nextState[branch] = state[branch]; continue; }
      if (!c.conflict) { if (state[branch]) summary.cleared.push(branch); continue; }

      const prev = state[branch];
      const firstSeenAt = prev && prev.sha === sha ? prev.firstSeenAt : nowIso;
      nextState[branch] = { sha, firstSeenAt, files: c.files, taskId: task.id };
      if (!prev || prev.sha !== sha) {
        summary.observed.push({ id: task.id, branch });
        if (reconcile && !mergeEvent) missedMerges.push(task.id);   // found by the safety-net scan alone: main moved without an announcement
        continue;
      }
      if (now - Date.parse(firstSeenAt) < SETTLE_MS) { summary.settling.push({ id: task.id, branch }); continue; }

      const pv = task.promptContext && task.promptContext.priorVerdict;
      const attempts = pv && pv.kind === 'main-moved' ? Number(pv.attempt) || 1 : 0;
      if (attempts >= MAX_ATTEMPTS) {
        summary.exhausted.push({ id: task.id, branch, files: c.files });
        continue;
      }
      const entry = { id: task.id, branch, files: c.files };
      if (!live) { summary.requeued.push({ ...entry, dryRun: true }); continue; }

      task.promptContext = task.promptContext && typeof task.promptContext === 'object' ? task.promptContext : {};
      task.promptContext.priorVerdict = priorVerdictFor(task, branch, sha, c.files, mainBranch, nowIso, attempts + 1);
      task.history = Array.isArray(task.history) ? task.history : [];
      task.history.push({ stage: 'conflict-readmit', at: nowIso, detail: `${branch} conflicts with ${mainBranch} on ${c.files.slice(0, MAX_FILES_LISTED).join(', ')}; requeued for a redraft against current ${mainBranch}` });
      writeJson(filePath, task);
      const res = await requeue(pipelineDir, repoRoot, task.id, { state: 'done', force: true });
      if (!res || res.ok !== true) {
        summary.errors += 1;
        console.error(`[branch-conflict-readmit] ${task.id}: requeue failed: ${res && res.error}`);
        continue;
      }
      delete nextState[branch];
      summary.requeued.push(entry);
      superseded++;
      snapshot = null;                                       // the requeued task is now a live sibling on its branch: a stale snapshot would hide that
    } catch (e) {
      summary.errors += 1;
      console.error(`[branch-conflict-readmit] ${task && task.id || name}: ${e.message}`);
    }
  }

  if (summary.mode !== 'off') writeJson(statePath, nextState);
  if (drained) {
    if (missedMerges.length) {
      try { queueEvents.recordCorrection(pipelineDir, CONSUMER, missedMerges.length, { fs: fsImpl }); summary.journal.corrections = missedMerges.length; } catch { /* the counter is best effort */ }
    }
    if (summary.errors === 0 && !holdCommit) {
      drained.commit();
      if (fullScan) {
        try { fsImpl.mkdirSync(path.dirname(scanStatePath(pipelineDir)), { recursive: true }); fsImpl.writeFileSync(scanStatePath(pipelineDir), JSON.stringify({ at: now })); } catch { /* best effort */ }
      }
    }
  }
  return summary;
}

module.exports = { sweepBranchConflicts, appliedBranch, eligibleTask, conflictWithMain, priorVerdictFor, SETTLE_MS, MAX_ATTEMPTS, STATE_FILE };

if (require.main === module) {
  const { getConfig } = require('./config.js');
  const { detectDefaultBranch } = require('./git-runner.js');
  const cfg = getConfig();
  const dryRun = process.argv.includes('--dry-run');
  sweepBranchConflicts({ pipelineDir: cfg.pipelineDir, repoRoot: cfg.repoRoot, mainBranch: detectDefaultBranch(cfg.repoRoot), dryRun }).then((s) => {
    const ids = (a) => (a.length ? ` [${a.map((x) => x.id).join(', ')}]` : '');
    process.stdout.write(`mode=${s.mode} checked=${s.checked} observed=${s.observed.length} settling=${s.settling.length} requeued=${s.requeued.length}${ids(s.requeued)} exhausted=${s.exhausted.length}${ids(s.exhausted)} cleared=${s.cleared.length} errors=${s.errors} superseded=${superseded}${dryRun ? ' (dry run)' : ''}\n`);
  }).catch((e) => { console.error('[branch-conflict-readmit]', (e && e.stack) || e); process.exit(1); });
}
