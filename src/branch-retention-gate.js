'use strict';

// Branch retention gate for the pipeline's done transition.
//
// retentionVerdict() classifies a task's branch as:
//   'unknown'  -- no branch association (or the check itself failed): do not guess;
//   'merged'   -- the branch is an ancestor of master, so the work is already recoverable;
//   'unmerged' -- the branch exists and is not on master: abandoning it loses paid-for work.
//
// The only I/O is one read-only `git merge-base --is-ancestor` call, made only when the
// verdict is requested. No timers, no polling, no model calls.
//
// OPEN ITEM (human decision, not wired): the module that performs the `done` transition is not
// yet identified. Wiring is: call retentionVerdict there and route only 'unmerged' to a
// retain-or-discard decision before the done-stage model spend. Until then this module is standalone.

const { execFileSync } = require('child_process');

// -> (branch) => boolean. Exit status 1 from git means "not an ancestor"; any other failure throws
// so retentionVerdict can fail open to 'unknown'.
function defaultIsOnMaster(repoRoot) {
  return (branch) => {
    try {
      execFileSync('git', ['-C', repoRoot, 'merge-base', '--is-ancestor', branch, 'master'], {
        stdio: 'ignore',
        timeout: 15_000,
      });
      return true;
    } catch (err) {
      if (err && err.status === 1) return false;
      throw err;
    }
  };
}

// -> 'merged' | 'unmerged' | 'unknown'
function retentionVerdict({ branch, repoRoot, isOnMaster } = {}) {
  if (typeof branch !== 'string' || !branch.trim()) return 'unknown';
  const check = typeof isOnMaster === 'function'
    ? isOnMaster
    : (repoRoot ? defaultIsOnMaster(repoRoot) : null);
  if (!check) return 'unknown';
  try {
    return check(branch.trim()) ? 'merged' : 'unmerged';
  } catch {
    return 'unknown';
  }
}

module.exports = { retentionVerdict };
