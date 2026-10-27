'use strict';

// shared-branch-restore.js -- put a hub sibling back that another task's requeue destroyed.
//
// 2026-10-08 (TaxHarvest): requeueing HUB0022-01 deleted the hub's shared branch and with it HUB0018-01's approved, unmerged StartPage commit; reconcile
// recorded HUB0018-01 "abandoned: work lost" and nothing ever restored it, so HUB0022's App.tsx half sat on a branch whose StartPage half was gone.
// The requeue paths no longer delete a shared branch (lib/shared-branch.js); this is the paired repair for the one that already happened.
//
// A record qualifies when ALL hold (every one deterministic, no model):
//   * it is stacked on a branch (record.stacked.branch) and still carries its approved rawDiff;
//   * the branch-removal ledger says that branch was removed by a requeue of a DIFFERENT task, after this task was applied;
//   * the branch exists on origin again and is ahead of <main> (another sibling's redraft recreated it);
//   * this task's change is on neither that branch (no `Task: <id> (` trailer and < half its distinctive lines) nor <main> (stackedSiblingLost).
// The restore re-uses the no-redraft re-apply path (apply-retry-check.js): clear the terminal state, `status: approved`, write to approved/, and the apply
// loop re-applies the already-reviewed diff onto the branch. Once per task (sharedBranchRestored). The human merge gate is unchanged.
// Kill switch: AGENT_MANAGER_SHARED_BRANCH_RESTORE=false.

const fs = require('fs');
const path = require('path');
const { lastRemoval } = require('./branch-removal-ledger.js');
const { stackedSiblingLost, realGit } = require('./task-disposition.js');
const { appendHistoryEvent } = require('./task-history.js');
const { SCAN_DIRS, bare } = require('./lib/shared-branch.js');

const restoreEnabled = (env = process.env) => String(env.AGENT_MANAGER_SHARED_BRANCH_RESTORE || '').trim().toLowerCase() !== 'false';

function activeCopyExists(pipelineDir, id) {
  for (const state of SCAN_DIRS) {
    if (state === 'done') continue;
    if (fs.existsSync(path.join(pipelineDir, 'queue', state, `${id}.json`))) return true;
  }
  return false;
}

const appliedAt = (record) => {
  const evs = (record.history || []).filter((h) => h && h.stage === 'applied');
  return evs.length ? Date.parse(evs[evs.length - 1].at) || 0 : 0;
};

// -> { restore: true, branch, removedBy } | { restore: false, reason }
function shouldRestore(record, { pipelineDir, repoRoot, mainBranch, git = realGit }) {
  const no = (reason) => ({ restore: false, reason });
  if (!record || !record.id) return no('no record');
  if (record.sharedBranchRestored) return no('already restored once');
  const branch = record.stacked && record.stacked.branch ? bare(record.stacked.branch) : null;
  if (!branch) return no('not stacked');
  if (typeof record.rawDiff !== 'string' || !record.rawDiff) return no('no stored diff');
  const removal = lastRemoval(pipelineDir, branch);
  if (!removal || removal.cause !== 'superseded-by-requeue') return no('branch was not removed by a requeue');
  if (!removal.taskId || removal.taskId === record.id) return no("the branch was removed by this task's own requeue");
  if (Date.parse(removal.at) && Date.parse(removal.at) < appliedAt(record)) return no('the removal predates this task\'s apply');
  if (!git(repoRoot, ['rev-parse', '--verify', '--quiet', `origin/${branch}`])) return no('the shared branch does not exist on origin');
  const ahead = Number(git(repoRoot, ['rev-list', '--count', `origin/${mainBranch}..origin/${branch}`])) || 0;
  if (ahead <= 0) return no('the shared branch is not ahead of main');
  const lost = stackedSiblingLost(git, repoRoot, mainBranch, branch, record);
  if (!lost) return no('this task\'s change is carried by the branch, or there is not enough evidence to call it lost');
  if (lost.onMain) return no(`the change is already on ${mainBranch}`);
  return { restore: true, branch, removedBy: removal.taskId };
}

// Moves the record from done/ to approved/ for a no-redraft re-apply. Returns true when written.
function restoreRecord(record, decision, { pipelineDir, doneFile, now = new Date() }) {
  if (activeCopyExists(pipelineDir, record.id)) return false;
  const dest = path.join(pipelineDir, 'queue', 'approved', `${record.id}.json`);
  if (fs.existsSync(dest)) return false;
  appendHistoryEvent(record, 'approved',
    `shared-branch-restore: its approved commit was destroyed when ${decision.removedBy} was requeued (that requeue deleted the shared branch ${decision.branch}); re-applying the already-reviewed diff, no redraft`);
  delete record.terminalDisposition;
  delete record.blockedReason;
  delete record.blockedStage;
  record.status = 'approved';
  record.sharedBranchRestored = { at: now.toISOString(), branch: decision.branch, removedBy: decision.removedBy };
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(record, null, 2));
  fs.unlinkSync(doneFile);
  return true;
}

module.exports = { shouldRestore, restoreRecord, restoreEnabled, activeCopyExists };
