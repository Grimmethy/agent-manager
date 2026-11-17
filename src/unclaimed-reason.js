'use strict';

/**
 * Determine the first blocking reason why a task is unclaimed.
 *
 * Pure function: no I/O, no clock. Reads only the `task` record and a
 * pre-computed `poolState` object built by the claim evaluator (subtask 3).
 *
 * Order of checks mirrors the claim gates in src/task-sources.js
 * (nextAdhocLikeTask): dependency gate first (covers dependsOn,
 * unmetPrerequisiteHubs, softDependsOn -- all of which require the
 * dependency to be in queue/done/ to count as satisfied), then lane
 * eligibility, then IO hold, then paused, then premium ordering.
 *
 * Returns {code, text} for the first blocking rule, or null when the
 * task is claimed or claimable (no blocking rules).
 *
 * @param {object} task - The task record.
 * @param {object} poolState - Pre-computed claim evaluation state.
 * @returns {{code: string, text: string}|null}
 */
function reasonFor(task, poolState) {
  if (!poolState) return null;

  // Already claimed -- no unclaimed reason to report
  if (poolState.claimed) return null;

  // 1. Dependency gate: any of dependsOn / unmetPrerequisiteHubs /
  //    softDependsOn unmet. The merge requirement means "applied but
  //    not merged" is treated as unmerged (isDependencySatisfied checks
  //    queue/done/<id>.json; isSoftDependencySatisfied checks the same
  //    location but without the stacked-branch exemption).
  if (poolState.dependencyUnmet) {
    return {
      code: 'dependency-unmerged',
      text: 'Blocked by unmerged dependency',
    };
  }

  // 2. Lane eligibility: hub sibling holds or source not in allowlist
  if (poolState.laneNotAllowed) {
    return {
      code: 'lane-not-allowed',
      text: 'Lane not allowed for this task',
    };
  }

  // 3. IO hold: derived-gate or similar IO-bound hold
  if (poolState.ioHeld) {
    return {
      code: 'io-hold',
      text: 'Held by IO operation',
    };
  }

  // 4. Paused: task explicitly paused by coordinator
  if (poolState.paused) {
    return {
      code: 'paused',
      text: 'Task is paused',
    };
  }

  // 5. Premium ordering: task rotated behind higher-priority premium work
  if (poolState.premiumRotating) {
    return {
      code: 'premium-ordering',
      text: 'Rotated for premium priority ordering',
    };
  }

  // No blocking rules -- task is claimable
  return null;
}

module.exports = { reasonFor };
