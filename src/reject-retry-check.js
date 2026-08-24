'use strict';

// Reject-retry-requeue: a task genuinely REJECTED by review (blockedStage==='review', not
// a crash/domain-error block) gets moved back to queue/pending/ for a fresh redraft,
// capped at MAX_LOCAL_REJECT_RETRIES attempts, tracked via `localRejectCount` on the
// task JSON. Port of queue-watchdog.ps1's Invoke-RejectRetryCheck -- the only piece of
// that script ported here (its other job, dead-process detection/restart, is a separate,
// not-yet-ported gap; see queue-watcher.sh's own header). Without this, blockedStage:
// 'review' is a permanent dead end on Linux -- confirmed live 2026-08-14: 17 real blocked
// tasks, zero retries, because nothing was ever wired to look at localRejectCount at all.
//
// KNOWN LIMITATION (same as the reference): this is a BLIND retry -- the redraft doesn't
// see WHY it was rejected beyond priorRejectionFeedback's accumulated reasons (which
// prompts.js's priorRejectionBlock() DOES already read and fold into the next plan/
// implement prompt -- no changes needed there, local-draft.js already imports
// buildPlanPrompt/buildImplementPrompt directly).
//
// Trimmed to what's actually reachable via task-domains.json on this deployment: the
// exhaustion-stamping side effect is ported for deep_dive (wired, real coverage file)
// but NOT arch_discovery/arch_import (neither domain is reachable here -- see
// local-draft.js's own scope note). model-stats-db recording (Invoke-ModelStatsDb in the
// reference) is analytics, not core correctness, and is left out.
//
// CLI: node reject-retry-check.js
// Writes ONE line of JSON summary to stdout: { checked, requeued, exhausted, errors }

const fs = require('fs');
const path = require('path');
const { getConfig } = require('./config.js');
const { recordOutcome: defaultRecordModelOutcome } = require('./model-stats-client.js');
const { appendHistoryEvent } = require('./task-history.js');

const MAX_LOCAL_REJECT_RETRIES = 2;

function isReviewRejection(task) {
  return task.blockedStage === 'review';
}

// Same reasoning as queue-watchdog.ps1's arch_discovery/arch_import stamping (not ported
// here, see header) -- deep_dive's own coverage tracker: without this, a community whose
// task exhausts its retries stays eligible for nextDeepDiveTask() to re-select FOREVER
// (deep-dive-coverage.json's per-project communities[].lastReviewedAt never gets touched by
// anything on the rejection path otherwise), so the deep_dive rotation starves on one
// permanently-doomed community instead of moving on to the rest.
function stampDeepDiveExhausted(task, deepDiveCoveragePath) {
  if (task.source !== 'deep_dive') return;
  if (!task.promptContext || !task.promptContext.projectSlug || task.promptContext.communityId == null) return;
  if (!deepDiveCoveragePath || !fs.existsSync(deepDiveCoveragePath)) return;
  try {
    const coverage = JSON.parse(fs.readFileSync(deepDiveCoveragePath, 'utf8'));
    const proj = coverage.projects && coverage.projects[task.promptContext.projectSlug];
    if (!proj || !Array.isArray(proj.communities)) return;
    const entry = proj.communities.find((c) => c.id === Number(task.promptContext.communityId));
    if (entry && !entry.lastReviewedAt) {
      entry.lastReviewedAt = new Date().toISOString();
      entry.actionItemCount = -1; // sentinel: exhausted retries, never a real action-item count
      fs.writeFileSync(deepDiveCoveragePath, JSON.stringify(coverage, null, 2));
    }
  } catch (e) {
    // Non-fatal -- same "warn and move on" treatment the reference gives this stamp.
    console.warn('[reject-retry-check] coverage write failed:', e.message);
  }
}

function rejectRetryCheck({ blockedDir, pendingDir, deepDiveCoveragePath, recordModelOutcome = defaultRecordModelOutcome }) {
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

      // Only a genuine review-stage rejection is eligible -- never an apply-stage failure
      // that happens to still carry localVotes from an earlier, unrelated successful
      // review (redrafting can't fix that; see agent-manager-common.sh's
      // test_review_rejection, the bash equivalent of this exact check).
      if (!isReviewRejection(task)) continue;

      const retryCount = Number(task.localRejectCount) || 0;
      if (retryCount >= MAX_LOCAL_REJECT_RETRIES) {
        // Already stamped on a prior tick -- an exhausted task stays in blocked/
        // permanently (nothing here ever moves or deletes it), so without this guard this
        // whole branch re-fires every single tick forever. Confirmed live 2026-08-17: one
        // real exhausted task accumulated 20+ duplicate 'exhausted' history entries (one
        // per ~30s tick) over about 12 minutes before this was caught, unbounded growth
        // for as long as the task sits there -- which, being exhausted, is indefinitely.
        const alreadyStamped = Array.isArray(task.history) && task.history.some((h) => h.stage === 'exhausted');
        if (alreadyStamped) { summary.exhausted++; continue; }
        stampDeepDiveExhausted(task, deepDiveCoveragePath);
        // Persist the exhaustion itself onto the task -- previously this branch never
        // wrote the file back at all, so a task permanently stuck in queue/blocked/ after
        // hitting the retry cap carried no record that retries were ever attempted or
        // exhausted; only localRejectCount (no timestamp) hinted at it.
        appendHistoryEvent(task, 'exhausted', `${retryCount}/${MAX_LOCAL_REJECT_RETRIES} retries used`);
        fs.writeFileSync(filePath, JSON.stringify(task, null, 2));
        summary.exhausted++;
        continue;
      }

      const priorFeedback = Array.isArray(task.priorRejectionFeedback) ? task.priorRejectionFeedback : [];
      priorFeedback.push(String(task.blockedReason || ''));
      task.priorRejectionFeedback = priorFeedback;
      task.localRejectCount = retryCount + 1;

      recordModelOutcome({ callId: task.abCallId, outcome: 'requeued', outcomeStage: 'watchdog', outcomeReason: task.blockedReason || null });
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
  const { pipelineDir, deepDiveCoveragePath } = getConfig();
  const queueDir = path.join(pipelineDir, 'queue');
  const blockedDir = path.join(queueDir, 'blocked');
  const pendingDir = path.join(queueDir, 'pending');

  const summary = rejectRetryCheck({ blockedDir, pendingDir, deepDiveCoveragePath });
  process.stdout.write(JSON.stringify(summary));
}

module.exports = { rejectRetryCheck };

if (require.main === module) {
  main();
}
