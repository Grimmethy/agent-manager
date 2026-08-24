'use strict';

// Apply-retry-requeue: a task that reached queue/blocked/ via blockedStage==='apply' (a
// git-apply failure, NOT a review rejection -- see recordApplyOutcome's own comment on
// why apply failures are deliberately stamped with their own blockedStage rather than
// leaving a leftover 'review' one) gets one more fresh redraft attempt, capped at
// MAX_APPLY_RETRIES. Mirrors reject-retry-check.js's exact shape for a review rejection,
// just scanning a different blockedStage.
//
// 2026-08-24 (pipeline hardening): caught live -- a real task's diff conflicted with an
// unrelated sibling task's own change that landed on the SAME file between this draft's
// worktree being cut and apply actually running. apply-adhoc-diff.js now retries with
// `git apply --3way` before giving up (a real content-based merge resolves most of this
// class of conflict automatically), but a genuine conflict -- the SAME line actually
// edited two different ways -- can still fail both attempts. Before this existed, EVERY
// apply-failed task landed in queue/blocked/ requiring a human to manually diagnose "is
// this a stale patch (just redraft) or a genuine problem (needs a real decision)" and
// requeue by hand -- exactly what happened live to the hardware-tab task this session.
// A stale patch's underlying INTENT is still valid; the fix is "draft again against
// current code," not "wait for a human" -- reject-retry-check.js already established
// this exact reasoning for review rejections, this is the same idea for the apply stage.
//
// Unlike a review rejection (blind retry with no new information beyond
// priorRejectionFeedback), a fresh draft here gets a REAL do-over: local-worker.sh's
// normal claim path cuts a brand-new worktree from CURRENT origin/mainBranch and runs a
// full fresh plan/implement pass, producing a new rawDiff against current code -- not a
// literal retry of the same stale diff. Moving the task back to pending/ (unstripped,
// same as reject-retry-check.js) is enough to trigger this; nothing here needs to touch
// rawDiff/planResponse/implementResponse itself.
//
// CLI: node apply-retry-check.js
// Writes ONE line of JSON summary to stdout: { checked, requeued, exhausted, errors }

const fs = require('fs');
const path = require('path');
const { getConfig } = require('./config.js');
const { recordOutcome: defaultRecordModelOutcome } = require('./model-stats-client.js');
const { appendHistoryEvent } = require('./task-history.js');

const MAX_APPLY_RETRIES = 2;

function isApplyFailure(task) {
  return task.blockedStage === 'apply';
}

function applyRetryCheck({ blockedDir, pendingDir, recordModelOutcome = defaultRecordModelOutcome }) {
  const summary = { checked: 0, requeued: 0, exhausted: 0, errors: 0 };
  let names = [];
  try {
    names = fs.readdirSync(blockedDir).filter((f) => f.endsWith('.json'));
  } catch (e) {
    return summary; // blocked/ doesn't exist yet -- nothing to check.
  }

  for (const name of names) {
    const filePath = path.join(blockedDir, name);
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      if (!raw) continue;
      const task = JSON.parse(raw);
      summary.checked++;

      // Only a genuine apply-stage failure is eligible -- never a review rejection that
      // happens to still carry stale fields, same "only act on the specific stage this
      // check owns" reasoning reject-retry-check.js's own isReviewRejection() guard uses.
      if (!isApplyFailure(task)) continue;

      const retryCount = Number(task.applyRetryCount) || 0;
      if (retryCount >= MAX_APPLY_RETRIES) {
        // Same "stamp once, never re-fire" guard reject-retry-check.js uses -- without
        // it this branch would re-append an 'exhausted' history event on every single
        // watchdog tick for as long as the task sits here, unbounded.
        const alreadyStamped = Array.isArray(task.history) && task.history.some((h) => h.stage === 'exhausted');
        if (alreadyStamped) { summary.exhausted++; continue; }
        appendHistoryEvent(task, 'exhausted', `${retryCount}/${MAX_APPLY_RETRIES} apply retries used`);
        fs.writeFileSync(filePath, JSON.stringify(task, null, 2));
        summary.exhausted++;
        continue;
      }

      task.applyRetryCount = retryCount + 1;

      recordModelOutcome({ callId: task.abCallId, outcome: 'requeued', outcomeStage: 'apply-watchdog', outcomeReason: task.blockedReason || null });
      appendHistoryEvent(task, 'requeued', task.blockedReason || undefined);

      const newPath = path.join(pendingDir, name);
      fs.mkdirSync(pendingDir, { recursive: true });
      fs.writeFileSync(newPath, JSON.stringify(task, null, 2));
      fs.unlinkSync(filePath);
      summary.requeued++;
    } catch (e) {
      summary.errors++;
    }
  }

  return summary;
}

function main() {
  const { pipelineDir } = getConfig();
  const queueDir = path.join(pipelineDir, 'queue');
  const blockedDir = path.join(queueDir, 'blocked');
  const pendingDir = path.join(queueDir, 'pending');

  const summary = applyRetryCheck({ blockedDir, pendingDir });
  process.stdout.write(JSON.stringify(summary));
}

module.exports = { applyRetryCheck };

if (require.main === module) {
  main();
}
