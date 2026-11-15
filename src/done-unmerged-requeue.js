'use strict';

// Done-unmerged-branch requeue sweep (2026-10-28, HUB0191).
//
// When a shipped entry (a PR/branch that merged to main) has a sibling task in
// done/ with status 'needs-work' and a non-merged branch, that task is a candidate
// for requeue: its work is still relevant, the branch is intact, and the sibling
// merges suggest the feature is complete.
//
// This sweep runs periodically (every few minutes) and:
// 1. Enumerates done/ tasks with status 'needs-work' and a branch
// 2. Checks if any shipped entry matches the branch
// 3. If matched and not already requeued, moves the task to pending/ with feedback
// 4. If all siblings are merged, discards the task (inert half)
//
// The sweep never deletes branches -- that's the dashboard's job via the branch
// removal ledger. It preserves premium fields and attaches a feedback message.

const fs = require('fs');
const path = require('path');

const SETTLE_MS = 5 * 60 * 1000; // 5 minutes before a task is eligible for requeue

function readJsonSafe(fullPath) {
  try {
    return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  } catch {
    return null;
  }
}

function writeAndUnlink(destPath, data, srcPath) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, JSON.stringify(data, null, 2), 'utf8');
  if (srcPath) {
    fs.unlinkSync(srcPath);
  }
}

function findTask(pipelineDir, state, taskId) {
  const p = path.join(pipelineDir, 'queue', state, `${taskId}.json`);
  const data = readJsonSafe(p);
  return data ? { path: p, data } : null;
}

function listDoneTasks(pipelineDir) {
  const doneDir = path.join(pipelineDir, 'queue', 'done');
  let files = [];
  try {
    files = fs.readdirSync(doneDir).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }
  return files.map(f => ({
    id: f.slice(0, -5),
    path: path.join(doneDir, f),
  }));
}

function isAlreadyRequeued(task) {
  if (!Array.isArray(task.history)) return false;
  return task.history.some(h => h.stage === 'requeued' || h.stage === 'requeued-from-done');
}

function areAllSiblingsMerged(task, pipelineDir) {
  if (!Array.isArray(task.siblings) || !task.siblings.length) return false;
  return task.siblings.every(siblingId => {
    const found = findTask(pipelineDir, 'done', siblingId);
    return found && found.data.status === 'approved' && found.data.terminalDisposition === 'merged';
  });
}

function matchShippedEntry(task, shippedEntries) {
  const taskBranch = task.history?.find(h => h.stage === 'applied')?.detail;
  if (!taskBranch) return null;

  return shippedEntries.find(entry => {
    if (entry.taskId !== task.id) return false;
    if (entry.branch !== taskBranch) return false;
    return true;
  });
}

function attachFeedback(task, feedback) {
  task.promptContext = task.promptContext || {};
  task.promptContext.rawText = (task.promptContext.rawText || '')
    + `\n\n--- REQUEUE FEEDBACK (${new Date().toISOString()}) ---\n${feedback}\n`;
}

function moveTask(srcPipelineDir, srcState, taskId, destPipelineDir, destState, data) {
  const srcPath = path.join(srcPipelineDir, 'queue', srcState, `${taskId}.json`);
  const destPath = path.join(destPipelineDir, 'queue', destState, `${taskId}.json`);
  writeAndUnlink(destPath, data, srcPath);
}

function sweepDoneUnmerged(opts) {
  const {
    pipelineDir,
    now,
    shippedEntries = [],
    otherPipelineDir = null,
    repoRoot = null,
    mainBranch = 'main',
  } = opts;

  const result = { requeued: 0, unchanged: 0, discarded: 0, errors: [] };

  const doneTasks = listDoneTasks(pipelineDir);

  for (const { id, path: taskPath } of doneTasks) {
    const task = readJsonSafe(taskPath);
    if (!task) {
      result.errors.push(`Failed to read task ${id}`);
      continue;
    }

    // Skip non-needs-work tasks
    if (task.status !== 'needs-work') {
      result.unchanged++;
      continue;
    }

    // Skip tasks already requeued
    if (isAlreadyRequeued(task)) {
      result.unchanged++;
      continue;
    }

    // Skip tasks without a branch
    const appliedEntry = task.history?.find(h => h.stage === 'applied');
    if (!appliedEntry || !appliedEntry.detail) {
      result.unchanged++;
      continue;
    }

    // Check if all siblings are merged (inert half)
    if (areAllSiblingsMerged(task, pipelineDir)) {
      // Discard: the feature is complete, this half is no longer needed
      task.history = task.history || [];
      task.history.push({
        stage: 'discarded',
        at: new Date().toISOString(),
        reason: 'all siblings merged',
      });
      const destPath = path.join(pipelineDir, 'queue', 'done', '_archived_no_action', `${id}.json`);
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, JSON.stringify(task, null, 2));
      fs.unlinkSync(taskPath);
      result.discarded++;
      continue;
    }

    // Check if this task matches a shipped entry
    const match = matchShippedEntry(task, shippedEntries);
    if (!match) {
      result.unchanged++;
      continue;
    }

    // Check if enough time has passed (settle period)
    const lastReview = task.history?.find(h => h.verdict === 'needs-work');
    const lastReviewTime = lastReview?.at ? new Date(lastReview.at).getTime() : 0;
    if (now - lastReviewTime < SETTLE_MS) {
      result.unchanged++;
      continue;
    }

    // Requeue the task
    const destState = otherPipelineDir ? 'pending' : 'pending';
    const destPipeline = otherPipelineDir || pipelineDir;

    // Preserve premium fields
    if (task.premium) {
      // Keep as-is
    }

    // Attach feedback
    attachFeedback(task, `This task was requeued because its branch (${match.branch}) was superseded by a merged shipped entry. The work is still relevant and should be addressed.`);

    // Update status and history
    task.status = 'pending';
    task.project = match.targetProject || task.project;
    task.history = task.history || [];
    task.history.push({
      stage: 'requeued',
      at: new Date().toISOString(),
      source: 'sweep',
      reason: 'shipped entry match',
    });

    // Move the task
    const srcPath = path.join(pipelineDir, 'queue', 'done', `${id}.json`);
    const destPath = path.join(destPipeline, 'queue', destState, `${id}.json`);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, JSON.stringify(task, null, 2));
    fs.unlinkSync(srcPath);

    result.requeued++;
  }

  return result;
}

module.exports = {
  sweepDoneUnmerged,
  SETTLE_MS,
};
