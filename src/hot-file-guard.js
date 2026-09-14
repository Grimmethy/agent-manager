'use strict';

// Extracted from decompose-loop-autoroute.js (2026-09-14) so file-decompose-to-hub.js can
// use the same hot-file check without a circular require (file-decompose-to-hub.js already
// requires decompose-loop-autoroute.js's OWN sibling, and decompose-loop-autoroute.js
// requires file-decompose-to-hub.js -- a third module both can depend on avoids the cycle).
//
// Hot-file exclusion ([[hub-task-integration]], concept-hub-task-integration-549f09): a
// file with commits in the last N days is not a safe UNATTENDED target for a multi-day,
// per-move-branch Tier-2 hub -- concurrent edits to that file in the window are the norm,
// and a branch built against main-as-of-day-1 rots by the time day-4's move lands (lost a
// finished split twice this way: app.py 2026-09-06, index.html 2026-09-09).
//
// This does NOT gate Tier-1 fully-mechanical one-pass decomposes (script-extract HTML,
// self-contained node-module, all-flask-blueprint .py): those are a single deterministic
// commit built against CURRENT main in one tick and cannot go stale, so file-decompose-to-
// hub.js's fileHub() only applies this check to the Tier-2 hub path, AFTER the Tier-1
// short-circuits have already had their chance (see the 2026-09-14 fix -- this check used
// to run in the sweeps BEFORE the plan was even authored, so it blocked Tier-1-eligible
// files like app.py's flask-blueprint decomposes for a full week for no reason: the actual
// risk this guards against never applied to them).
//
// AGENT_MANAGER_DECOMPOSE_HOT_FILE_DAYS=0 disables.
const { execFileSync } = require('child_process');

const HOT_FILE_DAYS = (() => {
  const v = process.env.AGENT_MANAGER_DECOMPOSE_HOT_FILE_DAYS;
  return v === undefined ? 7 : Number(v);
})();

function fileHasRecentCommits(repoRoot, filePath, days = HOT_FILE_DAYS) {
  if (!repoRoot || !days || days <= 0) return false;
  try {
    const out = execFileSync(
      'git',
      ['log', `--since=${days} days ago`, '--oneline', '-1', '--', filePath],
      { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 },
    );
    return out.trim().length > 0;
  } catch {
    // A git failure must not silently DISABLE the gate (that would re-open the exact hole
    // this closes) nor block a legit request forever -- treat "can't tell" as "not hot"
    // for THIS tick; the request is idempotent so a later tick with a working git re-checks.
    return false;
  }
}

module.exports = { fileHasRecentCommits, HOT_FILE_DAYS };
