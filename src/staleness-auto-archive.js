'use strict';

// Custom apply for the staleness_audit source (2026-08-23, Grimmethy: "We need to remove
// the human part of that step" -- after watching real staleness-audit reports pass review
// cleanly, one after another, while the ORIGINAL flagged tasks they were about sat
// completely untouched in blocked/, since filing an advisory report never itself acted on
// anything -- a human had to separately read each report and click archive by hand).
//
// This is a real, deliberate removal of the "human decides and acts" boundary
// staleness_audit was built with (see staleness-audit.js's own header, and
// stalenessAuditImplementPrompt's original "this is advisory only" framing in
// prompts.js) -- scoped as narrowly as the codebase's own existing autonomous-action
// precedent (blocked-drain.js's auto-requeue-on-confirmed-fix) already establishes:
//   1. Only fires from apply(), which only ever runs on a task that has ALREADY cleared
//      review -- a second, independent model vote already endorsed the report as sound,
//      not just the drafting pass's own opinion.
//   2. Only archives when the report's own RECOMMENDATION line explicitly says
//      "archive" -- "worth a fresh investigation" (or anything unparseable) takes NO
//      action at all, same as before. The model is still the one making the call; this
//      only removes the extra human click that used to sit between that call and it
//      taking effect.
//   3. Never deletes anything -- moves the ORIGINAL task to queue/done/_archived_no_action/,
//      the exact same reversible destination the dashboard's own manual archive button
//      already uses (a human can always find it there and requeue it back out).

const fs = require('fs');
const path = require('path');
const { appendHistoryEvent } = require('./task-history.js');
const { checkCommitClaims } = require('./fact-checker.js');

// staleness_audit exists to sweep brain-dump tasks whose concern the human ALREADY
// resolved by hand, outside the pipeline, and never came back to archive. Auto-archiving
// one of those is the whole point. What it must NOT do (confirmed live 2026-08-30, the
// NSFW-images task): archive a task that was flagged `fabrication-repeat` /
// `retries-exhausted` -- i.e. the pipeline TRIED and FAILED to build it -- on the strength
// of a report that guesses it's "already covered" by loosely-related code, with no commit
// that actually did it. "stuck" is not "stale". So auto-archive now requires a real
// resolution signal; without one, the original task is routed to needs-clarification for
// the human to decide, not silently dropped in the outbox.
function hasResolutionSignal(task, reportText) {
  // 1. The deterministic "real commits landed since this task was filed, touching files it
  //    names" check -- staleness-audit.js's findFilesTouchedSince, recorded in reasons.
  const reasons = (task && task.promptContext && task.promptContext.reasons) || [];
  if (reasons.includes('possibly-resolved')) return true;
  // 2. The report cites a commit hash that git confirms is a real object in this repo.
  let repoRoot;
  try { ({ repoRoot } = require('./config.js').getConfig()); } catch { return false; }
  try {
    return checkCommitClaims(reportText || '', repoRoot).some((c) => c.exists === true);
  } catch (err) {
    console.error('[staleness-auto-archive] checkCommitClaims failed:', (reportText || '').slice(0, 80), err.message, err.stack);
    return false;
  }
}

// Same three-part structure stalenessAuditImplementPrompt (prompts.js) asks the model
// for -- looks for a RECOMMENDATION line and reads the words immediately after it, up to
// the next sentence break. Deliberately conservative: only a recommendation that STARTS
// WITH "archive" counts as 'archive' (so a sentence like "not a candidate for archiving"
// can never be misread as one) -- everything else, including genuinely unparseable text,
// resolves to 'investigate' (the safe, no-action default), never guessed toward 'archive'.
function parseStalenessRecommendation(text) {
  const match = (text || '').match(/RECOMMENDATION:\s*\**\s*"?([^\n."]*)/i);
  if (!match) return 'investigate';
  const rec = match[1].trim().toLowerCase();
  return rec.startsWith('archive') ? 'archive' : 'investigate';
}

