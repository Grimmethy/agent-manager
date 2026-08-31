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
// Entry shape: { stage, at, detail?, firstAt?, count? }
//   stage:  short machine-readable checkpoint name, e.g. 'created', 'claimed',
//           'draft-started', 'plan-done', 'implement-done', 'critique-done',
//           'revision-applied', 'draft-done', 'needs-review', 'review-voted', 'approved',
//           'blocked', 'requeued', 'exhausted', 'applied', 'apply-failed'.
//   at:     ISO timestamp, always new Date().toISOString() at the moment the stage
//           actually completed (not backfilled/estimated) -- for a collapsed repeat entry
//           (see COLLAPSIBLE_REPEAT_STAGES below), the MOST RECENT occurrence's timestamp.
//   detail: optional short human-readable string -- a reason, a vote summary, a file
//           count, a latency -- whatever makes this entry legible on its own without
//           having to cross-reference other fields on the task.
//   firstAt/count: present only on a collapsed repeat entry -- firstAt is the original
//           first occurrence's timestamp, count is how many times it fired.

// Stages whose CONSECUTIVE repeats carry no new information beyond "this fired again" --
// 2026-08-24, Grimmethy: caught live via a real task carrying 2,756 near-identical
// 'exhausted' entries (244KB of an otherwise 31KB task's 275KB total file size), from a
// since-fixed reject-retry-check.js bug (its own `alreadyStamped` guard now prevents
// re-stamping a task that's already exhausted -- see that file's own comment) that no
// longer happens to NEW tasks, but never got cleaned from files that already had the
// damage baked in, and nothing ever stopped a SIMILAR future bug from doing the same
// thing again. Collapsing a consecutive run into one running entry (bumping `at`/`count`
// in place instead of pushing a new object each time) is defense in depth on top of that
// fix, not a replacement for it -- every existing consumer of this stage (reject-retry-
// check.js's own alreadyStamped check, staleness-audit.js's hasExhaustedRetries) only
// ever asks "does this stage appear at all" via .some(), never counts individual entries,
// so collapsing changes nothing about what they see.
const COLLAPSIBLE_REPEAT_STAGES = new Set(['exhausted']);

function appendHistoryEvent(task, stage, detail) {
  const nowIso = new Date().toISOString();
  task.history = Array.isArray(task.history) ? task.history : [];

  const last = task.history[task.history.length - 1];
  if (last && last.stage === stage && COLLAPSIBLE_REPEAT_STAGES.has(stage)) {
    if (!last.firstAt) last.firstAt = last.at;
    last.at = nowIso;
    last.count = (last.count || 1) + 1;
    if (detail !== undefined && detail !== null && detail !== '') last.detail = String(detail);
    return last;
  }

  const entry = { stage, at: nowIso };
  if (detail !== undefined && detail !== null && detail !== '') entry.detail = String(detail);
  task.history.push(entry);
  return entry;
}

module.exports = { appendHistoryEvent, COLLAPSIBLE_REPEAT_STAGES };
