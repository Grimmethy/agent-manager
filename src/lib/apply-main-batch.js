'use strict';

// apply-main-batch.js -- extracted from src/apply-task.js ([[hub-task-integration]] node-module decompose).

const fs = require('fs');
const path = require('path');
const { getConfig, ensureRegistered } = require('../config.js');
const { getRegisteredSource, resolveSourceName } = require('../task-source-registry.js');
const { createRealGitRunner } = require('../git-runner.js');
const { writeTaskLogFile, taskLogRelPath } = require('../task-log-store.js');
require('../task-sources.js');
const { TRIAGE_BRANCH, ungatedMainPushAllowed } = require('./main-push-policy.js');
const { coAuthorTrailer, usesGroupB, applyCandidateSplit, writeArtifact, closeOriginatingBrainDumpEntry, assertStageableFiles } = require('./apply-core.js');

// The shared checkout must never be left on the triage branch. That branch is based on whatever main was when it was first created and is never rebased, so a
// checkout parked on it (2026-09-20, PF: 4 h, 40 commits behind main) makes every read of "the repo" (plan grounding, review's live content, the staleness
// sweep) see ancient code: false "file absent" flags, stale rejections. Only the single fully-successful path used to return to main; a batch that staged
// nothing, a failed commit, or a failed push stayed on the branch. This wrapper returns to main on EVERY exit once the triage branch has been entered.
// (Ungated mode resets to main itself.) The pushed-or-local commit lives on the branch ref, so leaving the branch loses nothing.
function applyDirectToMainBatch(tasks, { repoRoot, pipelineDir, secondBrainDir, brainDumpPath, gitRunner = createRealGitRunner(repoRoot) } = {}) {
  const state = { enteredTriageBranch: false };
  try {
    return applyDirectToMainBatchOnBranch(tasks, { repoRoot, pipelineDir, secondBrainDir, brainDumpPath, gitRunner, state });
  } finally {
    if (state.enteredTriageBranch) {
      try { gitRunner.checkoutMain(); } catch { /* the next apply resets anyway */ }
    }
  }
}

