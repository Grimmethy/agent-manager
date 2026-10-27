'use strict';

// hub-branch-redraft-sweep.js -- a watchdog sweep that finds unmerged hub/stacked
// branches with a current chat/manual needs-work verdict and queues a single
// non-stacked redraft task for the whole hub branch.
//
// Why (2026-10-24, TaxHarvest follow-up): 61 of the 82 chat/manual needs-work
// branches in Unmerged Branches were hub children. The reviewer's reasons sit on
// the child task as priorVerdict, but nothing requeues the hub for a redraft --
// the hub's branch just sits until a human notices. This sweep mirrors
// branch-defect-readmit-sweep.js's pattern: iterate done tasks, filter for
// eligibility, check settle time, queue one non-stacked adhoc task that carries
// the verdict reasons verbatim plus the hub label, piece titles, diff stat, and
// the branch diff as reference.
//
// Scope, deliberately narrow (the same limits as the conflict/defect sweeps):
//   - only a task in done/ with terminalDisposition 'pending-merge' that is a
//     hub child (hubId/parentHub set) or stacked (stacked field present);
//     never a human-prioritised task;
//   - only a verdict that is current: priorVerdict.verdict 'needs-work',
//     source 'chat' or 'manual', not kind 'main-moved', and priorVerdict.sha
//     equal to the branch's CURRENT origin head. A verdict for an older commit
//     is stale (the branch moved) and is ignored;
//   - the same verdict on the same head must be seen on two runs at least
//     SETTLE_MS apart (a merge, apply or re-verification may be in flight);
//   - ONE redraft per branch. The count is the number of 'hub-branch-redraft'
//     events in the HUB's history, NOT a field on priorVerdict: a later chat
//     verdict replaces priorVerdict wholesale and would reset a counter kept
//     there. A hub that was already redrafted once and is needs-work again is
//     left in place and reported as `exhausted`;
//   - never deletes the old branch; marks it a discard candidate only after
//     the replacement merges (the queued task's prompt says so).
//
// AGENT_MANAGER_HUB_REDAFT=off|dry-run|on (default dry-run: records what it saw
// in the state file and the summary, changes no task and no branch).
// CLI: node hub-branch-redraft-sweep.js [--dry-run]

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { queueAdhocTask } = require('./queue-adhoc-task.js');
const { liveSiblingsOnBranch, bare } = require('./lib/shared-branch.js');
const { priorVerdictBlock } = require('./lib/prompt-blocks.js');

const SETTLE_MS = 10 * 60 * 1000;
const MAX_REDAFTS = 1;
const STATE_FILE = '.hub-branch-redraft-state.json';
const STAGE = 'hub-branch-redraft';
const REASON_CHARS = 160;
const INLINE_DIFF_BYTES = 8000; // inline the diff when smaller than this

