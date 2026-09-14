'use strict';

// apply-main-batch.js -- extracted from src/apply-task.js ([[hub-task-integration]] node-module decompose).

const fs = require('fs');
const path = require('path');
const { getConfig, ensureRegistered } = require('../config.js');
const { getRegisteredSource, resolveSourceName } = require('../task-source-registry.js');
const { createRealGitRunner } = require('../git-runner.js');
const { writeTaskLogFile, taskLogRelPath } = require('../task-log-store.js');
require('../task-sources.js');
const { coAuthorTrailer, usesGroupB, applyCandidateSplit, writeArtifact, closeOriginatingBrainDumpEntry, assertStageableFiles } = require('./apply-core.js');

function applyDirectToMainBatch(tasks, { repoRoot, pipelineDir, secondBrainDir, brainDumpPath, gitRunner = createRealGitRunner(repoRoot) } = {}) {
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

  gitRunner.fetchMain();
  gitRunner.resetToMain();

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
      const taskLogRel = writeTaskLogFile(repoRoot, task);
      gitRunner.add([...files, taskLogRel]);
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
