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

function isAdhocTask(task) {
  return task.domain === 'adhoc' || task.source === 'manual';
}

// The pre-filled question a human sees when an adhoc rejection has burned all its blind
// redrafts. The commonest cause (confirmed live: the NSFW-images task) is the handler
// deciding a request to EXTEND an existing feature is already done -- so the question
// steers the human straight at that.
function buildExhaustedAdhocQuestion(task) {
  const reasons = (Array.isArray(task.priorRejectionFeedback) ? task.priorRejectionFeedback : [])
    .concat(task.blockedReason ? [String(task.blockedReason)] : [])
    .filter(Boolean);
  const verdictNote = task.adhocResolution === 'no-changes-needed'
    ? 'The automated handler concluded this needs NO changes (RESOLUTION: no-changes-needed), but review rejected that every time:'
    : `The automated handler could not get this past review after ${MAX_LOCAL_REJECT_RETRIES + 1} attempts:`;
  return [
    verdictNote,
    ...reasons.map((r, i) => `  ${i + 1}. ${r}`),
    '',
    'If this is a request to EXTEND an existing feature (a "should also", a "when X, also Y", '
      + 'or it names a different object than a similarly-named feature already covers), say '
      + 'exactly what should change and which file(s). If it is genuinely already done, use Archive.',
  ].join('\n');
}

