'use strict';

// Re-review: send a review-stage-blocked task BACK TO REVIEW with its draft intact.
//
// Every other requeue path (requeue_blocked_task, the dashboard's Requeue button, reject-retry-check)
// deletes planResponse/implementResponse first, so the only way to retry a blocked task is a full
// REDRAFT -- the expensive part of the pipeline (a multi-minute local-model pass). That is right when
// the draft was bad. It is pure waste when the DRAFT WAS FINE and the review side was wrong: a
// deterministic gate that contradicted the prompt (function_length_review's missing-code-diff rejected
// the prompt-mandated prose FALSE POSITIVE verdict, 2026-09-19: 3 drafts, then escalated to a human),
// a since-fixed review bug, etc. Those need a second look at the SAME draft, not a new one.
//
// Precedent: needs-clarification-triage.js bucket K already did a one-off "repair and re-review" move
// for decompose-review-blind drafts; this is the general primitive.
//
// Deliberately NOT done here: localRejectCount (the redraft budget) is left as-is. If the second review
// blocks again the task escalates straight back to a human instead of quietly buying fresh redrafts.
//
// CLI: node rereview-task.js <taskId> [--state needs-clarification|blocked] [--reason "why"]
// Prints one line of JSON: { ok, id, from, to, ... } or { ok:false, error }.

const fs = require('fs');
const path = require('path');
const { appendHistoryEvent } = require('./task-history.js');
const { classifyRequeue } = require('./requeue-attribution.js');

const REREVIEWABLE_STATES = ['needs-clarification', 'blocked'];

// Fields that describe the FAILED review / the escalation. The draft itself (planResponse,
// implementResponse, rawDiff, acceptance results, draftAttempts, ...) is kept.
const STALE_REVIEW_FIELDS = [
  'blockedReason', 'blockedStage', 'needsClarification', 'ncTriageDecision', 'ncTriageReviewedAt',
  'ncTriageAttempts', 'ncTriageBucketAttempts', 'stalenessFlag', 'claimedAt',
];

function hasDraft(task) {
  return !!task && typeof task.implementResponse === 'string' && task.implementResponse.trim().length > 0;
}

// True when a task in a blocked/needs-clarification state could be re-reviewed. Shared with the dashboard's
// task-list summary so the Re-review button appears exactly when the primitive would accept the task.
function isRereviewable(task) {
  return !!task && task.blockedStage === 'review' && hasDraft(task);
}

async function rereviewTask({ pipelineDir, taskId, state, reason, repoRoot, actor = 'operator-manual' }) {
  if (!pipelineDir || !taskId) return { ok: false, error: 'rereviewTask requires pipelineDir and taskId' };
  const states = state ? [state] : REREVIEWABLE_STATES;
  if (state && !REREVIEWABLE_STATES.includes(state)) {
    return { ok: false, error: `only a task in ${REREVIEWABLE_STATES.join(' or ')} can be re-reviewed (got '${state}')` };
  }
  let from = null;
  let src = null;
  for (const s of states) {
    const candidate = path.join(pipelineDir, 'queue', s, `${taskId}.json`);
    if (fs.existsSync(candidate)) { from = s; src = candidate; break; }
  }
  if (!src) return { ok: false, error: `task '${taskId}' not found in ${states.join(' or ')}` };

  let task;
  try {
    task = JSON.parse(fs.readFileSync(src, 'utf8'));
  } catch (e) {
    return { ok: false, error: `could not read ${src}: ${e.message}` };
  }
  if (task.blockedStage !== 'review') {
    return { ok: false, error: `'${taskId}' was not blocked at the review stage (blockedStage=${task.blockedStage || 'none'}) -- use Requeue for a fresh draft` };
  }
  if (!hasDraft(task)) {
    return { ok: false, error: `'${taskId}' has no draft to re-review (implementResponse is empty) -- use Requeue for a fresh draft` };
  }

  const reviewDir = path.join(pipelineDir, 'queue', 'review');
  const dest = path.join(reviewDir, `${taskId}.json`);
  if (fs.existsSync(dest)) return { ok: false, error: `'${taskId}' already exists in queue/review/` };

  const why = (reason || 'review-side fix').trim();
  const priorReason = task.blockedReason;
  for (const f of STALE_REVIEW_FIELDS) delete task[f];
  task.status = 'needs-review';
  appendHistoryEvent(task, 'requeued', `re-review: ${why} -- draft kept, sent back to queue/review/ (no redraft)`);
  try {
    await classifyRequeue(task, { reasonHint: `re-review: ${why}${priorReason ? ` (was: ${String(priorReason).slice(0, 160)})` : ''}`, blockedStage: 'review', requeueWriter: 'rereview-task', actor, repoRoot, skipFallbackModel: true });
  } catch { /* attribution must never block a real requeue */ }

  fs.mkdirSync(reviewDir, { recursive: true });
  const tmp = `${dest}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(task, null, 2));
  fs.renameSync(tmp, dest);
  fs.unlinkSync(src);
  return { ok: true, id: taskId, from, to: 'review', path: dest };
}

function parseArgs(argv) {
  const out = { taskId: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--state') out.state = argv[++i];
    else if (argv[i] === '--reason') out.reason = argv[++i];
    else if (!out.taskId) out.taskId = argv[i];
  }
  return out;
}

async function main() {
  const { taskId, state, reason } = parseArgs(process.argv.slice(2));
  if (!taskId) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: 'Usage: node rereview-task.js <taskId> [--state s] [--reason why]' })}\n`);
    process.exit(1);
  }
  const { getConfig } = require('./config.js');
  const { pipelineDir, repoRoot } = getConfig();
  const result = await rereviewTask({ pipelineDir, taskId, state, reason, repoRoot });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exit(2);
}

module.exports = { rereviewTask, isRereviewable, REREVIEWABLE_STATES, STALE_REVIEW_FIELDS };

if (require.main === module) {
  main();
}
