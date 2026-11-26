'use strict';

// Draft failure handler: routes a failed draft call through classify -> retry/escalate.
//
// Three classes of failure, per the task taxonomy:
//   1. content-rejection  -- model invoked a safeguard / AUP block. The prompt itself is
//                            the problem; retrying it cannot succeed. Route to human review
//                            with a `safeguard-flagged-draft` reason. No infra requeue round.
//   2. transient-infra    -- HTTP 5xx, network error, Claude exit 1. Bounded retry via
//                            the retry policy's attempt limit for this class.
//   3. claude-exit-1      -- the local Claude process exited non-zero. Same treatment as
//                            transient-infra: bounded retry, then escalate.
//
// State writes go through atomic-write's writeJsonAtomicSync so a crash mid-write never
// truncates the task JSON (see atomic-write.js's own header for the incident that motivated it).
// Attempt records are appended (never overwritten) so the full failure history survives
// across retries -- mirrors draft-attempt-record.js's design.
//
// Entry shape expected of `task`:
//   { id, status, draftAttempts: [...], ...other fields }
//   `draftAttempts` is the append-only array; this module only pushes to it.
//
// `deps` is an options bag the caller threads through:
//   { atomicWriter?: { writeJsonAtomicSync(file, data) },
//     retryPolicy?: { attemptsFor(class) },
//     classifyDraftFailure?: (errorText) => string,
//     scheduleRetry?: (task, delayMs) => void,
//     escalateTask?: (task, message) => void,
//     persistTask?: (task) => void }
// All keys are optional; this module supplies sane defaults so it can run standalone.

const path = require('path');

// ---------------------------------------------------------------------------
// Inline fallback classifier -- used when the sibling module is not yet merged.
// Matches the contract: returns one of 'content-rejection' | 'transient-infra' | 'claude-exit-1' | 'other'.
// Pure, no I/O.
// ---------------------------------------------------------------------------
function defaultClassifyDraftFailure(errorText) {
  if (typeof errorText !== 'string' || !errorText) return 'other';
  const text = errorText.toLowerCase();
  // Content rejection: matches the patterns in src/content-policy.js plus Claude's
  // own safeguard phrasing. A policy flag can arrive on any HTTP status, so we match
  // text only, never status codes.
  if (/safeguards flagged this message/i.test(errorText)
      || /anthropic\.com\/legal\/aup/i.test(errorText)
      || /your message violated/i.test(errorText)
      || /acceptable use policy/i.test(errorText)) {
    return 'content-rejection';
  }
  // Claude exit 1: the local process died with a non-zero code.
  if (/claude.*exit\s*1\b/i.test(errorText)
      || /process exited with code 1/i.test(errorText)
      || /exit code 1/i.test(errorText)) {
    return 'claude-exit-1';
  }
  // Transient infra: HTTP 5xx, network errors, timeouts (but NOT 429 -- that's rate-limit,
  // a different class we treat as transient for retry purposes).
  if (/^5\d\d\b/.test(errorText)
      || /network error/i.test(errorText)
      || /etimedout/i.test(errorText)
      || /econnreset/i.test(errorText)
      || /econnrefused/i.test(errorText)
      || /request timeout/i.test(errorText)
      || /502\b/.test(errorText)
      || /503\b/.test(errorText)
      || /504\b/.test(errorText)) {
    return 'transient-infra';
  }
  return 'other';
}

// ---------------------------------------------------------------------------
// Inline fallback retry policy -- used when the sibling module is not yet merged.
// Returns the max attempt count for a failure class.
// ---------------------------------------------------------------------------
function defaultRetryPolicy() {
  return {
    attemptsFor(className) {
      if (className === 'transient-infra') return 3;
      if (className === 'claude-exit-1') return 2;
      return 1;
    },
  };
}

// ---------------------------------------------------------------------------
// Inline fallback scheduleRetry -- arms a one-shot timeout that re-triggers the draft.
// The callback receives (task) so the caller can re-run draftTask.
// ---------------------------------------------------------------------------
function defaultScheduleRetry(task, delayMs, callback) {
  const timer = setTimeout(() => {
    try {
      callback(task);
    } catch (e) {
      // Never let the retry callback crash the event loop.
      process.stderr.write(`[draft-failure-handler] retry callback failed for task ${task.id}: ${e.message}\n`);
    }
  }, Math.max(0, delayMs));
  // Allow the process to exit even if only retry timers are armed.
  if (timer.unref) timer.unref();
  return timer;
}

