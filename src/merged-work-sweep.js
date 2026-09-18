'use strict';

// Wires verify-merged-work.js (built 2026-09-16, never wired into anything -- see
// bd-1789597197678) into a periodic watchdog sweep, following this codebase's own
// established convention (proactive-file-decompose-sweep.js's isDue/markChecked
// schedule-file pattern, adhoc-staleness-flag.js's watchdog shape).
//
// What it does: queue/done/ tasks whose history claims terminalDisposition:'merged' embed
// the landing commit's short SHA in that history event's own detail string (see
// apply-main-batch.js's own 'on <branch> @ <sha> (commit-trailer)' format). A SHA that is
// NOT a `git merge-base --is-ancestor` of current master/main is CHEAP to detect and is
// exactly the situation that once (wrongly, and once correctly) looked like lost work --
// see verify-merged-work.js's own header for both real 2026-09-16 incidents. This sweep
// runs that cheap ancestor check first (skips the vast majority of done tasks instantly,
// since most really are plain ancestors), then for the ones that fail it, runs
// verify-merged-work.js's real content-based check against the task's own stored rawDiff.
// Only a 'missing' or low-ratio 'partial' verdict is surfaced -- a 'present' verdict on an
// ancestor-check failure just means an unrelated refactor moved the content, not that
// anything was lost (the exact false-positive this session's own manual investigation
// hit), and is silently marked checked, never surfaced.
//
// Findings are filed through the EXISTING side-finding inbox (side-finding.js's
// writeSideFindingInbox -- the same race-free, best-effort, no-shared-file channel any
// model call already uses), so this needs no new filing/dedup machinery: side-finding-
// sweep.js already drains the inbox into brain-dump.json with its own Jaccard dedup.
//
// Deliberately a REPORTING sweep only (matches verify-merged-work.js's own "never an
// auto-action" contract) -- it never reverts, re-queues, or touches a task's own record
// beyond the schedule file's checked-id set (so the same done task is never re-verified,
// and a finding is never filed twice for it).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { verifyMergedWorkPresent } = require('./verify-merged-work.js');
const { writeSideFindingInbox } = require('./side-finding.js');
const { GIT_ENV, GIT_TIMEOUT_MS } = require('./agentic-draft-common.js');

const CHECK_INTERVAL_MS = (() => {
  const v = process.env.AGENT_MANAGER_MERGED_WORK_SWEEP_INTERVAL_MS;
  return v === undefined ? 5 * 60 * 1000 : Number(v);
})();
// Small per-tick cap -- each candidate can spend a git-grep-per-missing-line budget
// (verify-merged-work.js's own MAX_GREP_CALLS_PER_FILE), so this stays modest even though
// the ancestor pre-filter already screens out most of queue/done/ for free.
const MAX_CANDIDATES_PER_RUN = (() => {
  const v = process.env.AGENT_MANAGER_MERGED_WORK_SWEEP_BATCH;
  return v === undefined ? 25 : Number(v);
})();
const MAX_FINDINGS_PER_RUN = 5;

const MERGED_SHA_RE = /@\s*([0-9a-f]{6,40})\b/;

function statePath(instancesDir) {
  return path.join(instancesDir, '.merged-work-sweep-state.json');
}

function loadState(instancesDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(instancesDir), 'utf8'));
    return { lastCheckedAt: raw.lastCheckedAt || null, checkedIds: Array.isArray(raw.checkedIds) ? raw.checkedIds : [] };
  } catch {
    return { lastCheckedAt: null, checkedIds: [] };
  }
}

function saveState(instancesDir, state) {
  fs.mkdirSync(instancesDir, { recursive: true });
  fs.writeFileSync(statePath(instancesDir), JSON.stringify(state, null, 2));
}

function isDue(instancesDir, now = new Date()) {
  const { lastCheckedAt } = loadState(instancesDir);
  if (!lastCheckedAt) return true;
  return now.getTime() - new Date(lastCheckedAt).getTime() >= CHECK_INTERVAL_MS;
}

// Finds the most recent 'merged' history event's embedded SHA, or null if the task never
// recorded one this way (nothing cheap to check -- treated as checked/no-finding, not an
// error: an unparseable-but-genuinely-fine history event must never be reported as loss).
function extractMergedSha(task) {
  const history = Array.isArray(task.history) ? task.history : [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const ev = history[i];
    if (ev && ev.stage === 'merged' && typeof ev.detail === 'string') {
      const m = MERGED_SHA_RE.exec(ev.detail);
      if (m) return m[1];
    }
  }
  return null;
}