// Finds and moves the ORIGINAL flagged task (identified by task.promptContext.
// originalTaskId, stamped by buildStalenessAuditTask -- staleness-audit.js) out of
// whichever live queue state it's still sitting in (the same two directories
// nextStalenessAuditTask() itself scans) into done/_archived_no_action/. Stamps a real
// history event on the ORIGINAL task explaining why, quoting the staleness-audit task's
// own id so the full reasoning trail (report -> review verdict -> this action) stays
// traceable from the archived file alone. Returns the original task's id on success, or
// null if it's already gone (already archived by a human, or a race with another
// process) -- non-fatal either way, matching blocked-drain.js's own best-effort style.
function archiveOriginalTask(pipelineDir, originalTaskId, stalenessAuditTaskId, recommendationText) {
  if (!originalTaskId) return null;
  const queueDir = path.join(pipelineDir, 'queue');
  const searchDirs = ['blocked', 'needs-clarification'];

  for (const dirName of searchDirs) {
    const srcPath = path.join(queueDir, dirName, `${originalTaskId}.json`);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(srcPath, 'utf8'));
    } catch (err) {
      if (err && err.code === 'ENOENT') continue; // not here -- try the other dir, or it's genuinely already gone
      console.error('[staleness-auto-archive] candidate-path read failed:', srcPath, err.code, err.message);
      continue;
    }

    data.history = Array.isArray(data.history) ? data.history : [];
    data.history.push({
      stage: 'archived',
      at: new Date().toISOString(),
      detail: `Auto-archived: staleness_audit's own harness-grounded premise-recheck (${stalenessAuditTaskId}) recommended archiving, and that report cleared review -- ${(recommendationText || '').slice(0, 300)}`,
    });
    data.status = 'done';

    const destDir = path.join(queueDir, 'done', '_archived_no_action');
    fs.mkdirSync(destDir, { recursive: true });
    const destPath = path.join(destDir, `${originalTaskId}.json`);
    if (fs.existsSync(destPath)) return null; // already archived -- don't clobber an existing copy

    fs.writeFileSync(destPath, JSON.stringify(data, null, 2));
    fs.unlinkSync(srcPath);
    return originalTaskId;
  }
  return null;
}

// The no-verifiable-signal path: instead of archiving, put the ORIGINAL task in front of a
// human. If it's still in blocked/, move it to needs-clarification/ with a pre-filled
// question; if it's already in needs-clarification/, just leave an advisory note (don't
// re-move, don't clobber an existing needsClarification). Returns the original id on a
// successful hold, null if the task is genuinely gone.
function holdForHumanReview(pipelineDir, originalTaskId, stalenessAuditTaskId, reportText) {
  if (!originalTaskId) return null;
  const queueDir = path.join(pipelineDir, 'queue');
  const excerpt = (reportText || '').slice(0, 500);

  const ncPath = path.join(queueDir, 'needs-clarification', `${originalTaskId}.json`);
  try {
    const data = JSON.parse(fs.readFileSync(ncPath, 'utf8'));
    appendHistoryEvent(data, 'advisory', `staleness_audit ${stalenessAuditTaskId} recommended archive, but with no verifiable resolution signal -- left here for you: ${excerpt.slice(0, 200)}`);
    fs.writeFileSync(ncPath, JSON.stringify(data, null, 2));
    return originalTaskId;
  } catch (err) {
    console.error(`staleness-auto-archive: needs-clarification attempt failed, falling through to blocked/ -- task=${originalTaskId} path=${ncPath} error=${err.message}\n${err.stack}`);
  }

  const blockedPath = path.join(queueDir, 'blocked', `${originalTaskId}.json`);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(blockedPath, 'utf8'));
  } catch {
    return null; // genuinely gone (already archived / requeued by other means)
  }

  appendHistoryEvent(data, 'needs-clarification', `staleness_audit ${stalenessAuditTaskId} recommended archive without verifiable evidence -- escalated for a human decision`);
  if (!data.needsClarification) {
    data.needsClarification = {
      reason: 'design-decision',
      openQuestions: [
        `An automated staleness audit (${stalenessAuditTaskId}) assessed this stuck task as likely already resolved:`,
        '',
        excerpt,
        '',
        'But it produced no verifiable evidence -- no commit that implemented it, and it did not show the current code covers every part of the request. If you already handled this outside the pipeline, use Archive. If it is still open, say what should change.',
      ].join('\n'),
    };
  }
  data.status = 'needs-clarification';

  const destDir = path.join(queueDir, 'needs-clarification');
  fs.mkdirSync(destDir, { recursive: true });
  const destPath = path.join(destDir, `${originalTaskId}.json`);
  if (fs.existsSync(destPath)) return null; // already there -- don't clobber
  fs.writeFileSync(destPath, JSON.stringify(data, null, 2));
  fs.unlinkSync(blockedPath);
  return originalTaskId;
}