// ---------------------------------------------------------------------------
// Inline fallback escalateTask -- marks the task for human review with the
// accumulated failure history.
// ---------------------------------------------------------------------------
function defaultEscalateTask(task, message) {
  task.status = 'needs-human-review';
  task.blockedReason = message;
  task.blockedStage = 'draft-failure-escalation';
  // Append the final failure record so the human sees what went wrong.
  if (!task.draftAttempts) task.draftAttempts = [];
  task.draftAttempts.push({
    at: new Date().toISOString(),
    class: 'escalated',
    errorText: message,
    attempt: task.draftAttempts.length + 1,
  });
}

// ---------------------------------------------------------------------------
// Main entry point.
//
// Returns:
//   { nextStep: 'retry', delayMs, timer? }   -- one retry scheduled
//   { nextStep: 'needs-human-review', reason: 'safeguard-flagged-draft' }  -- content rejection
//   { nextStep: 'needs-human-review', reason: 'exhausted-retries', message }  -- retry limit hit
//   { nextStep: 'other', class: '...', handled: false }  -- unclassified failure
// ---------------------------------------------------------------------------
function handleDraftFailure(task, errorText, deps) {
  const classify = (deps && deps.classifyDraftFailure) || defaultClassifyDraftFailure;
  const retryPolicy = (deps && deps.retryPolicy) || defaultRetryPolicy();
  const scheduleRetry = (deps && deps.scheduleRetry) || defaultScheduleRetry;
  const escalate = (deps && deps.escalateTask) || defaultEscalateTask;
  const atomicWriter = (deps && deps.atomicWriter) || { writeJsonAtomicSync: null };

  const classification = classify(errorText);

  // Case 1: content rejection. Never retry -- the prompt itself is the problem.
  // Route to human review with a specific reason so triage can spot the pattern.
  if (classification === 'content-rejection') {
    return {
      nextStep: 'needs-human-review',
      reason: 'safeguard-flagged-draft',
      class: 'content-rejection',
      errorText: errorText,
    };
  }

  // Case 2 & 3: transient-infra or claude-exit-1. Bounded retry.
  if (classification === 'transient-infra' || classification === 'claude-exit-1') {
    const maxAttempts = retryPolicy.attemptsFor(classification);
    const attempts = task.draftAttempts || [];
    // Count how many prior attempts were for the SAME class -- that's what we compare
    // against the limit, not total attempts.
    const priorClassAttempts = attempts.filter((a) => a.class === classification).length;

    // Append the attempt record BEFORE scheduling the retry so the history is
    // durable even if the process crashes between now and the retry firing.
    const attemptRecord = {
      attempt: priorClassAttempts + 1,
      class: classification,
      errorText: errorText,
      at: new Date().toISOString(),
    };
    attempts.push(attemptRecord);
    task.draftAttempts = attempts;

    // Persist the attempt record atomically so a crash doesn't lose it.
    if (atomicWriter && atomicWriter.writeJsonAtomicSync) {
      try {
        const taskPath = task._filePath || task.path || null;
        if (taskPath) {
          atomicWriter.writeJsonAtomicSync(taskPath, task);
        }
      } catch { /* best-effort -- never abort the retry flow for a write failure */ }
    }

    // Check if we've exhausted the limit.
    if (priorClassAttempts + 1 >= maxAttempts) {
      // Last attempt -- escalate with the last underlying error text.
      const lastError = attempts[attempts.length - 1].errorText || errorText;
      const message = `Draft failure escalated after ${maxAttempts} ${classification} attempt(s): ${lastError}`;
      escalate(task, message);
      return {
        nextStep: 'needs-human-review',
        reason: 'exhausted-retries',
        class: classification,
        message: message,
        attempts: attempts,
      };
    }

    // Schedule one retry. Delay doubles with each attempt (exponential backoff),
    // capped at 5 minutes. Base delay: 2 seconds.
    const baseDelayMs = 2000;
    const delayMs = Math.min(baseDelayMs * Math.pow(2, priorClassAttempts), 300000);
    const callback = (t) => {
      // The caller's retry loop should re-invoke handleDraftFailure or draftTask.
      // We export the callback shape so the caller can wire it up.
      if (typeof t === 'object' && t !== null) {
        // Re-classify and potentially retry again.
        handleDraftFailure(t, errorText, deps);
      }
    };
    const timer = scheduleRetry(task, delayMs, callback);

    return {
      nextStep: 'retry',
      class: classification,
      attempt: priorClassAttempts + 1,
      maxAttempts: maxAttempts,
      delayMs: delayMs,
      timer: timer,
      errorText: errorText,
    };
  }

  // Unclassified failure -- return without handling so the caller can decide.
  return {
    nextStep: 'other',
    class: classification,
    handled: false,
    errorText: errorText,
  };
}

module.exports = { handleDraftFailure };
