'use strict';

// decompose-auto-merge.js (2026-09-09, [[hub-task-integration]] / concept-hub-task-integration-549f09,
// spec Docs/hub-task-independent-merge.md Tier 2 -- "the key enabler").
//
// A non-stacked decompose hub files each move as its own self-contained adhoc child that
// applies to its own `agent/<child-id>` branch off current main. Nothing then merges those
// branches: the apply loop skip-pushes and never merges, and a human clicking the
// dashboard's Unmerged Branches button once per move per decompose is exactly the
// [[ghost-in-the-machine]] hand-step this removes.
//
// This merges a VERIFIED MECHANICAL move child itself. A `script-extract` move
// (promptContext.deterministicApply === 'script-extract') is a verbatim top-level-symbol
// relocation -- validatePlan already proved every symbol resolves. If its branch still
// merges CLEAN into current origin/<main> AND decompose-integration-gate passes (for a
// Python source; an HTML source is a `language: skip` no-op gate -- the clean-merge plus
// the mechanical marker carry it, the same bar as Tier 1's `node --check`), that is a safe
// auto-merge. Anything non-mechanical, a dirty merge, or a gate failure is left for a
// human -- bounded and visible, the caller stamps `coordinatorBlocked`.
//
// Every git call goes through an injectable `exec` (realExec signature: (file, args,
// {cwd, timeout})) so coordinator-sweep's test drives this with canned output instead of a
// real repo. On by default in coordinator-sweep; kill switch
// AGENT_MANAGER_COORDINATOR_AUTO_MERGE_MOVES=false.

const os = require('os');
const path = require('path');
const fs = require('fs');
const { runIntegrationGate, realExec } = require('./decompose-integration-gate.js');

const BRANCH_REF = 'refs/decompose-automerge/branch';
const MAIN_REF = 'refs/decompose-automerge/main';

// A move child whose apply is a pure deterministic relocation -- never an LLM-authored
// change. Only these auto-merge; a `flask-blueprint` / `module-extract` / drifted move
// stays `pending-merge` for a human.
function isMechanicalMoveChild(task) {
  const pc = task && task.promptContext;
  return !!pc && (pc.deterministicApply === 'script-extract' || pc.deterministicApply === 'one-pass-decompose');
}

/**
 * @returns {{merged:true, mergeCommit:string}
 *   | {merged:false, reason:'not-mechanical'|'no-branch'|'conflict'|'gate-failed'|'gate-errored'|'push-race'|'setup-failed', detail?:string, conflictFiles?:string[], checks?:Array}}
 *   `conflict` / `gate-failed` are terminal for the machine (hand it to a human);
 *   `no-branch` / `gate-errored` / `push-race` / `setup-failed` are transient -- retry next tick.
 */
function autoMergeVerifiedMoveChild({
  repoRoot, childId, childTask, mainBranch = 'master',
  exec = realExec, runGate = runIntegrationGate,
}) {
  if (!repoRoot || !childId) return { merged: false, reason: 'setup-failed', detail: 'no repoRoot/childId' };
  if (!isMechanicalMoveChild(childTask)) return { merged: false, reason: 'not-mechanical' };

  const branch = `agent/${childId}`;
  const sourceFile = (childTask.promptContext && childTask.promptContext.sourceFile) || '';
  const title = childTask.title || childId;

  const wtBase = fs.mkdtempSync(path.join(os.tmpdir(), 'decompose-automerge-'));
  const wt = path.join(wtBase, 'main');
  const cleanup = () => {
    try { exec('git', ['worktree', 'remove', '--force', wt], { cwd: repoRoot }); } catch { /* best-effort */ }
    for (const ref of [BRANCH_REF, MAIN_REF]) {
      try { exec('git', ['update-ref', '-d', ref], { cwd: repoRoot }); } catch { /* best-effort */ }
    }
    try { fs.rmSync(wtBase, { recursive: true, force: true }); } catch { /* best-effort */ }
  };

  try {
    // 1. Fetch branch + main into throwaway refs. Apply runs in a separate clone since
    //    2026-09-07, so `agent/<id>` is on origin only -- the bare name does not resolve
    //    here (same reason decompose-integration-gate.js fetches into refs/decompose-gate/*).
    try {
      exec('git', ['fetch', '--no-tags', '--force', 'origin',
        `${branch}:${BRANCH_REF}`, `${mainBranch}:${MAIN_REF}`], { cwd: repoRoot });
    } catch (e) {
      cleanup();
      return { merged: false, reason: 'no-branch', detail: `could not fetch ${branch}: ${e.message}` };
    }

    // 2. Clean-merge test in a throwaway detached worktree of current main.
    try {
      exec('git', ['worktree', 'add', '--detach', wt, MAIN_REF], { cwd: repoRoot });
    } catch (e) {
      cleanup();
      return { merged: false, reason: 'setup-failed', detail: `worktree: ${e.message}` };
    }
    try {
      exec('git', ['merge', '--no-ff', BRANCH_REF, '-m',
        `Merge ${title} (coordinator auto-merge: verified mechanical decompose move ${childId})`], { cwd: wt });
    } catch (e) {
      let conflictFiles = [];
      try {
        conflictFiles = exec('git', ['diff', '--name-only', '--diff-filter=U'], { cwd: wt })
          .split('\n').map((s) => s.trim()).filter(Boolean);
      } catch { /* best-effort */ }
      try { exec('git', ['merge', '--abort'], { cwd: wt }); } catch { /* best-effort */ }
      cleanup();
      return { merged: false, reason: 'conflict', detail: `${branch} no longer merges clean into ${mainBranch}`, conflictFiles };
    }

    // 3. Integration gate: main vs branch (the branch IS main + this one move). Runs its
    //    own fetch/worktree against origin; an HTML source returns `language: skip` (ok).
    let gate;
    try {
      gate = runGate({ repoRoot, branch, mainBranch, sourceFile, exec });
    } catch (e) {
      cleanup();
      return { merged: false, reason: 'gate-errored', detail: e.message };
    }
    if (gate && gate.errored) { cleanup(); return { merged: false, reason: 'gate-errored', checks: gate.checks || [] }; }
    if (!gate || !gate.ok) { cleanup(); return { merged: false, reason: 'gate-failed', checks: (gate && gate.checks) || [] }; }

    // 4. Push the merge commit to origin/<main>. A rejected (non-fast-forward) push means
    //    main moved under us between the fetch and now -- bail, the sweep retries next tick.
    let mergeCommit = '';
    try { mergeCommit = exec('git', ['rev-parse', 'HEAD'], { cwd: wt }).trim(); } catch { /* best-effort */ }
    try {
      exec('git', ['push', 'origin', `HEAD:${mainBranch}`], { cwd: wt });
    } catch (e) {
      cleanup();
      return { merged: false, reason: 'push-race', detail: e.message };
    }

    // 5. Best-effort: drop the now fully-merged remote branch.
    try { exec('git', ['push', 'origin', '--delete', branch], { cwd: repoRoot }); } catch { /* best-effort */ }

    cleanup();
    return { merged: true, mergeCommit };
  } catch (e) {
    cleanup();
    return { merged: false, reason: 'setup-failed', detail: e.message };
  }
}

module.exports = { autoMergeVerifiedMoveChild, isMechanicalMoveChild, BRANCH_REF, MAIN_REF };