// 2026-09-03 (Grimmethy: "deleting an ad hoc task definitely needs to have a human
// gate"): a RECOMMENDATION: archive verdict no longer MOVES anything. It stamps a
// `stalenessFlag` on the original task -- exactly the shape adhoc-staleness-flag.js
// writes -- and leaves it in place. A human retires it from the dashboard (the Archive
// button) or dismisses it (Keep). Confidence is `high` only with a verifiable resolution
// signal (a cited commit that exists, or a possibly-resolved marker); otherwise `medium`.
function stampFlagOnOriginal(pipelineDir, originalTaskId, flag) {
  if (!originalTaskId) return null;
  const queueDir = path.join(pipelineDir, 'queue');
  for (const dirName of ['blocked', 'needs-clarification']) {
    const p = path.join(queueDir, dirName, `${originalTaskId}.json`);
    let data;
    try { data = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
    data.stalenessFlag = {
      reason: flag.reason,
      disposition: 'retire',
      confidence: flag.confidence,
      evidence: flag.evidence,
      flaggedAt: new Date().toISOString(),
      votedAt: null,
      voteResult: null,
    };
    appendHistoryEvent(data, 'advisory',
      `staleness flag: ${flag.reason} (${flag.confidence}) -- from staleness_audit ${flag.auditId}: ${(flag.evidence[0] || '').slice(0, 240)}`);
    fs.writeFileSync(p, JSON.stringify(data, null, 2));
    return originalTaskId;
  }
  return null;
}

/**
 * Registered as staleness_audit's `apply` (task-sources.js). This source never produces a
 * diff, so it always "skips" its own branch/commit step; the real effect is a
 * `stalenessFlag` stamped on the ORIGINAL task when the verdict recommends archiving.
 * NOTHING is moved or deleted automatically -- a human acts on the flag.
 */
function applyStalenessAuditVerdict({ implementResponse, pipelineDir, task }) {
  const text = (implementResponse || '').trim();
  if (!text) return { skipped: true, reason: '(no verdict text returned)' };

  const recommendation = parseStalenessRecommendation(text);
  if (recommendation !== 'archive') {
    return { skipped: true, reason: text.slice(0, 500) };
  }

  const originalTaskId = task && task.promptContext && task.promptContext.originalTaskId;
  const verified = hasResolutionSignal(task, text);
  const flag = {
    reason: 'recheck-verdict-archive',
    confidence: verified ? 'high' : 'medium',
    auditId: task && task.id,
    evidence: [
      `staleness_audit's harness-grounded recheck recommends retiring this task${verified ? ' (verifiable resolution signal present)' : ' (no verifiable commit cited -- a human should confirm)'}`,
      text.slice(0, 400),
    ],
  };

  let stampedId = null;
  try {
    stampedId = stampFlagOnOriginal(pipelineDir, originalTaskId, flag);
  } catch (e) {
    return { skipped: true, reason: `recommended archive; stamping the flag on "${originalTaskId}" failed: ${e.message}` };
  }
  return {
    skipped: true,
    reason: stampedId
      ? `flagged original task "${stampedId}" for human-gated retirement (${flag.confidence}): ${text.slice(0, 240)}`
      : `recommended archive, but original task "${originalTaskId}" was no longer in blocked/needs-clarification`,
  };
}

module.exports = {
  applyStalenessAuditVerdict, parseStalenessRecommendation,
  archiveOriginalTask, holdForHumanReview, hasResolutionSignal, stampFlagOnOriginal,
};
