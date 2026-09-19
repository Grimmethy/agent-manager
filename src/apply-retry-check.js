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
const { fileGhostDebt } = require('./ghost-debt.js');
const { decideFindingResolved } = require('./premise-recheck-decision.js');
const { alreadyEscalatedSinceLastReadmission } = require('./reject-retry-check.js');

const MAX_APPLY_RETRIES = 2;

function isApplyFailure(task) {
  return task.blockedStage === 'apply';
}

// 2026-09-17 (decompose_design_question AC-60/AC-61, "apply-failed on diverged master,
// yet the pipeline auto-requeued and re-drafted the *same* fix 3-4 times before a human
// fixed the branch"): git-runner.js's resetToMain()/prepareStackedBranch() both throw
// this exact shape when local <mainBranch> and origin/<mainBranch> have each moved ahead
// independently -- a git-STATE problem (something outside this task changed the branch
// history), never a content/draft-quality one. The blind requeue-and-redraft loop below
// treats every apply failure identically, so it burns MAX_APPLY_RETRIES full draft->
// review cycles reproducing the IDENTICAL diverged-history failure every time (a fresh
// diff drafted against the same still-diverged branch can never apply either) before
// finally giving up -- pure waste, and worse, it silently eats the actual signal (a
// human needs to reconcile the branch) inside two generic "requeued"/"exhausted" events
// instead of surfacing it. Checked BEFORE the retry-count logic, same "a non-retryable
// classification means retrying would reproduce the exact same failure" discipline
// reject-retry-check.js's own classifyBlockedTask short-circuit already uses.
const GIT_DIVERGED_RE = /have diverged \(each has commit\(s\) the other lacks\) -- needs a human to reconcile/i;
function isDivergedHistoryFailure(task) {
  return isApplyFailure(task) && GIT_DIVERGED_RE.test(String(task.blockedReason || ''));
}

// 2026-09-18 (observability-fix-ac-169): apply-group-b.js's own "find string not found in
// <file>" -- the edit's find string no longer matches the file. For a scanner-derived
// candidate that very often means the flagged code was since FIXED by unrelated work, and
// every redraft just re-anchors on the same stale candidate. See decideFindingResolved.
const FIND_NOT_FOUND_RE = /find string not found in /i;
function isFindStringMiss(task) {
  return isApplyFailure(task) && FIND_NOT_FOUND_RE.test(String(task.blockedReason || ''));
}

function buildExhaustedApplyQuestion(task) {
  return [
    `An apply failure survived ${MAX_APPLY_RETRIES} automatic redraft attempts: ${String(task.blockedReason || '(no reason recorded)')}`,
    '',
    isFindStringMiss(task)
      ? 'The draft\'s edit could not be matched against the real file. Common cause: the '
        + 'candidate\'s citation is stale -- something else may have already changed or fixed '
        + 'that code, and a deterministic re-scan could not confirm it either way. Check the '
        + 'real file: if the issue is already fixed, Archive this task; if the citation is '
        + 'merely stale, correct it and requeue.'
      : 'A fresh draft against current code kept failing to apply. Check whether another task '
        + 'changed the same lines, and either requeue after reconciling or Archive it.',
  ].join('\n');
}

// Lands a task whose site is verifiably resolved exactly the way review-task.js lands a
// confirmed FALSE POSITIVE refusal (decidePremiseRecheckOutcome): the stale edit is replaced
// by the documented "FALSE POSITIVE -- <why>" line (leaving it would just fail to apply
// again) and the task moves to approved/, where apply records it as a normal dismissal.
function landAsResolvedFalsePositive(task, name, filePath, approvedDir) {
  const why = 'the candidate\'s own code site no longer matches, and the source\'s deterministic scanner rules find nothing flagged at it in the current file';
  task.implementResponse = `FALSE POSITIVE -- ${why}`;
  task.reviewedAt = new Date().toISOString();
  task.reviewProvider = 'deterministic-apply-site-resolved';
  task.localVerdict = `Auto-approved: apply failed with "${String(task.blockedReason || '').slice(0, 120)}", and a deterministic re-scan (${why}) confirms the finding is already resolved -- verified, not a judgment call (no model call spent).`;
  delete task.blockedReason;
  delete task.blockedStage;
  appendHistoryEvent(task, 'approved', 'apply-retry-check: deterministic-apply-site-resolved -- find string not found, but the candidate site is clean in the current file');
  fs.mkdirSync(approvedDir, { recursive: true });
  fs.writeFileSync(path.join(approvedDir, name), JSON.stringify(task, null, 2));
  fs.unlinkSync(filePath);
}

