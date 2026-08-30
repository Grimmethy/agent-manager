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
  } catch { return false; }
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
    } catch {
      continue; // not here -- try the other dir, or it's genuinely already gone
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
  } catch { /* not in needs-clarification/ -- try blocked/ */ }

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

/**
 * Registered as staleness_audit's `apply` (task-sources.js) in place of the generic
 * applyVerdictOnly every other verdict-only source uses -- same {skipped, reason} return
 * shape apply-task.js's writeArtifact() already expects (this source never produces a
 * diff, so it always "skips" its OWN branch/commit step regardless of what happens here),
 * with a real side effect layered on top: an explicit archive recommendation either moves
 * the ORIGINAL flagged task out of the live queue (when there's a verifiable resolution
 * signal) or escalates it to needs-clarification for a human (when there isn't).
 */
function applyStalenessAuditVerdict({ implementResponse, pipelineDir, task }) {
  const text = (implementResponse || '').trim();
  if (!text) return { skipped: true, reason: '(no verdict text returned)' };

  const recommendation = parseStalenessRecommendation(text);
  if (recommendation !== 'archive') {
    return { skipped: true, reason: text.slice(0, 500) };
  }

  const originalTaskId = task && task.promptContext && task.promptContext.originalTaskId;

  if (!hasResolutionSignal(task, text)) {
    let heldId = null;
    try {
      heldId = holdForHumanReview(pipelineDir, originalTaskId, task && task.id, text);
    } catch (e) {
      return { skipped: true, reason: `recommended archive without a verifiable signal; the hold-for-human attempt failed: ${e.message}` };
    }
    return {
      skipped: true,
      reason: heldId
        ? `recommended archive without a verifiable resolution signal (no possibly-resolved flag, no cited commit that exists) -- routed "${heldId}" to needs-clarification for a human instead of archiving`
        : `recommended archive without a verifiable resolution signal, but original task "${originalTaskId}" was no longer in blocked/needs-clarification`,
    };
  }

  let archivedId = null;
  try {
    archivedId = archiveOriginalTask(pipelineDir, originalTaskId, task && task.id, text);
  } catch (e) {
    // Best-effort -- a failed archive attempt must not turn a real, successful review
    // outcome for the staleness_audit task itself into a reported apply failure.
    return { skipped: true, reason: `recommended archive, but the archive attempt failed: ${e.message}` };
  }

  const reason = archivedId
    ? `auto-archived original task "${archivedId}" per staleness_audit's own recommendation: ${text.slice(0, 300)}`
    : `recommended archive, but original task "${originalTaskId}" was no longer in blocked/needs-clarification (already archived, or requeued/resolved by other means)`;
  return { skipped: true, reason };
}

module.exports = { applyStalenessAuditVerdict, parseStalenessRecommendation, archiveOriginalTask, holdForHumanReview, hasResolutionSignal };