function applyDirectToMainBatchOnBranch(tasks, { repoRoot, pipelineDir, secondBrainDir, brainDumpPath, gitRunner, state }) {
  const results = {};
  const eligible = [];
  for (const task of tasks) {
    const reg = getRegisteredSource(resolveSourceName(task));
    if (reg && reg.directToMain === true) {
      eligible.push(task);
    } else {
      results[task.id] = { succeeded: false, reason: 'source is not directToMain -- must be applied individually, not in the triage batch' };
    }
  }
  if (eligible.length === 0) return { results, committed: false };

  // Gated (default): append onto the rolling TRIAGE_BRANCH, never main -- see main-push-policy.js.
  // prepareStackedBranch syncs it from origin if it exists (earlier unmerged batches stay on it),
  // or starts it fresh off current main (also after a human merged + deleted it).
  const gated = !ungatedMainPushAllowed();
  gitRunner.fetchMain();
  if (gated) {
    // Pre-flight BEFORE entering the branch: a dirty apply clone aborts prepareStackedBranch's `checkout -B` / `rebase`
    // (2026-09-23: ~266 change_review tasks blocked one-by-one on it). Self-heal a dedicated clone, else fail once, loudly.
    if (typeof gitRunner.quarantineDirtyTree === 'function') gitRunner.quarantineDirtyTree();
    if (typeof gitRunner.assertCleanTree === 'function') gitRunner.assertCleanTree();
    state.enteredTriageBranch = true;
    gitRunner.prepareStackedBranch(TRIAGE_BRANCH);
  } else gitRunner.resetToMain();

  const staged = [];
  for (const task of eligible) {
    try {
      const artifact = writeArtifact(task, repoRoot, pipelineDir);
      if (artifact && artifact.skipped) {
        results[task.id] = { succeeded: true, doneMarker: artifact.reason };
        closeOriginatingBrainDumpEntry(task, brainDumpPath, artifact.reason);
        continue;
      }
      if (artifact && artifact.needsConfirmation) {
        results[task.id] = artifact; // -> awaiting-confirm/, nothing staged for this one
        continue;
      }
      const files = artifact.files || [artifact.file];
      assertStageableFiles(task, files);
      // 2026-09-16: task-logs/ is gitignored (see task-log-store.js's own 2026-09-15
      // RE-EVALUATED header -- it can retain a task's full rawText/implementResponse
      // verbatim, which for a brain_dump-derived task is the user's own free-typed
      // personal/business note content, and this repo is public). apply-task.js's
      // single-task path was updated to only write it to disk, never stage it -- this
      // batch path was missed, so EVERY batched directToMain apply (arch_discovery,
      // arch_review, observability_review, ...) started failing `git add` with "The
      // following paths are ignored by one of your .gitignore files: task-logs" the
      // moment a task whose artifact needed staging reached here, root-caused live via
      // a real stuck task (arch-discovery-community-15) that got approved at review and
      // then failed at apply with exactly this error, looping on requeue forever since
      // the failure is deterministic. writeTaskLogFile still writes the file to disk
      // (for the user's own local reference, and so the commit message's `Task-Log:`
      // line below still points somewhere real); it just never joins `files` here.
      const taskLogRel = writeTaskLogFile(repoRoot, task);
      gitRunner.add(files);
      staged.push({ task, files, taskLogRel });
    } catch (e) {
      // This task's append threw. Its file may carry a partial trailing line -- cosmetic
      // in an append-only markdown candidate doc and visible in review; not worth a
      // resetToMain here (that would discard every sibling's already-good append too).
      results[task.id] = { succeeded: false, reason: `writeArtifact failed: ${e.message}` };
    }
  }

  if (staged.length === 0) return { results, committed: false };

  const msgPath = path.join(require('os').tmpdir(), `apply-batch-msg-${process.pid}.txt`);
  const commitMessage = [
    `Triage batch: ${staged.length} candidate-doc update(s)`,
    '',
    ...staged.map((s) => `- ${s.task.title} (task ${s.task.id})`),
    '',
    ...staged.map((s) => `Task-Log: ${s.taskLogRel}`),
    '',
    coAuthorTrailer(staged[0].task),
  ].join('\n');
  fs.writeFileSync(msgPath, commitMessage);
  try {
    gitRunner.commit(msgPath);
  } finally {
    fs.unlinkSync(msgPath);
  }

  if (gated) {
    try {
      gitRunner.push(TRIAGE_BRANCH);
    } catch (pushErr) {
      // Same rationale as the ungated path: the commit is real, reviewed work -- kept on the local
      // branch (prepareStackedBranch trusts a strictly-ahead local copy next tick), not rolled back.
      for (const s of staged) {
        results[s.task.id] = { succeeded: false, reason: `push of ${TRIAGE_BRANCH} failed after commit (kept local, not rolled back): ${pushErr.message}` };
      }
      return { results, committed: true, pushed: false, branch: TRIAGE_BRANCH };
    }
    // (returning to main is the wrapper's job, on every exit)
    // NB: this wording must NOT match task-disposition.js's DIRECT_RE ("committed to main" /
    // "triage batch") or unmerged work would be reported as already shipped (applied-direct).
    for (const s of staged) {
      results[s.task.id] = { succeeded: true, doneMarker: `queued on ${TRIAGE_BRANCH} (${staged.length} update(s)) -- awaiting a human merge; nothing pushed to ${gitRunner.mainBranch}` };
      closeOriginatingBrainDumpEntry(s.task, brainDumpPath, `Queued on ${TRIAGE_BRANCH}, awaiting merge -- Task: ${s.task.id}`);
    }
    return { results, committed: true, pushed: true, branch: TRIAGE_BRANCH };
  }

  try {
    gitRunner.pushMain();
  } catch (pushErr) {
    // Same rationale as applyTask's commitsDirectlyToMain push-failure handling: the
    // commit is real, already-reviewed work; discarding it here recreates the data-loss
    // this whole path exists to prevent. It stays local and rides out with the next push.
    for (const s of staged) {
      results[s.task.id] = { succeeded: false, reason: `triage batch push to main failed after commit (kept local, not rolled back): ${pushErr.message}` };
    }
    return { results, committed: true, pushed: false };
  }

  for (const s of staged) {
    results[s.task.id] = { succeeded: true, doneMarker: `committed to ${gitRunner.mainBranch} in a ${staged.length}-task triage batch` };
    closeOriginatingBrainDumpEntry(s.task, brainDumpPath, `Applied in a triage batch -- Task: ${s.task.id}`);
  }
  return { results, committed: true, pushed: true, branch: gitRunner.mainBranch };
}

function mainPartition() {
  const { repoRoot } = getConfig();
  void repoRoot;
  const direct = [];
  const other = [];
  for (const p of process.argv.slice(3)) {
    try {
      const t = JSON.parse(fs.readFileSync(p, 'utf8'));
      const reg = getRegisteredSource(resolveSourceName(t));
      if (reg && reg.directToMain === true) direct.push(p); else other.push(p);
    } catch {
      other.push(p);
    }
  }
  process.stdout.write(JSON.stringify({ direct, other }));
}

module.exports = { applyDirectToMainBatch, mainPartition };
