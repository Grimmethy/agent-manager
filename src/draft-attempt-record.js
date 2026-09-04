'use strict';

// Append-only per-draft-attempt record: one entry on task.draftAttempts for every
// draftTask() run, capturing that run's plan text, each implement tier's outcome +
// response + (summarised) tool activity, and the terminal verdict.
//
// Added 2026-08-31 in response to a brain-dump entry ("local-draft: persist a per-attempt
// record of every draft try ... so a blocked task isn't a black box") plus the
// bra-1788142124203 incident: 19 draft attempts over ~11.5h, and the only durable
// artifacts were the history timeline and the FINAL attempt's planResponse (257 chars,
// itself degenerate). Every earlier plan (char counts swung 93-4637 -- itself the tell
// that the model was flailing), every declined read-only agentic result, every tier-3
// worktree transcript was discarded, because task.planResponse / task.implementResponse
// are overwritten unconditionally on each run and the tiers drop result.response /
// toolCallLog on the floor when they decline. priorRejectionFeedback (reject-retry-
// check.js) is the one existing "one record per attempt, never trimmed" precedent on the
// task JSON -- this mirrors it.
//
// This module never touches disk. draftTask() weaves begin/record/finalize around its
// passes; the record lands on task.draftAttempts, and local-draft.js's existing
// setHistoryPersistHook flush (fired by the 'draft-attempt' history event finalize emits)
// is what actually writes it out -- so even a run that ends in an infra failure, where
// main()'s own terminal writeTaskJson is skipped, still persists its attempt record.
//
// Entry shape (a "full" record):
//   { at, finishedAt, attemptNo, source, localRejectCount,
//     plan:      { chars, text?, degenerate?, attempts? },
//     implement: { chars, text?, degenerate?, attempts?, note? },   // non-adhoc path
//     critique:  { outcome, revised },                              // non-adhoc path
//     tiers:     [ { tier, resolution?, applied?, blocked?, reason?,
//                    responseChars?, response?, rawDiffChars?, rawDiff?,
//                    turnsUsed?, toolCalls? } ],                     // adhoc ladder
//     outcome:   'succeeded' | 'blocked' | 'needs-clarification' | 'error',
//     blockedReason?, reason?, adhocResolution? }
//
// Older records past MAX_FULL_ATTEMPTS are collapsed in place to a slim shape
// ({ at, attemptNo, outcome, blockedReason?, planChars, tiers:[{tier,resolution|applied,
// reason}], collapsed:true }) -- same "keep the signal, drop the bulk" idea as
// task-history.js's COLLAPSIBLE_REPEAT_STAGES. A degenerate 257-char plan is tiny; a
// 20-turn tool transcript is not. Collapse drops plan.text on purpose -- runPlanPass's
// plan-reuse seed reads task.lastGoodPlan (a top-level field it maintains itself,
// never collapsed) as its durable source, not these records.

const PLAN_TEXT_CAP = 6000;
const RESPONSE_TEXT_CAP = 4000;
const DIFF_TEXT_CAP = 8000;
const TOOLCALL_LIST_CAP = 40;
const MAX_FULL_ATTEMPTS = 6;