function isAncestorOfMain(repoRoot, sha) {
  for (const candidate of ['main', 'master']) {
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', sha, candidate], {
        cwd: repoRoot, env: GIT_ENV, timeout: GIT_TIMEOUT_MS, stdio: 'pipe',
      });
      return true;
    } catch { /* not an ancestor of this candidate -- try the other, then give up */ }
  }
  return false;
}

function listMergedDoneTasks(pipelineDir) {
  const doneDir = path.join(pipelineDir, 'queue', 'done');
  let names;
  try {
    names = fs.readdirSync(doneDir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    let task;
    try {
      task = JSON.parse(fs.readFileSync(path.join(doneDir, name), 'utf8'));
    } catch {
      continue; // unreadable/corrupt -- not this sweep's problem
    }
    if (task && task.terminalDisposition === 'merged' && task.id) out.push(task);
  }
  return out;
}

function sweep({ pipelineDir, repoRoot, instancesDir = path.join(pipelineDir, 'instances'), now = new Date() } = {}) {
  const state = loadState(instancesDir);
  const checkedIds = new Set(state.checkedIds);
  const summary = {
    scanned: 0, ancestorSkipped: 0, noShaSkipped: 0, contentChecked: 0, present: 0, flagged: 0, errors: 0,
  };

  const candidates = listMergedDoneTasks(pipelineDir).filter((t) => !checkedIds.has(t.id));
  const batch = candidates.slice(0, MAX_CANDIDATES_PER_RUN);

  for (const task of batch) {
    summary.scanned += 1;
    try {
      const sha = extractMergedSha(task);
      if (!sha) {
        summary.noShaSkipped += 1;
        checkedIds.add(task.id);
        continue;
      }
      if (isAncestorOfMain(repoRoot, sha)) {
        summary.ancestorSkipped += 1;
        checkedIds.add(task.id);
        continue;
      }

      summary.contentChecked += 1;
      const result = verifyMergedWorkPresent(task, repoRoot);
      checkedIds.add(task.id);

      if (result.verdict === 'present' || result.verdict === 'unknown') {
        summary.present += 1;
        continue;
      }
      // 'missing', or 'partial' below verify-merged-work.js's own 0.8 'present' floor --
      // both are worth a human/agent look, matching the brain-dump note's own "low-ratio
      // partial" wording.
      if (summary.flagged >= MAX_FINDINGS_PER_RUN) continue;
      summary.flagged += 1;
      const missingFiles = result.files.filter((f) => f.checked && f.foundCount < f.meaningfulLineCount).map((f) => f.path);
      writeSideFindingInbox({
        title: `Merged task's commit isn't on master and its content verdict is '${result.verdict}': ${task.id}`,
        body: `terminalDisposition:'merged' but SHA ${sha} is not a merge-base ancestor of main/master, and verify-merged-work.js's content check found verdict='${result.verdict}' (ratio=${result.ratio === null ? 'n/a' : result.ratio.toFixed(2)}, ${result.totalFoundLines}/${result.totalMeaningfulLines} added lines still findable). Files not fully accounted for: ${missingFiles.slice(0, 5).join(', ') || '(see files[])'}. Worth a human or agent look to confirm whether this is a real lost-work incident or content that moved during an unrelated refactor -- see verify-merged-work.js's own header for both real cases this told apart.`,
      }, { source: 'merged_work_sweep', taskId: task.id, stage: 'sweep', pipelineDir });
    } catch (e) {
      summary.errors += 1;
      checkedIds.add(task.id); // don't retry a task whose own record keeps throwing
      console.error(`[merged-work-sweep] ${task && task.id}: ${e && e.message}`);
    }
  }

  saveState(instancesDir, { lastCheckedAt: now.toISOString(), checkedIds: Array.from(checkedIds) });
  summary.remaining = Math.max(0, candidates.length - batch.length);
  return summary;
}

module.exports = {
  sweep, isDue, extractMergedSha, isAncestorOfMain, listMergedDoneTasks,
  CHECK_INTERVAL_MS, MAX_CANDIDATES_PER_RUN,
};

if (require.main === module) {
  const { getConfig } = require('./config.js');
  const { pipelineDir, repoRoot } = getConfig();
  const instancesDir = path.join(pipelineDir, 'instances');
  if (!isDue(instancesDir)) {
    console.log('merged-work-sweep: not due yet');
  } else {
    const s = sweep({ pipelineDir, repoRoot, instancesDir });
    console.log(`merged-work-sweep: ${JSON.stringify(s)}`);
  }
}