function applyRetryCheck({ blockedDir, pendingDir, needsClarificationDir, approvedDir, pipelineDir, repoRoot, extraRoots, decideResolved = decideFindingResolved, recordModelOutcome = defaultRecordModelOutcome }) {
  const summary = { checked: 0, requeued: 0, exhausted: 0, resolved: 0, errors: 0, errorDetails: [] };
  const approvedDirResolved = approvedDir || (pipelineDir ? path.join(pipelineDir, 'queue', 'approved') : null);
  let names = [];
  try {
    names = fs.readdirSync(blockedDir).filter((f) => f.endsWith('.json'));
  } catch (e) {
    return summary; // blocked/ doesn't exist yet -- nothing to check.
  }

  for (const name of names) {
    const filePath = path.join(blockedDir, name);
    // Tracks the operation actually in flight when the catch below fires, so
    // errorDetails' step reflects reality instead of always reading "write" for a
    // failure that happened during read/parse/record -- see this variable's own
    // reassignments just ahead of each real operation it names.
    let step = 'read';
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      if (!raw) continue;
      step = 'parse';
      const task = JSON.parse(raw);
      summary.checked++;

      // Only a genuine apply-stage failure is eligible -- never a review rejection that
      // happens to still carry stale fields, same "only act on the specific stage this
      // check owns" reasoning reject-retry-check.js's own isReviewRejection() guard uses.
      if (!isApplyFailure(task)) continue;

      // Diverged-history short-circuit -- see isDivergedHistoryFailure's own header.
      // Regardless of retryCount: retrying reproduces the identical git-state failure,
      // structurally, not stochastically, so there is no reason to wait for the cap.
      if (isDivergedHistoryFailure(task) && needsClarificationDir) {
        const alreadyEscalated = Array.isArray(task.history) && task.history.some((h) => h.stage === 'needs-clarification');
        if (!alreadyEscalated) {
          task.needsClarification = {
            reason: 'git-state-diverged',
            openQuestions: [
              `Apply failed because the pipeline's own working checkout and origin/<main> have diverged (each has commits the other lacks) -- a git-state problem, not a content/draft-quality one: ${String(task.blockedReason || '')}`,
              'A fresh redraft cannot fix this -- the SAME diverged branch will reject any diff. Reconcile the branch by hand (confirm which side'
                + ' has the real intended history, then either fast-forward, rebase, or reset the working checkout to match), then requeue this task.',
            ],
          };
          step = 'record';
          appendHistoryEvent(task, 'needs-clarification', 'escalated immediately -- diverged git history, a blind retry cannot differ');
          if (pipelineDir) fileGhostDebt({ task, reasonText: task.blockedReason, site: 'apply-retry-check:diverged-history', pipelineDir });
          step = 'write';
          fs.mkdirSync(needsClarificationDir, { recursive: true });
          fs.writeFileSync(path.join(needsClarificationDir, name), JSON.stringify(task, null, 2));
          step = 'unlink';
          fs.unlinkSync(filePath);
          summary.exhausted++;
          continue;
        }
      }

      // Checked before the retry-count logic, regardless of retryCount: a resolved finding
      // needs no further redraft, and a task ALREADY at the cap (the AC-169 state) is
      // exactly the one that would otherwise never be looked at again.
      if (isFindStringMiss(task) && approvedDirResolved) {
        step = 'resolve';
        const resolved = decideResolved(task, { repoRoot, extraRoots });
        if (resolved) {
          landAsResolvedFalsePositive(task, name, filePath, approvedDirResolved);
          summary.resolved++;
          continue;
        }
      }

      const retryCount = Number(task.applyRetryCount) || 0;
      if (retryCount >= MAX_APPLY_RETRIES) {
        const alreadyStamped = Array.isArray(task.history) && task.history.some((h) => h.stage === 'exhausted');
        // Exhaustion used to be a permanent dead end -- stamp 'exhausted' and stay in
        // blocked/ forever, nothing ever reading it back out (reject-retry-check.js closed
        // the same gap for review rejections 2026-09-17/18). Escalate to a human instead.
        // Deliberately NOT gated on alreadyStamped: tasks stamped on an earlier tick (before
        // this existed) are exactly the ones stuck right now.
        if (needsClarificationDir && !alreadyEscalatedSinceLastReadmission(task)) {
          step = 'record';
          task.needsClarification = { reason: 'design-decision', openQuestions: buildExhaustedApplyQuestion(task) };
          if (!alreadyStamped) appendHistoryEvent(task, 'exhausted', `${retryCount}/${MAX_APPLY_RETRIES} apply retries used`);
          appendHistoryEvent(task, 'needs-clarification', 'escalated to a human after exhausting apply retries');
          if (pipelineDir) fileGhostDebt({ task, reasonText: task.blockedReason, site: 'apply-retry-check:retry-cap-exhausted', pipelineDir });
          step = 'write';
          fs.mkdirSync(needsClarificationDir, { recursive: true });
          fs.writeFileSync(path.join(needsClarificationDir, name), JSON.stringify(task, null, 2));
          step = 'unlink';
          fs.unlinkSync(filePath);
          summary.exhausted++;
          continue;
        }
        // Same "stamp once, never re-fire" guard reject-retry-check.js uses -- without
        // it this branch would re-append an 'exhausted' history event on every single
        // watchdog tick for as long as the task sits here, unbounded.
        if (alreadyStamped) { summary.exhausted++; continue; }
        step = 'record';
        appendHistoryEvent(task, 'exhausted', `${retryCount}/${MAX_APPLY_RETRIES} apply retries used`);
        step = 'write';
        fs.writeFileSync(filePath, JSON.stringify(task, null, 2));
        summary.exhausted++;
        continue;
      }

      task.applyRetryCount = retryCount + 1;

      step = 'record';
      recordModelOutcome({ callId: task.abCallId, outcome: 'requeued', outcomeStage: 'apply-watchdog', outcomeReason: task.blockedReason || null });
      appendHistoryEvent(task, 'requeued', task.blockedReason || undefined);

      step = 'write';
      const newPath = path.join(pendingDir, name);
      fs.mkdirSync(pendingDir, { recursive: true });
      fs.writeFileSync(newPath, JSON.stringify(task, null, 2));
      step = 'unlink';
      fs.unlinkSync(filePath);
      summary.requeued++;
    } catch (e) {
      summary.errors++;
      const detail = { task: name, step, message: e.message, code: e.code ?? null };
      summary.errorDetails.push(detail);
      console.error(JSON.stringify(detail));
    }
  }

  return summary;
}

function main() {
  // Populate the source + deterministic-recheck registries (built-ins AND
  // AGENT_MANAGER_REGISTER_PATH plugins). This runs as its own one-shot `node` process from
  // queue-watcher.sh's watchdog with an EMPTY registry otherwise -- decideFindingResolved
  // would silently return false for every source and the whole resolve path would be inert
  // in production despite passing its unit tests (same gap reject-retry-check.js documents).
  require('./task-sources.js');
  try { require('./config.js').ensureRegistered(); } catch { /* best-effort */ }
  const { pipelineDir, repoRoot, grepAllowedDirs } = getConfig();
  const queueDir = path.join(pipelineDir, 'queue');
  const blockedDir = path.join(queueDir, 'blocked');
  const pendingDir = path.join(queueDir, 'pending');
  const needsClarificationDir = path.join(queueDir, 'needs-clarification');

  const summary = applyRetryCheck({ blockedDir, pendingDir, needsClarificationDir, pipelineDir, repoRoot, extraRoots: grepAllowedDirs });
  process.stdout.write(JSON.stringify(summary));
}

module.exports = { applyRetryCheck, isDivergedHistoryFailure };

if (require.main === module) {
  main();
}