function rejectRetryCheck({ blockedDir, pendingDir, adhocDir, needsClarificationDir, deepDiveCoveragePath, recordModelOutcome = defaultRecordModelOutcome }) {
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
      //
      // 2026-09-01: also eligible -- an adhoc tier-3 draft-stage block that a redraft could
      // plausibly fix (resolveAgenticDraft sets task.retryableDraftBlock):
      //   - the model exhausted its turn budget without making a single edit
      //     (task.turnBudgetExhausted) -- the redraft is NOT blind: plan + tier-2
      //     investigation are folded into the prompt and the feedback below says "edit early".
      //   - the model chose RESOLUTION: decompose but botched the sub-task JSON -- a redraft
      //     can emit valid JSON or just implement the change; the feedback reminds it of the
      //     format.
      // Bounded by the same MAX_LOCAL_REJECT_RETRIES cap; on exhaustion it takes the same
      // adhoc -> needs-clarification escalation as a stuck review rejection.
      const retryableDraftBlock = isAdhocTask(task) && task.retryableDraftBlock === true;
      if (!isReviewRejection(task) && !retryableDraftBlock) continue;

      // A continuation (agentic-draft-common.js: the model ran out of turns mid-
      // implementation, no real design question) is forward progress, not a failed
      // redraft -- it has its OWN cap (MAX_AGENTIC_CONTINUATIONS, enforced there) and must
      // not be gated by, or count against, the blind-redraft cap.
      const isContinuation = retryableDraftBlock && task.isAgenticContinuation === true;

      const retryCount = Number(task.localRejectCount) || 0;
      if (retryCount >= MAX_LOCAL_REJECT_RETRIES && !isContinuation) {
        // An exhausted ADHOC rejection is very often a real disagreement about scope
        // ("is this already done, or a request to extend it?") that no amount of blind
        // redraft will resolve -- send it to a human instead of leaving it to rot in
        // blocked/ forever. (Non-adhoc keeps the original "stamp once, stay in blocked"
        // behaviour.)
        if (isAdhocTask(task) && needsClarificationDir) {
          const alreadyEscalated = Array.isArray(task.history) && task.history.some((h) => h.stage === 'needs-clarification');
          if (alreadyEscalated) { summary.exhausted++; continue; }
          task.needsClarification = { reason: 'design-decision', openQuestions: buildExhaustedAdhocQuestion(task) };
          appendHistoryEvent(task, 'exhausted', `${retryCount}/${MAX_LOCAL_REJECT_RETRIES} retries used`);
          appendHistoryEvent(task, 'needs-clarification', 'escalated to a human after exhausting redraft retries');
          fs.mkdirSync(needsClarificationDir, { recursive: true });
          fs.writeFileSync(path.join(needsClarificationDir, name), JSON.stringify(task, null, 2));
          fs.unlinkSync(filePath);
          summary.exhausted++;
          continue;
        }
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
      if (isContinuation) {
        priorFeedback.push([
          'This is a CONTINUATION, not a fresh start. A prior pass got partway through and ran out of turns. It reported this remaining work:',
          '',
          String(task.agenticContinuationNote || '').slice(0, 4000),
          task.priorPartialDiff
            ? `\nThe partial diff it already produced (build ON this, do not redo it):\n\n${String(task.priorPartialDiff).slice(0, 6000)}`
            : '',
          '',
          'Start editing with edit_file/write_file within your first 1-2 turns from where it left off. Finish the remaining work and end with RESOLUTION: implemented.',
        ].filter(Boolean).join('\n'));
        delete task.agenticContinuationNote;
        delete task.priorPartialDiff;
        // keep task.isAgenticContinuation + task.agenticContinuationCount for the cap in
        // agentic-draft-common.js's resolveAgenticDraft on the next pass.
      } else if (retryableDraftBlock && task.rescopedFromDecompose === true && typeof task.rescopedRawText === 'string' && task.rescopedRawText.trim()) {
        // resolveAgenticDraft decided this task's real scope is exactly one sub-task the
        // model proposed. Make that the task now, and tell the next pass to implement it
        // (not decompose again).
        task.promptContext = task.promptContext || {};
        task.promptContext.rawText = task.rescopedRawText;
        priorFeedback.push(`A prior pass decided this task's real scope is exactly: ${task.rescopedRawText}\nThat is the task now. Implement THAT with edit_file/write_file in this pass. Do not decompose again.`);
        delete task.rescopedRawText; // keep rescopedFromDecompose set for the escalation cap in resolveAgenticDraft
      } else if (retryableDraftBlock && task.turnBudgetExhausted === true) {
        priorFeedback.push('A prior attempt spent its whole turn budget exploring and made ZERO edits. Do not re-explore from scratch: the PLAN and PRIOR INVESTIGATION are already in your prompt -- use them, get to a concrete edit_file within the first few turns, and answer RESOLUTION: decompose if the task is genuinely too large to finish in one pass.');
      } else if (retryableDraftBlock && typeof task.adhocDiffSubstanceFeedback === 'string' && task.adhocDiffSubstanceFeedback.trim()) {
        // resolveAgenticDraft (agentic-draft-common.js) found the produced diff was a token
        // gesture -- an ADR/doc instead of the code, an unrequested delete, or a file the
        // task explicitly forbids. The feedback names the real target(s).
        priorFeedback.push(task.adhocDiffSubstanceFeedback);
        delete task.adhocDiffSubstanceFeedback;
      } else if (retryableDraftBlock) {
        priorFeedback.push('A prior attempt chose RESOLUTION: decompose but the sub-task JSON was malformed. If this task is doable in one pass, just implement it. If it genuinely needs splitting, end with EXACTLY "RESOLUTION: decompose" then, on the next lines, a single valid JSON array of 2+ objects each shaped {"title": "...", "rawText": "..."} and nothing else.');
      } else {
        priorFeedback.push(String(task.blockedReason || ''));
      }
      delete task.turnBudgetExhausted;
      delete task.retryableDraftBlock;
      task.priorRejectionFeedback = priorFeedback;
      // A continuation is forward progress, not a spent redraft -- don't burn a slot of the
      // blind-redraft budget on it (its own MAX_AGENTIC_CONTINUATIONS cap bounds it).
      if (!isContinuation) task.localRejectCount = retryCount + 1;

      recordModelOutcome({ callId: task.abCallId, outcome: 'requeued', outcomeStage: 'watchdog', outcomeReason: task.blockedReason || null });
      appendHistoryEvent(task, 'requeued', task.blockedReason || undefined);

      // nextAdhocTask() only scans queue/adhoc/ -- an adhoc task requeued to pending/ is
      // only picked up by a general worker, never re-drafted through draftAdhocBranch's
      // tiers. Match python/dashboard/app.py's own adhoc-requeue destination.
      const destDir = (isAdhocTask(task) && adhocDir) ? adhocDir : pendingDir;
      const newPath = path.join(destDir, name);
      fs.mkdirSync(destDir, { recursive: true });
      fs.writeFileSync(newPath, JSON.stringify(task, null, 2));
      fs.unlinkSync(filePath);
      summary.requeued++;
    } catch (e) {
      console.warn('[reject-retry-check] requeue failed for', filePath, e.message, e.code);
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
  const adhocDir = path.join(queueDir, 'adhoc');
  const needsClarificationDir = path.join(queueDir, 'needs-clarification');

  const summary = rejectRetryCheck({ blockedDir, pendingDir, adhocDir, needsClarificationDir, deepDiveCoveragePath });
  process.stdout.write(JSON.stringify(summary));
}

module.exports = { rejectRetryCheck };

if (require.main === module) {
  main();
}