function cap(text, max) {
  const s = typeof text === 'string' ? text : String(text == null ? '' : text);
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n... [truncated ${s.length - max} more chars]`;
}

// Reduces a runPlanWithTools() toolCallLog ([{ tool, args, result }]) to counts + a
// per-call skeleton -- tool name, which arg KEYS were passed (never their values, which
// hold file paths / edit bodies / shell commands), the byte size of the result, and
// whether the result was an error. Enough to see "spent 8 turns re-reading the same file
// and never edited anything" without carrying kilobytes of file contents.
function summariseToolCalls(toolCallLog) {
  if (!Array.isArray(toolCallLog) || toolCallLog.length === 0) return undefined;
  const byTool = {};
  let errors = 0;
  const calls = [];
  let n = 0;
  for (const entry of toolCallLog) {
    n += 1;
    const tool = (entry && entry.tool) || 'unknown';
    byTool[tool] = (byTool[tool] || 0) + 1;
    const result = entry && entry.result;
    const isError = !!(result && typeof result === 'object' && result.error);
    if (isError) errors += 1;
    if (calls.length < TOOLCALL_LIST_CAP) {
      let bytes = 0;
      try { bytes = JSON.stringify(result == null ? '' : result).length; } catch { bytes = -1; }
      const call = { n, tool, argKeys: entry && entry.args ? Object.keys(entry.args) : [], bytes };
      if (isError) call.error = true;
      calls.push(call);
    }
  }
  return {
    total: toolCallLog.length,
    byTool,
    errors,
    calls,
    ...(toolCallLog.length > TOOLCALL_LIST_CAP ? { listTruncated: true } : {}),
  };
}

// Opens the record for a draftTask() run. attemptNo is 1-based over whatever is already on
// task.draftAttempts, so a reject-retry requeue (which does NOT clear the array) keeps
// counting up across the task's whole life, exactly like priorRejectionFeedback.
function beginDraftAttempt(task) {
  const prior = Array.isArray(task && task.draftAttempts) ? task.draftAttempts : [];
  return {
    at: new Date().toISOString(),
    attemptNo: prior.length + 1,
    source: (task && task.source) || null,
    localRejectCount: (task && task.localRejectCount) || 0,
    tiers: [],
  };
}

// The plan pass produced (or failed to produce) a plan. `info` is one of
// { text, attempts } or { degenerate, attempts }, plus optional flags from runPlanPass's
// substance gate: reRolled (a thin first roll was retried), seededFromPrior (the pass was
// primed with, or fell back to, a plan a prior attempt produced), thin (recorded a
// too-short plan on the no-seed block path).
function recordPlan(attempt, info = {}) {
  if (!attempt) return;
  const plan = {};
  if (info.degenerate) {
    plan.degenerate = String(info.degenerate);
    plan.chars = 0;
  } else {
    const text = info.text || '';
    plan.chars = text.length;
    plan.text = cap(text, PLAN_TEXT_CAP);
  }
  if (info.attempts != null) plan.attempts = info.attempts;
  if (info.reRolled) plan.reRolled = true;
  if (info.seededFromPrior) plan.seededFromPrior = true;
  if (info.thin) plan.thin = true;
  if (info.grounded) {
    plan.grounded = true;
    if (info.groundingChars != null) plan.groundingChars = info.groundingChars;
    if (Array.isArray(info.anchorPaths) && info.anchorPaths.length) plan.anchorPaths = info.anchorPaths.slice(0, 6);
  }
  attempt.plan = plan;
}

// The standard (non-adhoc) implement pass. `info` carries any of { text, attempts,
// degenerate, note } -- `note` (a deterministic short-circuit / a split summary) and
// `text` may coexist.
function recordImplement(attempt, info = {}) {
  if (!attempt) return;
  const impl = { chars: 0 };
  if (info.degenerate) impl.degenerate = String(info.degenerate);
  if (info.note) impl.note = String(info.note);
  if (info.text) {
    impl.chars = String(info.text).length;
    impl.text = cap(info.text, RESPONSE_TEXT_CAP);
  }
  if (info.attempts != null) impl.attempts = info.attempts;
  attempt.implement = impl;
}

// The critique/revision pass (non-adhoc). `info` is { outcome, revised }.
function recordCritique(attempt, info = {}) {
  if (!attempt) return;
  attempt.critique = { outcome: info.outcome || null, revised: !!info.revised };
}

// One rung of the adhoc implement ladder (harness-search / local-agentic /
// local-agentic-write / a deterministic short-circuit / agentic-research). `info`:
//   { tier, applied?, resolution?, blocked?, reason?, blockedReason?,
//     response?, rawDiff?, turnsUsed?, toolCallLog? }
function recordTier(attempt, info = {}) {
  if (!attempt) return;
  const rec = { tier: info.tier || 'unknown' };
  if (info.resolution != null) rec.resolution = info.resolution;
  if (info.applied != null) rec.applied = !!info.applied;
  if (info.blocked != null) rec.blocked = !!info.blocked;
  const reason = info.reason || info.blockedReason;
  if (reason) rec.reason = String(reason);
  if (info.response != null && info.response !== '') {
    const text = String(info.response);
    rec.responseChars = text.length;
    rec.response = cap(text, RESPONSE_TEXT_CAP);
  }
  if (info.rawDiff != null && info.rawDiff !== '') {
    const diff = String(info.rawDiff);
    rec.rawDiffChars = diff.length;
    rec.rawDiff = cap(diff, DIFF_TEXT_CAP);
  }
  if (info.turnsUsed != null) rec.turnsUsed = info.turnsUsed;
  const tools = summariseToolCalls(info.toolCallLog);
  if (tools) rec.toolCalls = tools;
  attempt.tiers.push(rec);
}

function slimTier(t) {
  const s = { tier: t.tier };
  if (t.resolution != null) s.resolution = t.resolution;
  if (t.applied != null) s.applied = t.applied;
  if (t.reason) s.reason = t.reason;
  return s;
}

// Replaces every record older than the newest MAX_FULL_ATTEMPTS with a slim summary,
// in place (preserving order and attemptNo). Idempotent -- an already-slim record is
// left as-is.
function collapseOldAttempts(attempts) {
  if (!Array.isArray(attempts) || attempts.length <= MAX_FULL_ATTEMPTS) return;
  const cutoff = attempts.length - MAX_FULL_ATTEMPTS;
  for (let i = 0; i < cutoff; i++) {
    const a = attempts[i];
    if (!a || a.collapsed) continue;
    attempts[i] = {
      at: a.at,
      attemptNo: a.attemptNo,
      outcome: a.outcome || null,
      ...(a.blockedReason ? { blockedReason: a.blockedReason } : {}),
      planChars: a.plan ? (a.plan.chars || 0) : 0,
      ...(a.plan && a.plan.degenerate ? { planDegenerate: a.plan.degenerate } : {}),
      ...(a.plan && a.plan.grounded ? { planGrounded: true } : {}),
      tiers: Array.isArray(a.tiers) ? a.tiers.map(slimTier) : [],
      collapsed: true,
    };
  }
}

// Stamps the terminal verdict and appends the record to task.draftAttempts. `result` is
// draftTask()'s own return value ({ succeeded, blocked?, blockedReason?,
// needsClarification?, reason? }). If `emitHistory` is supplied it is called
// (task, 'draft-attempt', detail) so the caller's persist hook flushes the record to
// disk immediately -- important for the succeeded:false path, where main() skips its
// own terminal write.
function finalizeDraftAttempt(task, attempt, result, { emitHistory } = {}) {
  if (!attempt) return;
  const r = result || {};
  attempt.outcome = r.succeeded === false ? 'error'
    : r.needsClarification ? 'needs-clarification'
      : r.blocked ? 'blocked'
        : 'succeeded';
  if (r.blockedReason) attempt.blockedReason = String(r.blockedReason);
  if (r.reason) attempt.reason = String(r.reason);
  if (task && task.adhocResolution) attempt.adhocResolution = task.adhocResolution;
  attempt.finishedAt = new Date().toISOString();

  if (!task) return;
  task.draftAttempts = Array.isArray(task.draftAttempts) ? task.draftAttempts : [];
  task.draftAttempts.push(attempt);
  collapseOldAttempts(task.draftAttempts);

  if (typeof emitHistory === 'function') {
    const tierLabel = (t) => t.resolution
      || (t.applied === true ? 'applied' : t.blocked ? 'blocked' : 'declined');
    const tierPart = attempt.tiers.length
      ? `, tiers: ${attempt.tiers.map((t) => `${t.tier}=${tierLabel(t)}`).join(' -> ')}`
      : '';
    try {
      emitHistory(task, 'draft-attempt', `attempt ${attempt.attemptNo}: ${attempt.outcome}${tierPart}`);
    } catch { /* best-effort: a flush failure must never abort the pass */ }
  }
}

module.exports = {
  beginDraftAttempt,
  recordPlan,
  recordImplement,
  recordCritique,
  recordTier,
  finalizeDraftAttempt,
  collapseOldAttempts,
  summariseToolCalls,
  PLAN_TEXT_CAP,
  RESPONSE_TEXT_CAP,
  DIFF_TEXT_CAP,
  MAX_FULL_ATTEMPTS,
};