function mode() {
  const v = String(process.env.AGENT_MANAGER_HUB_REDAFT || 'dry-run').toLowerCase();
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

// Hub children, stacked tasks and human-prioritised tasks are candidates; the
// hub lookup below further narrows to ones that actually belong to a hub.
function eligibleTask(task) {
  if (!task || task.terminalDisposition !== 'pending-merge') return false;
  // Must be a hub child (hubId/parentHub) or stacked.
  if (!task.hubId && !task.parentHub && !task.stacked) return false;
  if (task.humanQueued || task.premiumPriority || task.pinnedWorker) return false;
  return true;
}

// The task's priorVerdict when it is a chat/manual needs-work verdict from a
// person, else null. Mirrors defectVerdict() in branch-defect-readmit-sweep.js.
function needsWorkVerdict(task) {
  const pv = task && task.promptContext && typeof task.promptContext === 'object' ? task.promptContext.priorVerdict : null;
  if (!pv || typeof pv !== 'object' || pv.verdict !== 'needs-work' || pv.kind === 'main-moved') return null;
  if (pv.source !== 'chat' && pv.source !== 'manual') return null;
  if (typeof pv.sha !== 'string' || !pv.sha) return null;
  return Array.isArray(pv.reasons) && pv.reasons.some((r) => typeof r === 'string' && r.trim()) ? pv : null;
}

// How many times this HUB was already sent back by this sweep. The count lives
// on the hub's history (not priorVerdict) because a later verdict replaces
// priorVerdict wholesale and would reset a counter kept there.
function countRedrafts(hubHistory) {
  return (Array.isArray(hubHistory) ? hubHistory : []).filter((e) => e && e.stage === STAGE).length;
}

// The hub record that owns a task, if any. Hub children carry hubId or parentHub;
// we resolve it by looking up the hub by id in coordinating/done/_superseded.
function hubForTask(task, pipelineDir) {
  const hubId = task.hubId || task.parentHub;
  if (!hubId) return null;
  const candidates = [
    { dir: 'coordinating', state: 'coordinating' },
    { dir: path.join('done', '_superseded'), state: 'superseded' },
    { dir: 'done', state: 'done' },
  ];
  for (const { dir, state } of candidates) {
    const p = path.join(pipelineDir, 'queue', dir, `${hubId}.json`);
    const rec = readJson(p);
    if (rec && rec.id === hubId) return { record: rec, state };
  }
  return null;
}

// { pipelineDir, repoRoot, mainBranch?, now?, dryRun?, git?, queue?, fetch?, modeOverride?, project? } -> Promise<summary>
//
// pipelineDir / repoRoot -- the pipeline and repo to operate on.
// mainBranch -- the integration branch (default 'master').
// now -- current time (for deterministic tests).
// dryRun -- if true, mode is forced to dry-run regardless of env.
// git -- git shim (defaultGit).
// queue -- queueAdhocTask shim (for tests).
// fetch -- whether to fetch origin first (default true).
// modeOverride -- override the env-derived mode (for tests).
// project -- the registered project to file the adhoc task in (mirrors
//   routes/branch_verdicts.py's branch_projects.resolve_scope /
//   find_other_project_branch resolution; null = auto-detect from the hub's
//   repoRoot when possible, else the sweep's own repoRoot).
//
// Returns { redrafted, events: Array<{hubId, taskId, verdictId}>, checked,
//   observed, settling, stale, exhausted, errors, mode }.
async function runSweep({
  pipelineDir, repoRoot, mainBranch = 'master', now = Date.now(), dryRun = false,
  git = defaultGit, queue = queueAdhocTask, fetch = true, modeOverride = null, project = null,
} = {}) {
  const summary = {
    mode: modeOverride || mode(),
    checked: 0,
    observed: [],
    settling: [],
    stale: [],
    exhausted: [],
    redrafted: 0,
    events: [],
    errors: 0,
  };
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
    if (!eligibleTask(task)) continue;
    const pv = needsWorkVerdict(task);
    if (!pv) continue;
    const branch = appliedBranch(task);
    if (!branch) continue;
    try {
      const head = git(repoRoot, ['rev-parse', '--verify', `origin/${branch}`]);
      if (head.code !== 0) continue;                       // branch gone: reconcile's business, not ours
      const sha = String(head.out).trim();

      summary.checked += 1;
      if (pv.sha !== sha) { summary.stale.push({ id: task.id, branch }); continue; }   // the verdict is for an older commit

      const hub = hubForTask(task, pipelineDir);
      if (!hub) continue;   // not actually a hub child (parentHub set but hub not found)

      // Never touch a branch another live task sits on.
      const shared = liveSiblingsOnBranch({ pipelineDir, branch, selfId: task.id });
      if (shared.error || shared.siblings.length) continue;

      // ONE redraft per hub.
      if (countRedrafts(hub.record.history) >= MAX_REDAFTS) { summary.exhausted.push({ id: task.id, branch, hubId: hub.record.id }); continue; }

      const prev = state[branch];
      const same = prev && prev.sha === sha && prev.verdictAt === pv.at;
      const firstSeenAt = same ? prev.firstSeenAt : nowIso;
      nextState[branch] = { sha, verdictAt: pv.at, firstSeenAt, taskId: task.id, hubId: hub.record.id };
      if (!same) { summary.observed.push({ id: task.id, branch, hubId: hub.record.id }); continue; }
      if (now - Date.parse(firstSeenAt) < SETTLE_MS) { summary.settling.push({ id: task.id, branch }); continue; }

      // merge-tree --write-tree to confirm the branch still diverges from main
      // and to collect any conflict files for the prompt (informational only;
      // we queue the redraft regardless -- the reviewer already judged it
      // defective, not just conflicted).
      const merge = git(repoRoot, ['merge-tree', '--write-tree', '--name-only', `origin/${mainBranch}`, `origin/${branch}`]);
      const conflictFiles = merge.code === 1
        ? String(merge.out).split('\n').slice(1).filter(Boolean).map((l) => l.trim()).filter((l) => l !== '')
        : [];

      // Diff stat + diff for the prompt.
      const stat = git(repoRoot, ['diff', '--stat', `origin/${mainBranch}..origin/${branch}`]);
      const diff = git(repoRoot, ['diff', `origin/${mainBranch}..origin/${branch}`]);

      // Piece titles from the hub's subTasks.
      const subTasks = Array.isArray(hub.record.subTasks) ? hub.record.subTasks : [];
      const pieceTitles = subTasks.map((st) => st.title || st.id || '').filter(Boolean);

      const hubLabel = hub.record.label || hub.record.title || hub.record.id;
      const reasons = Array.isArray(pv.reasons) ? pv.reasons : [];

      // Build the prompt context the redraft task will receive.
      const promptContext = {
        rawText: [
          `Hub redraft: ${hubLabel} (${hub.record.id})`,
          '',
          `Branch: ${branch}`,
          `Pieces: ${pieceTitles.length ? pieceTitles.join(', ') : '(no piece titles)'}`,
          '',
          `Diff stat:\n${(stat.out || '').trim() || '(no diff)'}`,
          '',
          conflictFiles.length
            ? `Conflicts with ${mainBranch}: ${conflictFiles.join(', ')}`
            : `Merges cleanly with ${mainBranch}.`,
          '',
          `Verdict reasons (verbatim from ${pv.source} review):`,
          ...reasons.map((r, i) => `${i + 1}. ${String(r).slice(0, REASON_CHARS)}`),
          '',
          diff.out && diff.out.length <= INLINE_DIFF_BYTES
            ? `Branch diff:\n${diff.out}`
            : `Branch diff: (${diff.out.length} bytes -- too large to inline; see git diff origin/${mainBranch}..origin/${branch} in the repo)`,
          '',
          'Instructions: FIRST read the current code at the changed files. Redo the change against current master, incorporating every reason above. Never delete the old branch; it will be discarded after the replacement merges.',
        ].join('\n'),
        priorVerdict: {
          verdict: 'needs-work',
          kind: 'hub-branch-redraft',
          reasons: reasons.map((r) => String(r).slice(0, 1500)),
          sha: pv.sha,
          at: pv.at,
          source: 'sweep',
          branch,
          hubId: hub.record.id,
          hubLabel,
        },
      };

      const entry = { id: task.id, branch, hubId: hub.record.id, verdictId: pv.sha };

      if (!live) {
        summary.redrafted += 1;
        summary.events.push({ hubId: hub.record.id, taskId: task.id, verdictId: pv.sha });
        summary.observed.push({ ...entry, dryRun: true });
        continue;
      }

      // Record the event on the HUB record.
      hub.record.history = Array.isArray(hub.record.history) ? hub.record.history : [];
      hub.record.history.push({
        stage: STAGE,
        at: nowIso,
        detail: `${branch} had a needs-work verdict (${String(reasons[0] || '').slice(0, REASON_CHARS)}); queued a non-stacked redraft task for the whole hub`,
      });
      writeJson(path.join(queueDir, hub.state, `${hub.record.id}.json`), hub.record);

      // Record the event on the task (the "verdict card" -- same stage shape
      // as branch_verdicts.write_task_log's branch-verdict stage).
      task.history = Array.isArray(task.history) ? task.history : [];
      task.history.push({
        stage: STAGE,
        at: nowIso,
        detail: `${branch} had a needs-work verdict (${String(reasons[0] || '').slice(0, REASON_CHARS)}); queued a non-stacked redraft task for the whole hub`,
      });
      writeJson(filePath, task);

      // Resolve the project the way routes/branch_verdicts.py does: prefer
      // the hub's own project scope if known, else fall back to the sweep's
      // repoRoot. The queueAdhocTask project field is informational -- it
      // routes the adhoc task into the right project's queue.
      const resolvedProject = project || (hub.record.project && hub.record.project !== repoRoot ? hub.record.project : null);

      const res = await queue(
        {
          title: `Redraft hub ${hub.record.id}: ${hubLabel}`,
          promptContext,
          ...(resolvedProject ? { project: resolvedProject } : {}),
        },
        { pipelineDir, domainsPath: path.join(pipelineDir, 'queue', 'task-domains.json') },
      );
      if (!res || !res.filePath) {
        summary.errors += 1;
        console.error(`[hub-branch-redraft] ${task.id}: queue failed: ${res && res.error}`);
        continue;
      }

      delete nextState[branch];
      summary.redrafted += 1;
      summary.events.push({ hubId: hub.record.id, taskId: task.id, verdictId: pv.sha });
      summary.observed.push(entry);
    } catch (e) {
      summary.errors += 1;
      console.error(`[hub-branch-redraft] ${task && task.id || name}: ${e.message}`);
    }
  }

  writeJson(statePath, nextState);
  return summary;
}

module.exports = { runSweep, needsWorkVerdict, countRedrafts, hubForTask, appliedBranch, eligibleTask, SETTLE_MS, MAX_REDAFTS, STATE_FILE, STAGE };

if (require.main === module) {
  const { getConfig } = require('./config.js');
  const { detectDefaultBranch } = require('./git-runner.js');
  const cfg = getConfig();
  const dryRun = process.argv.includes('--dry-run');
  runSweep({ pipelineDir: cfg.pipelineDir, repoRoot: cfg.repoRoot, mainBranch: detectDefaultBranch(cfg.repoRoot), dryRun }).then((s) => {
    const ids = (a) => (a.length ? ` [${a.map((x) => x.id).join(', ')}]` : '');
    process.stdout.write(`mode=${s.mode} checked=${s.checked} observed=${s.observed.length} settling=${s.settling.length} stale=${s.stale.length} exhausted=${s.exhausted.length}${ids(s.exhausted)} redrafted=${s.redrafted}${ids(s.events)} errors=${s.errors}${dryRun ? ' (dry run)' : ''}\n`);
  }).catch((e) => { console.error('[hub-branch-redraft]', (e && e.stack) || e); process.exit(1); });
}
