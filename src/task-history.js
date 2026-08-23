'use strict';

// Shared per-task pipeline event log: one appended entry per meaningful checkpoint a task
// passes through (created, claimed, plan/implement/critique done, review verdict, requeue,
// exhausted, applied), each carrying its own timestamp. Every stage-transition writer in
// the pipeline (task-sources.js, local-draft.js, review-task.js, reject-retry-check.js,
// apply-task.js) calls this instead of hand-rolling its own `task.history.push(...)`, so
// the schema stays one shape everywhere rather than drifting per-file.
//
// Added 2026-08-16 in response to a brain-dump entry ("Job status needs time stamps ...
// complete pipeline log for each step") plus a full session spent reconstructing what
// happened to blocked tasks from scattered, sometimes-stale signals -- blockedReason/
// blockedStage left over from an earlier retry cycle with no timestamp attached,
// priorRejectionFeedback recording WHAT a task was rejected for but not WHEN, no record
// at all of individual pass timings (plan vs implement vs critique) or of the apply step
// (apply-task.js never touched task.history, so a task landing in done/ carried no record
// that it was ever applied, when, or to what branch). Before this, task.history only ever
// got two possible entries in its lifetime (`{status:'pending'}` at creation,
// `{status:'needs-review'}` on a successful draft) -- everything else (claim, individual
// pass results, review verdicts, requeues, retry exhaustion, apply outcome) was invisible
// once you were looking at a single task file in isolation.
//
// Entry shape: { stage, at, detail? }
//   stage:  short machine-readable checkpoint name, e.g. 'created', 'claimed', 'plan-done',
//           'implement-done', 'critique-done', 'revision-applied', 'needs-review',
//           'review-voted', 'approved', 'blocked', 'requeued', 'exhausted', 'applied',
//           'apply-failed'.
//   at:     ISO timestamp, always new Date().toISOString() at the moment the stage
//           actually completed (not backfilled/estimated).
//   detail: optional short human-readable string -- a reason, a vote summary, a file
//           count, a latency -- whatever makes this entry legible on its own without
//           having to cross-reference other fields on the task.
function appendHistoryEvent(task, stage, detail) {
  const entry = { stage, at: new Date().toISOString() };
  if (detail !== undefined && detail !== null && detail !== '') entry.detail = String(detail);
  task.history = Array.isArray(task.history) ? task.history : [];
  task.history.push(entry);
  return entry;
}

module.exports = { appendHistoryEvent };
