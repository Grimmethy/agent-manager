'use strict';

// Swap point for "how does applyTask() prepare/select the git branch for this apply" (S5b
// of the hub-tasks extraction, 2026-09-25). Extracted from apply-task.js's own inline
// stacked-branch handling, which stays here as the default (real, always-installed)
// implementation -- unlike S4b's producer hooks, there is no "unregistered" state: every
// apply needs a branch prepared, so this is the same "default IS the real behavior, just
// overridable" shape hub-apply-routing.js (S2) already uses.
//
// gitRunner itself stays in core (git-runner.js) regardless of where the hub kernel ends
// up (S5e) -- a future override still reaches it the normal plugin-depends-on-core way.

// Exactly today's inline logic from apply-task.js's applyTask(), unchanged.
function prepareApplyBranch(task, { gitRunner, commitsDirectlyToMain }) {
  // Stacked file-decompose child (file-decompose-to-hub.js `mode: 'stacked'`): every
  // move + the wiring step commits onto ONE shared branch, in sequence. Step 1 creates
  // it off main; step N>1 rides on top of what step N-1 committed -- so it must NOT
  // resetToMain() (that would throw the prior steps away). isDependencySatisfied() has
  // already confirmed step N-1 reached queue/done/ before this task was claimed.
  const stacked = task.stacked && task.stacked.branch && !commitsDirectlyToMain ? task.stacked : null;
  if (stacked) {
    const b = stacked.branch;
    // seq 1 normally CREATES the branch off main -- but only if origin has no unmerged work on it. A hub whose seq numbering restarted
    // inside a chain that already pushed earlier steps (or a retry after step 1's own push) must ride on that work, not delete it.
    if (stacked.seq > 1 || gitRunner.remoteHasUnmergedWork(b)) {
      // 2026-09-08, Grimmethy: "harden it properly with tests" -- root-caused live: the
      // old branchExists(b) check here was LOCAL-only, so a stale local branch with the
      // same name (origin's real copy long since merged and deleted) made every apply
      // attempt check out ancient history and fail to apply a diff computed against
      // current main -- identically, every retry, never self-correcting. See
      // git-runner.js's prepareStackedBranch for the full ahead/behind/diverged
      // reasoning (same discipline resetToMain() already applies to mainBranch itself).
      // Pre-flight (2026-09-24, same fix as the triage batch's, lib/apply-main-batch.js): prepareStackedBranch's `checkout -B` / `rebase`
      // abort on a dirty tracked file, and resetToMain() -- the only other thing here that clears stray content -- is deliberately NOT
      // called on this path. Self-heal a dedicated apply clone (quarantine to a patch under .git/), else fail once with a clear message.
      if (typeof gitRunner.quarantineDirtyTree === 'function') gitRunner.quarantineDirtyTree();
      if (typeof gitRunner.assertCleanTree === 'function') gitRunner.assertCleanTree();
      gitRunner.prepareStackedBranch(b);
    } else {
      gitRunner.resetToMain();
      try { gitRunner.deleteBranch(b); } catch (_) { /* no stale branch */ }
      gitRunner.createBranch(b);
    }
  } else {
    gitRunner.resetToMain();
  }

  const branchName = commitsDirectlyToMain ? null : (stacked ? stacked.branch : `agent/${task.id}`);
  return { branchName, stacked };
}

const DEFAULT_APPLY_BRANCH_PREP = { prepareApplyBranch };

let current = DEFAULT_APPLY_BRANCH_PREP;

function getApplyBranchPrep() {
  return current;
}

// A single swap point, not a registry -- there is exactly one apply-branch-prep
// implementation live at a time, same reasoning as hub-apply-routing.js. Passing no
// argument (or a falsy value) restores the default; used by tests to reset state between
// runs since this module is a singleton for the life of the process.
function setApplyBranchPrep(impl) {
  current = impl || DEFAULT_APPLY_BRANCH_PREP;
}

module.exports = {
  prepareApplyBranch,
  DEFAULT_APPLY_BRANCH_PREP,
  getApplyBranchPrep,
  setApplyBranchPrep,
};
