'use strict';

const fs = require('fs');
const path = require('path');

// Extracted from scripts/local-worker.sh's inline claim-ranking script (the 2026-08-22
// priority+mtime fix) plus its separate per-item reasoningTierFor() filter -- both now
// live in one tested module instead of two untested `node -e` blocks in the shell
// script. See local-worker.sh's own comments for why priority+mtime ordering and the
// tier split exist; this module adds the operator "assign this task to this worker"
// override on top (2026-09-06, Grimmethy: "I need to be able to select the task I want
// each worker to run... this should override the automated system").
//
// `pinnedWorker` on a pending task's JSON, when present, is an explicit operator
// assignment (stamped by the dashboard's POST /api/instances/<id>/assign-task route):
// a task pinned to THIS instance always wins, skipping the tier filter and priority
// sort entirely (that's the override); a task pinned to ANY OTHER instance is excluded
// from this instance's candidate list so a faster-polling lane can't steal it first.

function readTaskSafe(fullPath) {
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(fullPath).mtimeMs; } catch (_) { /* file vanished mid-scan */ }
  let task = null;
  try { task = JSON.parse(fs.readFileSync(fullPath, 'utf8')); } catch (_) { /* corrupt/partial write -- still listed, worst priority, matching prior behavior */ }
  return { task, mtimeMs };
}

// Returns every filename in pendingDir this instance may claim, in claim-attempt order:
// tasks pinned to this instance first (oldest first), then everything else ranked by
// resolved source priority ascending, then mtime ascending. The caller
// (local-worker.sh) iterates this list attempting an atomic claim (mv -n) on each in
// turn, same as it did with the old inline script's output.
function pickClaimableTasks(pendingDir, instanceId, { isReasoningLane = false } = {}) {
  let names;
  try {
    names = fs.readdirSync(pendingDir).filter((f) => f.endsWith('.json'));
  } catch (_) {
    return [];
  }

  // Side-effect requires: task-sources.js's registerTaskSource() calls populate
  // task-source-registry.js's registry as a load-time side effect -- must be required
  // before getRegisteredSource() can resolve anything (see local-worker.sh's own
  // comment on this same gotcha, confirmed live 2026-08-17: requiring model-provider.js
  // alone reported every source as 'low' every time).
  require('./task-sources.js');
  const { getRegisteredSource, resolveSourceName } = require('./task-source-registry.js');
  const { reasoningTierFor } = require('./model-provider.js');

  const pinned = [];
  const rankable = [];
  for (const name of names) {
    const { task, mtimeMs } = readTaskSafe(path.join(pendingDir, name));
    const pinnedWorker = task && task.pinnedWorker;
    if (pinnedWorker && pinnedWorker !== instanceId) continue; // pinned to another instance -- not a candidate for this one
    if (pinnedWorker === instanceId) {
      pinned.push({ name, mtimeMs });
      continue;
    }

    let priority = Infinity;
    let tier = 'low';
    if (task) {
      try {
        const source = getRegisteredSource(resolveSourceName(task));
        if (source && typeof source.priority === 'number') priority = source.priority;
      } catch (_) { /* unresolvable -- Infinity priority, sorts last, still listed */ }
      try { tier = reasoningTierFor(task); } catch (_) { /* default 'low' */ }
    }
    if (isReasoningLane ? tier !== 'high' : tier === 'high') continue;
    rankable.push({ name, priority, mtimeMs });
  }

  pinned.sort((a, b) => a.mtimeMs - b.mtimeMs);
  rankable.sort((a, b) => (a.priority - b.priority) || (a.mtimeMs - b.mtimeMs));
  return [...pinned.map((r) => r.name), ...rankable.map((r) => r.name)];
}

// Single-winner convenience form. local-worker.sh itself uses pickClaimableTasks()
// directly (it claims as many pending items as fit in one tick, not just one); this
// exists for callers/tests that only care about "what would this instance claim next."
function pickNextPendingTask(pendingDir, instanceId, opts) {
  const [first] = pickClaimableTasks(pendingDir, instanceId, opts);
  return first || null;
}

module.exports = { pickClaimableTasks, pickNextPendingTask };

// --- CLI --------------------------------------------------------------------------
// Usage: node next-claimable-task.js <pendingDir> <instanceId> <isReasoningLane:true|false>
// Prints one claimable filename per line, in claim-attempt order (same contract the
// removed inline `node -e` script had) -- local-worker.sh consumes this via
// `while IFS= read -r name; do items+=("$name"); done < <(node ...)`.
if (require.main === module) {
  const [pendingDir, instanceId, isReasoningLaneArg] = process.argv.slice(2);
  try {
    const items = pickClaimableTasks(pendingDir, instanceId, { isReasoningLane: isReasoningLaneArg === 'true' });
    for (const name of items) console.log(name);
  } catch (e) {
    // Best-effort, matching the removed inline script's own catch-and-fall-through --
    // caller already handles an empty listing safely.
  }
}
